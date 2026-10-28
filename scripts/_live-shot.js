#!/usr/bin/env node
/**
 * 临时脚本：连到已经在跑的实例截图（不自己起服务）。
 * 用法：node scripts/_live-shot.js <baseUrl> <password> [宽] [高]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, '.preview');
const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PASS = process.argv[3] || '';
const W = Number(process.argv[4]) || 1440;
const H = Number(process.argv[5]) || 900;

fs.mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('找不到 Chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (this.onEvent) {
        this.onEvent(msg);
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
    for (let i = 0; i < 60; i++) {
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

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shot-'));
const PORT = 9335;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-gpu',
    `--window-size=${W},${H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`已保存 ${name}.png`);
}

try {
  const errors = [];
  const cdp = await CDP.attach(PORT);
  cdp.onEvent = (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`${d.text} ${d.exception?.description || ''}`.slice(0, 300));
    }
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send('Page.navigate', { url: BASE });
  await sleep(1000);

  const login = await cdp.send('Runtime.evaluate', {
    expression: `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(PASS)}})}).then(r=>r.status)`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('登录状态码:', login.result?.value);

  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1800);

  const diag = await cdp.send('Runtime.evaluate', {
    expression:
      'JSON.stringify({rs:document.readyState,login:document.getElementById("login")?.hidden,app:document.getElementById("app")?.hidden,msgs:document.querySelectorAll(".msg").length,chat:document.querySelector(".chat-title h1")?.textContent,chats:[...document.querySelectorAll(".chat-item-name")].map(e=>e.textContent).join("|")})',
    returnByValue: true,
  });
  console.log('页面状态:', diag.result?.value);
  if (errors.length) {
    console.log('JS 异常:');
    for (const e of errors.slice(0, 5)) console.log(' -', e);
  }

  await shot(cdp, 'live-chat');

  // 成员管理页：必须精确匹配「成员管理」，否则会误点到右侧栏的「成员」tab
  await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const b=document.getElementById('btn-members')||[...document.querySelectorAll('a,button')].find(e=>/成员管理/.test(e.textContent));if(b){b.click();return 'clicked'}return 'not found'})()`,
    returnByValue: true,
  });
  await sleep(1200);
  await shot(cdp, 'live-members');

  // 接入向导：点第一张卡片的「接入引导」
  const wire = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const b=document.querySelector('.member-card-wire');if(!b)return 'not found';b.click();return JSON.stringify({overlay:document.getElementById('member-connect')?.hidden,err:document.getElementById('connect-status-text')?.textContent})})()`,
    returnByValue: true,
  });
  console.log('接入点击:', wire.result?.value);
  await sleep(1500);
  await shot(cdp, 'live-connect');

  chrome.kill();
  fs.rmSync(profileDir, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  console.error('截图失败:', e.message);
  chrome.kill();
  process.exit(1);
}
