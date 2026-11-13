#!/usr/bin/env node
/**
 * 发布包 worker 协议测试台
 * 用法：node test-publish-worker.mjs
 *
 * fork qoder-channel-publish/dist/worker.mjs，模拟 qoder.communication 宿主：
 *   - Node IPC：ready 握手、qoder/channel/manage / start
 *   - MCP stdio：initialize / tools/list / tools/call
 * manage 返回值按宿主硬 schema（server.cjs:12831-12895）逐条校验。
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'qoder-channel-publish', 'dist', 'worker.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));

const child = fork(worker, [], {
  env: { ...process.env, QODER_CHANNEL_KIND: 'campfire', QODER_CHANNEL_DATA: dataDir },
  stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
});

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}`, extra === undefined ? '' : JSON.stringify(extra)?.slice(0, 300)); }
}

// ── 宿主 schema 规则（server.cjs:12831-12895 的等价校验）──
const BOT_ID = /^[a-f0-9]{24}$/;
const STATES = ['offline', 'connecting', 'connected'];
function validateResult(r) {
  if (!r || typeof r !== 'object') return 'result not object';
  const s = r.snapshot;
  if (!s) return 'missing snapshot';
  if (!Number.isInteger(s.revision) || s.revision < 0) return 'bad revision';
  if (!Array.isArray(s.bots) || s.bots.length > 100) return 'bad bots';
  for (const b of s.bots) {
    if (!BOT_ID.test(b.id || '')) return `bad botId ${b.id}`;
    if (typeof b.remoteId !== 'string' || !b.remoteId.trim() || b.remoteId.length > 256) return 'bad remoteId';
    if (typeof b.enabled !== 'boolean') return 'bad enabled';
    if (!STATES.includes(b.state)) return `bad state ${b.state}`;
    if (b.displayName !== undefined && (typeof b.displayName !== 'string' || b.displayName.length > 40)) return 'bad displayName';
  }
  if (s.provisioning !== null) {
    const p = s.provisioning;
    if (!p || typeof p !== 'object') return 'bad provisioning';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id || '')) return 'bad provisioning id';
    if (!['waiting', 'completed', 'failed', 'cancelled', 'expired'].includes(p.status)) return 'bad provisioning status';
    if (!Number.isFinite(p.expiresAt)) return 'bad expiresAt';
    if (p.status === 'completed' && !p.botId) return 'completed without botId';
  }
  if (!Array.isArray(s.pending)) return 'bad pending';
  if (s.accessControl === false) {
    if (s.pending.length) return 'accessControl:false with pending';
    if (s.bots.some((b) => b.access !== undefined)) return 'accessControl:false with bot.access';
  } else if (s.bots.some((b) => b.access === undefined)) return 'accessControl requires bot.access';
  return null;
}

// ── IPC ──
let callSeq = 0;
const pendingCalls = new Map();
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
child.on('message', (frame) => {
  if (frame?.type === 'ready') { readyResolve(frame); return; }
  if (frame?.type === 'result') {
    const p = pendingCalls.get(frame.id);
    if (p) { pendingCalls.delete(frame.id); frame.error ? p.reject(new Error(frame.error)) : p.resolve(frame.result); }
  }
});
function call(method, params) {
  const id = `test-${++callSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingCalls.delete(id); reject(new Error(`timeout: ${method}`)); }, 8000);
    pendingCalls.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.send({ type: 'call', id, method, params });
  });
}

// ── MCP stdio ──
let mcpBuf = '';
let mcpSeq = 0;
const mcpPending = new Map();
child.stdout.on('data', (chunk) => {
  mcpBuf += chunk.toString();
  let i;
  while ((i = mcpBuf.indexOf('\n')) !== -1) {
    const line = mcpBuf.slice(0, i); mcpBuf = mcpBuf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { failures++; console.error('FAIL non-JSON stdout line:', line.slice(0, 100)); continue; }
    const p = mcpPending.get(msg.id);
    if (p) { mcpPending.delete(msg.id); p(msg); }
  }
});
child.stderr.on('data', () => {});
function mcp(method, params) {
  const id = ++mcpSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mcpPending.delete(id); reject(new Error(`mcp timeout: ${method}`)); }, 8000);
    mcpPending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const readyFrame = await Promise.race([ready, sleep(15000).then(() => null)]);
  check('ready {type:"ready",version:1} within 15s', readyFrame?.type === 'ready' && readyFrame?.version === 1, readyFrame);

  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-host', version: '0' } });
  check('MCP initialize', init?.result?.serverInfo?.name === 'campfire', init);
  const tools = await mcp('tools/list', {});
  const names = (tools?.result?.tools || []).map((t) => t.name);
  check('tools/list 含 campfire_send_message（sessionTools.autoApprove 要求）', names.includes('campfire_send_message'), names);
  check('tools/list 含 configure/status', names.includes('campfire_configure') && names.includes('campfire_status'), names);

  let r = await call('qoder/channel/manage', { action: 'status' });
  check('status（未配置）schema 合法', validateResult(r) === null, validateResult(r) || r);
  check('未配置时 bots 为空', r.snapshot.bots.length === 0);

  r = await call('qoder/channel/manage', { action: 'login' });
  check('login（未配置）schema 合法', validateResult(r) === null, validateResult(r));
  check('未配置 login → provisioning failed', r.snapshot.provisioning?.status === 'failed');

  const cfgRes = await mcp('tools/call', { name: 'campfire_configure', arguments: { baseUrl: 'http://127.0.0.1:9', token: 'cf_test', member: 'qoder' } });
  check('campfire_configure 成功', !cfgRes?.result?.isError, cfgRes?.result);

  r = await call('qoder/channel/manage', { action: 'status' });
  const err = validateResult(r);
  check('status（已配置）schema 合法', err === null, err || r);
  check('一个 bot，botId 为 24 位 hex', r.snapshot.bots.length === 1 && BOT_ID.test(r.snapshot.bots[0].id));
  check('bot enabled + remoteId=qoder', r.snapshot.bots[0].enabled === true && r.snapshot.bots[0].remoteId === 'qoder');

  r = await call('qoder/channel/manage', { action: 'login' });
  check('login（已配置）→ completed + botId', validateResult(r) === null && r.snapshot.provisioning?.status === 'completed' && !!r.snapshot.provisioning?.botId, r);

  const bid = r.snapshot.bots[0]?.id || 'a'.repeat(24);
  r = await call('qoder/channel/manage', { action: 'disable', botId: bid });
  check('disable → enabled:false + offline', validateResult(r) === null && r.snapshot.bots[0].enabled === false && r.snapshot.bots[0].state === 'offline', r);
  r = await call('qoder/channel/manage', { action: 'enable', botId: bid });
  check('enable → enabled:true', validateResult(r) === null && r.snapshot.bots[0].enabled === true);
  r = await call('qoder/channel/manage', { action: 'rename', botId: bid, displayName: '测试围炉' });
  check('rename → displayName 生效', validateResult(r) === null && r.snapshot.bots[0].displayName === '测试围炉');
  r = await call('qoder/channel/manage', { action: 'reconnect', botId: bid });
  check('reconnect schema 合法', validateResult(r) === null);
  const scope = { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } };
  r = await call('qoder/channel/manage', { action: 'access', botId: bid, expectedRevision: 0, access: { direct: scope, group: scope } });
  check('access no-op schema 合法', validateResult(r) === null);
  r = await call('qoder/channel/manage', { action: 'remove', botId: bid });
  check('remove → bots 清空', validateResult(r) === null && r.snapshot.bots.length === 0);

  r = await call('qoder/channel/start', {});
  check('qoder/channel/start 受理', r && r.ok === true, r);

  console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
} catch (e) {
  console.error('HARNESS ERROR', e);
  failures++;
} finally {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}