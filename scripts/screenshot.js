import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 开发辅助：把界面截图下来。
 *
 * 不是为了做视觉回归（那要更完整的基线管理），只是为了在改完样式后
 * 能真的看一眼，而不是靠猜。用 Chrome 自带的 headless + CDP，
 * 不引入 puppeteer 之类的依赖。
 *
 * 用法：node scripts/screenshot.js [宽] [高]
 * 产物在 .preview/ 下（已 gitignore）。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, '.preview');
const W = Number(process.argv[2]) || 1440;
const H = Number(process.argv[3]) || 900;

process.env.LOG_LEVEL = 'error';
const { createApp } = await import('../src/server.js');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：只够发命令、等响应、收事件。 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20_000);
    });
  }

  static async attach(port) {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        const target = await res.json();
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        return new CDP(ws);
      } catch {
        await sleep(200);
      }
    }
    throw new Error('连不上 Chrome 调试端口');
  }
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  已保存 ${name}.png`);
}

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome，跳过截图');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-shot-'));
  const app = createApp({
    config: {
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      ownerKey: 'preview-key',
      ownerKeySource: 'env',
      ownerKeyGenerated: false,
    },
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;

  // 造一点内容，否则截出来的是空壳，看不出真实布局
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc[0].split(';')[0];
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };

  await req('POST', '/api/login', { password: 'preview-key' });
  const members = [
    { handle: 'ruyi', display: '如意', avatar: 'preset:07', persona: '说话简洁，先给结论' },
    { handle: 'laochen', display: '老陈', avatar: 'preset:13', persona: '负责后端，说话直' },
    { handle: 'afei', display: '阿飞', avatar: 'preset:22', persona: '前端，爱较真' },
  ];
  for (const m of members) {
    await req('POST', '/api/members', {
      ...m,
      driver: { type: 'pull' },
      chats: ['main'],
      aliases: [],
    });
  }
  await req('POST', '/api/chats', { name: '自媒体' });
  await req('POST', '/api/messages', { chat: 'main', text: '今天把这个群聊桥的成员体系重新设计一下' });
  await req('POST', '/api/messages', { chat: 'main', text: '@ruyi 先给个方案，重点说清楚唤醒和休眠怎么权衡' });
  await req('POST', '/api/messages', { chat: 'main', text: '@老陈 你看下长轮询在反代后面会不会有问题' });
  await req('POST', '/api/messages', { chat: 'main', text: '收到，我先看下 keep-alive 的配置' });

  console.log('启动 Chrome');
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      `--window-size=${W},${H}`,
      `--user-data-dir=${path.join(dir, 'chrome')}`,
      '--remote-debugging-port=9333',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  try {
    const cdp = await CDP.attach(9333);
    // 把浏览器 console 转发出来：页面白屏时第一件事就是看这里
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 300);
        if (text) console.log(`  [浏览器:${msg.params.type}] ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        console.log(`  [浏览器异常] ${d.exception?.description || d.text}`.slice(0, 400));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 未登录：登录页
    await cdp.send('Page.navigate', { url: base });
    await sleep(1200);
    const info = await cdp.send('Runtime.evaluate', {
      expression:
        'JSON.stringify({rs: document.readyState, title: document.title, kids: document.body.children.length, loginHid: document.getElementById("login")?.hidden, appHid: document.getElementById("app")?.hidden, res: performance.getEntriesByType("resource").map(r=>({n:r.name.slice(-30), size:r.transferSize, dur:Math.round(r.duration)}))})',
      returnByValue: true,
    });
    console.log('  [诊断]', info.result.value);
    await shot(cdp, `login-${W}`);

    // 设好会话再进主界面
    const [name, value] = cookie.split('=');
    await cdp.send('Network.setCookie', {
      name,
      value: decodeURIComponent(value),
      domain: '127.0.0.1',
      path: '/',
    });
    await cdp.send('Page.navigate', { url: base });
    await sleep(1800);
    await shot(cdp, `chat-${W}`);

    // 深色主题
    await cdp.send('Runtime.evaluate', {
      expression: `document.documentElement.dataset.theme='dark'`,
    });
    await sleep(400);
    await shot(cdp, `chat-dark-${W}`);

    // 成员管理
    await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('btn-members').click()`,
    });
    await sleep(900);
    await shot(cdp, `members-${W}`);

    // 成员编辑
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('.member-card')?.click()`,
    });
    await sleep(700);
    await shot(cdp, `editor-${W}`);
  } finally {
    chrome.kill();
    await sleep(300);
    await app.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('截图失败：', e.message);
  process.exitCode = 1;
});
