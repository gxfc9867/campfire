#!/usr/bin/env node
/**
 * DSH 接入围炉适配器（pull 型成员，可同时带两个 DSH）。
 *
 * 每个成员一条独立循环：
 *   长轮询 inbox → 按群合并 → 取服务端拼好的提示词 → 转发给 DSH Web Host
 *   → 等完整回复 → 回执（多消息时 ack 其余）。
 *
 * 恭喜（NAS 端 DSH）：Cookie 由凭据密钥离线签发（mintCookie，密钥来自
 *   BRIDGE_NAS_SECRET 或 BRIDGE_NAS_CREDENTIALS 凭据文件）。
 * 发财（电脑端 DSH）：Cookie 复用桥同步来的缓存文件，缺失/失效时经 SSH 兜底拉取；
 *   SSH 隧道优先复用 dsh-bridge 维护的那条（19387），不在且配置了 SSH 才自己拉。
 *
 * 运行：node agent.mjs（配置全部走环境变量，模板见 .env.example）
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { DshWebClient } from './dsh-web-client.js';
import { mintCookie } from './dsh-cookie.js';

const CAMPFIRE_URL = (process.env.CAMPFIRE_URL || 'http://127.0.0.1:8099').replace(/\/$/, '');
const WAIT_SEC = Number(process.env.POLL_WAIT_SEC || 25);
const DSH_TIMEOUT_MS = Number(process.env.DSH_TIMEOUT_MS || 300_000);
const DATA_DIR = process.env.AGENT_DATA_DIR || '/app/data';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const DAY_MS = 86_400_000;

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}
function debug(...a) {
  if (LOG_LEVEL === 'debug') console.log(`[${new Date().toISOString().slice(11, 19)}] [debug]`, ...a);
}

// ---------------------------------------------------------------- 成员配置

function loadMembers() {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const handle = process.env[`MEM${i}_HANDLE`];
    if (!handle) continue;
    const key = process.env[`MEM${i}_KEY`];
    const base = process.env[`MEM${i}_DSH_BASE`];
    if (!key) throw new Error(`成员 ${handle} 缺少 MEM${i}_KEY（在围炉成员页创建后复制）`);
    if (!base) throw new Error(`成员 ${handle} 缺少 MEM${i}_DSH_BASE（DSH Web Host 地址）`);
    out.push({
      index: i,
      handle,
      key,
      base,
      // 电脑端 DSH 没有固定工作区，留空；NAS 端默认 /root/NAS
      workspace: process.env[`MEM${i}_WORKSPACE`] ?? '',
      // mint = 用凭据密钥离线签发（恭喜）；pc = 读桥的 Cookie 缓存 / SSH 兜底（发财）
      kind: process.env[`MEM${i}_COOKIE`] || 'mint',
    });
  }
  return out;
}

let MEMBERS;
try {
  MEMBERS = loadMembers();
} catch (e) {
  console.error(e.message);
  console.error('配置模板见 .env.example');
  process.exit(1);
}
if (!MEMBERS.length) {
  console.error('没有可运行的成员。请在 .env 里至少配置一组 MEM1_HANDLE / MEM1_KEY / MEM1_DSH_BASE（模板见 .env.example）');
  process.exit(1);
}

// ---------------------------------------------------------------- 会话存储

// DshWebClient 期望的 store：getAgentSession(chatId, name) / saveAgentSession(chatId, name, sid)
class SessionStore {
  #file = path.join(DATA_DIR, 'sessions.json');
  #data = null;
  #load() {
    if (this.#data) return this.#data;
    try {
      this.#data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      this.#data = {};
    }
    return this.#data;
  }
  #save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(this.#file, JSON.stringify(this.#data, null, 2));
    } catch (e) {
      log('会话存储写入失败：', e.message);
    }
  }
  getAgentSession(chatId, name) {
    const sid = this.#load()[`${name}|${chatId}`];
    return sid ? { session_id: sid } : null;
  }
  saveAgentSession(chatId, name, sid) {
    this.#load()[`${name}|${chatId}`] = sid;
    this.#save();
  }
}
const store = new SessionStore();

// ---------------------------------------------------------------- Cookie

// 恭喜：离线签发，29 天一换（提前 1 天续期，避免边界失效）
function mintProvider() {
  let cookie = null;
  let expiry = 0;
  return (authority) => {
    const now = Date.now();
    if (cookie && now < expiry) return Promise.resolve(cookie);
    cookie = mintCookie(authority, process.env);
    expiry = now + 29 * DAY_MS;
    return Promise.resolve(cookie);
  };
}

// 发财：读缓存文件 → SSH 兜底；缓存 24 小时，RPC 报 401 时由 askWithRetry 强制重取
const PC_COOKIE_CACHE = process.env.PC_COOKIE_CACHE || '';
const PC_SSH_HOST = process.env.PC_SSH_HOST || '';
const PC_SSH_PORT = Number(process.env.PC_SSH_PORT || 22);
const PC_SSH_USER = process.env.PC_SSH_USER || 'user';
const PC_SSH_KEY = process.env.PC_SSH_KEY || '';
const PC_WIN_COOKIE_PATH = process.env.PC_WIN_COOKIE_PATH || '';
const PC_TUNNEL_PORT = Number(process.env.PC_TUNNEL_PORT || 19387);

function readCookieFile(file) {
  if (!file) return null;
  try {
    const c = fs.readFileSync(file, 'utf8').trim();
    return c && c.length > 100 ? c : null;
  } catch {
    return null;
  }
}

function sshPullCookie() {
  try {
    const out = execFileSync(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-i', PC_SSH_KEY,
        '-p', String(PC_SSH_PORT),
        '-l', PC_SSH_USER,
        PC_SSH_HOST,
        'type', PC_WIN_COOKIE_PATH,
      ],
      { timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const c = out.replace(/\r?\n/g, '').trim();
    return c && c.length > 100 ? c : null;
  } catch (e) {
    log('SSH 拉取发财 Cookie 失败：', e.message);
    return null;
  }
}

function pcProvider() {
  let cookie = null;
  let expiry = 0;
  let forceRefresh = false;
  const pull = () => readCookieFile(PC_COOKIE_CACHE) || (PC_SSH_HOST && PC_WIN_COOKIE_PATH ? sshPullCookie() : null);
  return {
    get: () => {
      const now = Date.now();
      if (forceRefresh) {
        forceRefresh = false;
        cookie = pull();
        if (cookie) expiry = now + DAY_MS;
        return Promise.resolve(cookie);
      }
      if (cookie && now < expiry) return Promise.resolve(cookie);
      cookie = pull();
      if (cookie) expiry = now + DAY_MS;
      return Promise.resolve(cookie);
    },
    invalidate: () => {
      forceRefresh = true;
      cookie = null;
      expiry = 0;
    },
  };
}
const pcCookie = pcProvider();
const mintFor = mintProvider();

async function cookieFor(m) {
  if (m.kind !== 'pc') {
    const authority = (() => {
      try {
        return new URL(m.base).host;
      } catch {
        return '127.0.0.1:3081';
      }
    })();
    return mintFor(authority);
  }
  return pcCookie.get();
}

// ---------------------------------------------------------------- SSH 隧道（发财）

let tunnelProc = null;

function portAlive(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
  });
}

function spawnTunnel() {
  if (!PC_SSH_HOST || !PC_SSH_KEY) return;
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-i', PC_SSH_KEY,
    '-p', String(PC_SSH_PORT),
    '-l', PC_SSH_USER,
    '-L', `${PC_TUNNEL_PORT}:127.0.0.1:${PC_TUNNEL_PORT}`,
    '-N',
    PC_SSH_HOST,
  ];
  try {
    const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s && !/Permanently added|known hosts/.test(s)) debug('[隧道]', s.slice(0, 160));
    });
    proc.on('exit', () => {
      if (tunnelProc === proc) tunnelProc = null;
    });
    tunnelProc = proc;
  } catch (e) {
    log('隧道启动失败：', e.message);
  }
}

async function ensureTunnel() {
  if (await portAlive(PC_TUNNEL_PORT)) return true; // 桥的隧道在，直接复用
  if (!PC_SSH_HOST || !PC_SSH_KEY) {
    // 没配 SSH 兜底就不硬拦：直连试一把，DSH 真不可达时该批投递自然报错
    log(`隧道 127.0.0.1:${PC_TUNNEL_PORT} 不在线且未配置 SSH 兜底，仍尝试直连`);
    return true;
  }
  spawnTunnel();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portAlive(PC_TUNNEL_PORT)) {
      log(`隧道就绪 127.0.0.1:${PC_TUNNEL_PORT}`);
      return true;
    }
  }
  log('隧道 10 秒内未就绪');
  return false;
}

// ---------------------------------------------------------------- DSH 客户端

const INTRO = [
  '你已作为成员接入「围炉」群聊（一个多智能体群聊服务）。',
  '接下来会收到一条系统拼好的提示词，包含：你的人设、你记得的事、最近的群聊上下文和本次触发。',
  '请按提示词要求输出一条可以直接发到群里的消息，不要复述提示词结构，不要加前缀或署名。',
].join('\n');

const clients = new Map();

function getClient(m) {
  if (!clients.has(m.handle)) {
    clients.set(
      m.handle,
      new DshWebClient({
        name: m.handle,
        baseUrl: m.base,
        workspace: m.workspace,
        cookieProvider: () => cookieFor(m),
        store,
        intro: INTRO,
        timeoutMs: DSH_TIMEOUT_MS,
        logger: { info: log, error: log, debug },
      }),
    );
  }
  return clients.get(m.handle);
}

async function askWithRetry(m, { chatId, text, requestId }) {
  try {
    return await getClient(m).ask({ chatId, text, requestId });
  } catch (e) {
    if (m.kind === 'pc' && /Cookie 已失效/.test(e.message)) {
      log(`${m.handle} Cookie 失效，刷新后重试一次`);
      pcCookie.invalidate();
      clients.delete(m.handle); // 重建客户端，让 cookieProvider 重新走一遍
      return await getClient(m).ask({ chatId, text, requestId });
    }
    throw e;
  }
}

// ---------------------------------------------------------------- 围炉 API

function headers(m, withBody) {
  const h = { 'X-Campfire-Member': m.handle, 'X-Campfire-Key': m.key };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

async function api(m, method, pathname, body, timeoutMs = 40_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CAMPFIRE_URL}${pathname}`, {
      method,
      headers: headers(m, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      const err = new Error('鉴权失败：成员密钥不对或已被轮换');
      err.fatal = true;
      throw err;
    }
    if (res.status === 403) {
      const err = new Error('成员不在该群（检查成员的 chats 配置）');
      err.fatal = true;
      throw err;
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status} ${pathname}`);
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

async function report(m, state, running) {
  try {
    await api(m, 'POST', '/api/agent/state', { state, running, limit: 1 }, 8_000);
  } catch {}
}

// ---------------------------------------------------------------- 主循环

let runningCount = 0;

async function handleItems(m, items) {
  // 同一群的多条消息合并成一次 DSH 调用：省回合，也避免回复顺序错乱
  const byChat = new Map();
  for (const it of items) {
    const chatId = it.chatId || it.chatName || 'main';
    if (!byChat.has(chatId)) byChat.set(chatId, []);
    byChat.get(chatId).push(it);
  }

  for (const [chatId, list] of byChat) {
    runningCount++;
    await report(m, 'hot', runningCount);
    try {
      const last = list[list.length - 1];
      const trigger = `刚才有 ${list.length} 条新消息，最后一条来自 ${last.senderName}。请回应。`;
      const { prompt } = await api(
        m,
        'GET',
        `/api/agent/prompt?chat=${encodeURIComponent(chatId)}&trigger=${encodeURIComponent(trigger)}`,
        undefined,
        10_000,
      );

      if (m.kind === 'pc') {
        const ok = await ensureTunnel();
        if (!ok) throw new Error('发财隧道不可用（桥不在或电脑端离线，且未配置 SSH 兜底）');
      }

      log(`${m.handle} 转发给 DSH 处理 ${list.length} 条（${chatId}）`);
      const { text } = await askWithRetry(m, { chatId, text: prompt, requestId: last.requestId });

      await api(m, 'POST', '/api/agent/reply', { requestId: last.requestId, text }, 15_000);
      const rest = list.slice(0, -1).map((i) => i.requestId);
      if (rest.length) {
        await api(m, 'POST', '/api/agent/ack', { requestIds: rest }, 10_000);
      }
      log(`${m.handle} 已回执 ${list.length} 条`);
    } catch (e) {
      // 不 ack：让这批投递自然降级，用户能看到「没处理」而不是被吞掉
      log(`${m.handle} 处理失败：${e.message}`);
    } finally {
      runningCount--;
      await report(m, 'hot', runningCount);
    }
  }
}

async function loop(m) {
  log(`${m.handle} 上线 → ${CAMPFIRE_URL}（DSH: ${m.base}，Cookie: ${m.kind}）`);
  let backoff = 1_000;
  for (;;) {
    await report(m, 'hot', runningCount);
    try {
      const data = await api(m, 'GET', `/api/agent/inbox?wait=${WAIT_SEC}`, undefined, (WAIT_SEC + 20) * 1_000);
      backoff = 1_000;
      if (Array.isArray(data.items) && data.items.length) {
        await handleItems(m, data.items);
      }
    } catch (e) {
      if (e.fatal) {
        log(`${m.handle} ${e.message}，30 秒后重试（修好配置即可自动恢复）`);
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      log(`${m.handle} 轮询异常：${e.message}，${backoff / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

for (const m of MEMBERS) loop(m).catch((e) => log(`${m.handle} 循环退出：`, e));
