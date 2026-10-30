// 探针：直接看 HTTP-ACP 的 SSE 原始流，确认工具批准请求到底长什么样。
// 用法：node docs/probes/probe-acp-tools.mjs [sessionId] [cwd]
import fs from 'node:fs';
import { startAcpGateway } from '../../src/bridges/workbuddy/launcher.js';

const sessionId = process.argv[2] || 'ce1e339b-32af-43e0-a8b0-4ca2f7c5469a';
const cwd = process.argv[3] || 'C:/Users/卿/WorkBuddy/群聊桥';
const token = fs.readFileSync('C:/Users/卿/.campfire/secrets/workbuddy-bearer.txt', 'utf8').trim();

const password = `cf-probe-${Date.now()}`;
const gw = await startAcpGateway({
  cliBin: 'D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy',
  configDir: 'C:/Users/卿/.workbuddy',
  token,
  password,
  cwd,
});
console.log('[probe] gateway', gw.baseUrl);

const H = {
  'x-codebuddy-request': '1',
  Authorization: `Bearer ${password}`,
};

let connId;
{
  const res = await fetch(`${gw.baseUrl}/api/v1/acp/connect`, { method: 'POST', headers: H });
  const j = await res.json();
  connId = j.connectionId || j.data?.connectionId;
  console.log('[probe] connect', res.status, connId);
}

const HH = { ...H, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'acp-connection-id': connId };

async function rpc(id, method, params, { stream = false } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  const res = await fetch(`${gw.baseUrl}/api/v1/acp`, {
    method: 'POST',
    headers: HH,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: ctl.signal,
  });
  console.log(`\n[probe] >>> ${method} status=${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let sawResult = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        console.log('  [raw]', raw.slice(0, 200));
        continue;
      }
      const kind = m.type || (m.method ? `method:${m.method}` : m.result ? 'result' : m.error ? 'error' : '?');
      const brief =
        m.type === 'control_request'
          ? JSON.stringify(m.request).slice(0, 220)
          : m.method === 'session/update'
            ? `${m.params?.update?.sessionUpdate} ${JSON.stringify(m.params?.update).slice(0, 160)}`
            : JSON.stringify(m).slice(0, 220);
      console.log(`  [${kind}]`, brief);
      if (m.result || m.error) {
        sawResult = true;
        if (!stream) break;
      }
    }
    if (sawResult && !stream) break;
  }
  clearTimeout(timer);
  try {
    await reader.cancel();
  } catch {}
  return sawResult;
}

await rpc(1, 'initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'campfire-probe', version: '1' },
  clientCapabilities: {},
});
await rpc(2, 'session/load', { sessionId, cwd, mcpServers: [] });
 await rpc(3, 'session/set_mode', { sessionId, modeId: 'bypassPermissions' });
await rpc(4, 'session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: '读一下 J:/campfire/package.json，把 version 字段的值告诉我，只回答版本号' }],
});

await gw.stop?.();
console.log('\n[probe] done');
process.exit(0);
