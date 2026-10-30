import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AcpClient } from '../src/bridges/workbuddy/acp-client.js';
import { WorkBuddyBridge, SessionIndex, BridgeError } from '../src/bridges/workbuddy/bridge.js';

/** 假 ACP 服务：只实现桥需要的四个方法，用来验证协议装配而不是模型。 */
function makeFakeAcp() {
  const state = { calls: [], promptMode: 'ok' };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/acp/connect') {
      state.calls.push('connect');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ connectionId: 'conn-1' }));
    }
    if (req.url === '/api/v1/acp' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body || '{}');
        state.calls.push(msg.method);
        const send = (obj) => res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });

        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        } else if (msg.method === 'session/load') {
          send({ jsonrpc: '2.0', id: msg.id, result: { models: {}, modes: {} } });
        } else if (msg.method === 'session/prompt') {
          if (state.promptMode === 'refuse') {
            send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'refusal', _meta: { error: 'Authentication required' } },
            });
          } else {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: '收到' } } },
            });
            send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }
        } else {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
        }
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('WorkBuddy 桥', () => {
  let fake;
  let acp;
  let bridge;
  let dbDir;
  let dbPath;

  before(async () => {
    fake = await makeFakeAcp();
    acp = new AcpClient({ baseUrl: fake.baseUrl, password: 'pw' });
    await acp.connect();
    await acp.initialize();

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-bridge-'));
    dbPath = path.join(dbDir, 'workbuddy.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER, last_activity_at INTEGER, unread INTEGER);
      INSERT INTO sessions (id, updated_at, last_activity_at, unread) VALUES ('s1', 1, 1, 0);
    `);
    db.close();

    bridge = new WorkBuddyBridge({ acp, sessionIndex: new SessionIndex({ dbPath }) });
  });

  after(async () => {
    await new Promise((r) => fake.server.close(r));
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  test('投递成功：返回文本，且同一会话只 load 一次', async () => {
    const a = await bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '你好' });
    assert.equal(a.text, '收到');
    assert.equal(a.stopReason, 'end_turn');

    const b = await bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '再来' });
    assert.equal(b.text, '收到');

    const loads = fake.state.calls.filter((c) => c === 'session/load').length;
    assert.equal(loads, 1, 'load 应该只发生一次');
    const prompts = fake.state.calls.filter((c) => c === 'session/prompt').length;
    assert.equal(prompts, 2);
  });

  test('写入后同步 sessions 表', async () => {
    await bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '同步一下' });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT updated_at, unread FROM sessions WHERE id = ?').get('s1');
    db.close();
    assert.ok(row.updated_at > 1);
    assert.equal(row.unread, 1);
  });

  test('同一 messageId 重复投递被短路', async () => {
    const before = fake.state.calls.filter((c) => c === 'session/prompt').length;
    const first = await bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '一次', messageId: 'm-1' });
    assert.equal(first.duplicate, undefined);
    const second = await bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '一次', messageId: 'm-1' });
    assert.equal(second.duplicate, true);
    const after = fake.state.calls.filter((c) => c === 'session/prompt').length;
    assert.equal(after, before + 1, '重复消息不应再次调用模型');
  });

  test('refusal 抛 BridgeError，并清掉 load 缓存', async () => {
    fake.state.promptMode = 'refuse';
    await assert.rejects(
      () => bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '会失败' }),
      (err) => err instanceof BridgeError && err.code === 'bridge_refused',
    );
    fake.state.promptMode = 'ok';
    // 失败后下一次应重新 load
    const before = fake.state.calls.filter((c) => c === 'session/load').length;
    await bridge.deliver({ sessionId: 's1', cwd: '/tmp/x', text: '恢复' });
    const after = fake.state.calls.filter((c) => c === 'session/load').length;
    assert.equal(after, before + 1);
  });

  test('缺参数与空消息被拒', async () => {
    await assert.rejects(() => bridge.deliver({ sessionId: '', cwd: '/x', text: 'hi' }), /sessionId/);
    await assert.rejects(() => bridge.deliver({ sessionId: 's1', cwd: '/x', text: '  ' }), /为空/);
  });
});
