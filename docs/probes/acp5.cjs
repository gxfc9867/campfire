// ACP 调试客户端：打印所有通知
const { spawn } = require('child_process');

const BIN = 'D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy';
const MODE = process.argv[2] || 'load';
const LOAD_ID = process.argv[3] || '';
const CWD = process.argv[4] || 'C:/Users/卿/WorkBuddy/campfire';
const CONFIG_DIR = process.argv[5] || '';

const env = { ...process.env };
delete env.SERVER__PORT;


env.CODEBUDDY_DISABLE_PROXY_CONFIG_FILE = '1';
if (CONFIG_DIR) env.CODEBUDDY_CONFIG_DIR = CONFIG_DIR;

const child = spawn(process.execPath, [BIN, '--serve', '--acp', '--port', '0'], { stdio: ['pipe', 'pipe', 'pipe'], env });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line || line[0] !== '{') continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) {
      const u = m.params?.update || {};
      const kind = u.sessionUpdate || m.method;
      const text = u.content?.text || u.delta?.text || '';
      console.log('[notif]', kind, text ? 'text=' + JSON.stringify(text).slice(0, 120) : JSON.stringify(m.params).slice(0, 200));
    }
  }
});
child.stderr.on('data', (d) => { const s = d.toString(); if (!/fetch config failed|subscription-gate/.test(s)) process.stderr.write('[stderr] ' + s.slice(0, 160)); });
child.on('exit', (c) => { console.log('[exit]', c); process.exit(0); });

const rpc = (method, params, ms = 120000) => new Promise((res, rej) => {
  const id = nextId++; pending.set(id, { resolve: res, reject: rej });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, ms);
});

(async () => {
  try {
    const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    console.log('INIT: loadSession=' + init.agentCapabilities?.loadSession + ' auth=' + JSON.stringify(init.authMethods?.map(a => a.id)));
    let sid;
    if (MODE === 'load') {
      const r = await rpc('session/load', { sessionId: LOAD_ID, cwd: CWD, mcpServers: [] });
      console.log('LOAD ok, modes=' + JSON.stringify(r?.modes?.availableModes?.map(m => m.id)));
      sid = LOAD_ID;
      if (r?.modes?.currentModeId) console.log('currentMode=' + r.modes.currentModeId);
    } else {
      const s = await rpc('session/new', { cwd: CWD, mcpServers: [] });
      console.log('NEW ' + s.sessionId + ' modes=' + JSON.stringify(s?.modes?.availableModes?.map(m => m.id)));
      sid = s.sessionId;
    }
    const p = await rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好，请回复一句自我介绍' }] });
    console.log('PROMPT result=' + JSON.stringify(p).slice(0,600));
  } catch (e) {
    console.log('ERR ' + e.message.slice(0, 400));
  } finally {
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(0), 300);
  }
})();
