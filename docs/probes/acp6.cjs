// ACP 鉴权探针：initialize → 枚举 authMethods → 逐个 authenticate → session/new → prompt
// 用法：node acp6.cjs <configDir> [keep|clean]
//   keep  = 继承当前环境（含 CODEBUDDY_HOST / SERVICE_PROXY 等桌面注入变量）
//   clean = 剥离桌面注入变量，模拟用户干净 shell
// 安全：所有写入都落在 <configDir>（应为副本），不碰真实 ~/.workbuddy
const { spawn } = require('child_process');

const BIN = 'D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy';
const CONFIG_DIR = process.argv[2] || '';
const MODE = process.argv[3] || 'keep';
const CWD = 'C:/Users/卿/WorkBuddy/campfire';

const STRIP = [
  'SERVER__PORT',
  'CODEBUDDY_HOST',
  'CODEBUDDY_HOST_CAPABILITIES',
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_MCP_CONFIG',
  'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_CONVERSATION_MESSAGE_ID',
  'CODEBUDDY_CONVERSATION_REQUEST_ID',
  'CODEBUDDY_ROOT_REQUEST_ID',
  'CODEBUDDY_TOOL_CALL_ID',
  'CODEBUDDY_PROJECT_DIR',
  'CODEBUDDY_ENV_FILE',
  'CODEBUDDY_ARTIFACTS',
];

const env = { ...process.env };
delete env.SERVER__PORT; // 必须：否则子进程抢 App 端口 → EADDRINUSE

// isolated：剥掉全部 CODEBUDDY_*/WORKBUDDY_*（尤其 SESSION_ID / HOST / SERVICE_PROXY），
// 否则子进程会以「当前会话」身份挂到调用者自己的 App 上，把调用者搞掉线（已发生过一次）。
if (MODE === 'isolated') {
  for (const k of Object.keys(env)) {
    if (/^(CODEBUDDY_|WORKBUDDY_)/i.test(k)) delete env[k];
  }
}
if (MODE === 'clean') for (const k of STRIP) delete env[k];

env.CODEBUDDY_DISABLE_PROXY_CONFIG_FILE = '1';
env.CODEBUDDY_GATEWAY_PASSWORD = 'probe-fixed-password-0001';
env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';   // D 安装只打包了 lite-wb 产物
env.CODEBUDDY_FORCE_HEADLESS_BUNDLE = '1';
env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1';
if (CONFIG_DIR) env.CODEBUDDY_CONFIG_DIR = CONFIG_DIR;

console.log(`[probe] mode=${MODE} configDir=${CONFIG_DIR || '(default)'}`);
console.log(`[probe] host=${env.CODEBUDDY_HOST || '(none)'} proxy=${env.CODEBUDDY_SERVICE_PROXY_URL ? 'yes' : 'no'} sessionId=${env.CODEBUDDY_SESSION_ID || '(none)'}`);

const child = spawn(process.execPath, [BIN, '--serve', '--acp', '--port', '0'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
  cwd: CWD,
});

let buf = '';
const pending = new Map();
let nextId = 1;
const stderrLines = [];

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line || line[0] !== '{') {
      if (line) console.log('[out]', line.slice(0, 200));
      continue;
    }
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) {
      const u = m.params?.update || {};
      const kind = u.sessionUpdate || m.method;
      const text = u.content?.text || u.delta?.text || '';
      console.log('[notif]', kind, text ? 'text=' + JSON.stringify(text).slice(0, 160) : '');
    }
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString();
  stderrLines.push(s);
  if (!/fetch config failed|subscription-gate/.test(s)) process.stderr.write('[stderr] ' + s.slice(0, 200));
});

child.on('exit', (c) => {
  console.log('[exit]', c);
  const blob = stderrLines.join('');
  for (const kw of ['missing-key', 'Authentication', 'EADDRINUSE', 'at-rest']) {
    if (blob.includes(kw)) console.log(`[stderr-hit] ${kw}`);
  }
  process.exit(0);
});

const rpc = (method, params, ms = 180000) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); }
    }, ms);
  });

(async () => {
  try {
    const init = await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    console.log('INIT loadSession=' + init.agentCapabilities?.loadSession);
    console.log('AUTH_METHODS ' + JSON.stringify(init.authMethods || []).slice(0, 800));

    // 逐个尝试 authenticate
    for (const am of init.authMethods || []) {
      try {
        const r = await rpc('authenticate', { methodId: am.id }, 30000);
        console.log(`AUTH ${am.id} -> OK ${JSON.stringify(r).slice(0, 200)}`);
      } catch (e) {
        console.log(`AUTH ${am.id} -> FAIL ${e.message.slice(0, 220)}`);
      }
    }

    // 建新会话并试 prompt（不碰桌面会话）
    const s = await rpc('session/new', { cwd: CWD, mcpServers: [] });
    console.log('NEW ' + s.sessionId);
    const p = await rpc('session/prompt', {
      sessionId: s.sessionId,
      prompt: [{ type: 'text', text: '只回复两个字：就绪' }],
    }, 180000);
    console.log('PROMPT ' + JSON.stringify(p).slice(0, 800));
  } catch (e) {
    console.log('ERR ' + e.message.slice(0, 500));
  } finally {
    try { child.kill(); } catch {}
    setTimeout(() => process.exit(0), 500);
  }
})();
