/**
 * DSH 适配器端到端联调：
 *   隔离围炉实例 + mock DSH + agent.mjs 子进程
 *   验证：@恭喜（mint Cookie）与 @发财（pc Cookie）两条链路都能收到
 *   完整提示词并落回复。
 *
 * 运行：node .smoke3/e2e.mjs（仓库根目录）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeApp, ownerClient, sleep } from '../test/helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function log(...a) {
  console.log('[e2e]', ...a);
}

// 起 mock DSH
const mock = spawn('E:/Software/NodeJS/node.exe', ['.smoke3/mock-dsh.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const mockPort = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('mock DSH 启动超时')), 10_000);
  mock.on('message', (m) => {
    if (m && m.ready) {
      clearTimeout(t);
      resolve(m.port);
    }
  });
  mock.on('exit', (c) => reject(new Error(`mock DSH 提前退出 code=${c}`)));
});
const MOCK_BASE = `http://127.0.0.1:${mockPort}`;
log('mock DSH 就绪', MOCK_BASE);

// 发财用的假 Cookie 缓存文件
const cookieFile = '.smoke3/fake-pc-cookie';
fs.writeFileSync(cookieFile, 'v1.' + 'x'.repeat(300));

const app = await makeApp();
const owner = ownerClient(app.base);
await owner.login();

async function createPullMember(handle, display) {
  const r = await owner.post('/api/members', {
    handle,
    display,
    persona: `你是${display}，回答简短。`,
    driver: { type: 'pull' },
    chats: ['main'],
  });
  assert.equal(r.status, 200, `建成员 ${handle} 失败：${JSON.stringify(r.data)}`);
  return r.data.key;
}

const gongxiKey = await createPullMember('gongxi', '恭喜');
const facaiKey = await createPullMember('facai', '发财');
log('两个 pull 成员已创建');

// mint Cookie 需要的密钥（32 字节 base64url）
const secret = Buffer.alloc(32, 7).toString('base64url');

const adapter = spawn('E:/Software/NodeJS/node.exe', ['adapters/dsh/agent.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    CAMPFIRE_URL: app.base,
    MEM1_HANDLE: 'gongxi',
    MEM1_KEY: gongxiKey,
    MEM1_DSH_BASE: MOCK_BASE,
    MEM1_COOKIE: 'mint',
    MEM2_HANDLE: 'facai',
    MEM2_KEY: facaiKey,
    MEM2_DSH_BASE: MOCK_BASE,
    MEM2_COOKIE: 'pc',
    PC_COOKIE_CACHE: cookieFile,
    BRIDGE_NAS_SECRET: secret,
    AGENT_DATA_DIR: '.smoke3/agent-data',
    POLL_WAIT_SEC: '1',
    LOG_LEVEL: 'debug',
  },
});
const adapterLines = [];
adapter.stdout.on('data', (d) => adapterLines.push(...String(d).trim().split('\n')));
adapter.stderr.on('data', (d) => adapterLines.push('[err] ' + String(d).trim()));

async function waitReply(sender, marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = (await owner.get('/api/messages?chat=main')).data.messages;
    const hit = msgs.find((m) => m.sender === sender && String(m.text).includes(marker));
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(`超时：没等到 ${sender} 的回复（含 ${marker}）\n适配器日志：\n${adapterLines.slice(-30).join('\n')}`);
}

try {
  // 链路一：@恭喜（mint）
  await owner.post('/api/messages', { chat: 'main', text: '@恭喜 你好，报个到' });
  const r1 = await waitReply('gongxi', 'MOCK回复');
  log('✓ @恭喜 链路通，回复：', r1.text.slice(0, 60));
  assert.ok(r1.text.includes('[人设]✓'), '回复应基于完整提示词（含 [人设] 段）');

  // 链路二：@发财（pc 缓存 Cookie）
  await owner.post('/api/messages', { chat: 'main', text: '@发财 你也报个到' });
  const r2 = await waitReply('facai', 'MOCK回复');
  log('✓ @发财 链路通，回复：', r2.text.slice(0, 60));

  // 会话续接：第二次 @ 同一成员应复用 DSH 会话（sessions.json 里一个成员一条）
  await owner.post('/api/messages', { chat: 'main', text: '@恭喜 再说一句' });
  await waitReply('gongxi', 'MOCK回复', 30_000);
  const sess = JSON.parse(fs.readFileSync('.smoke3/agent-data/sessions.json', 'utf8'));
  const gongxiSessions = Object.keys(sess).filter((k) => k.startsWith('gongxi|'));
  assert.equal(gongxiSessions.length, 1, '同一群同一成员只应有一个 DSH 会话');
  log('✓ 会话续接正常（同群同成员单会话）');

  console.log('\n全部通过 ✓');
} finally {
  adapter.kill();
  mock.kill();
  await app.close();
  fs.rmSync('.smoke3/agent-data', { recursive: true, force: true });
  fs.rmSync(cookieFile, { force: true });
}
