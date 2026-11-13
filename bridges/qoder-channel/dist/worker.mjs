#!/usr/bin/env node
/**
 * 围炉 × Qoder 渠道 worker
 *
 * 这个文件被 Qoder 的 qoder.communication 宿主进程当作**两个东西**同时使用：
 *
 *   1. MCP Server —— 走 stdin/stdout（JSON-RPC 逐行），宿主用它 tools/list、tools/call
 *   2. 渠道 worker —— 走 Node IPC（process.send / process.on('message')），宿主用它下发
 *      qoder/channel/start、qoder/channel/state 等
 *
 * 两套通道并存，互不干扰：stdout 只写 MCP 帧，日志一律走 stderr。
 *
 * 职责：
 *   - 连围炉（长轮询 /v1/updates 收群消息）
 *   - 收到群消息 → 发 hostRequest {type:"create"|"continue"} 把消息投进真实桌面会话
 *   - 发 hostRequest {type:"watchState"} 订阅该 turn，收 qoder/channel/state 里的 messages
 *   - 把回复 POST 回围炉 /v1/messages
 *   - 提供 MCP 工具让会话里的 agent 主动往群里发消息
 *
 * 设计原则：零依赖、单文件、出错不崩（宿主会自动重启，但尽量别让它重启）。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ───────────────────────────── 常量 ─────────────────────────────

const KIND = process.env.QODER_CHANNEL_KIND || 'campfire';
const DATA_DIR = process.env.QODER_CHANNEL_DATA || path.join(process.cwd(), '.campfire-data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const READY_TIMEOUT_MS = 15000;      // 宿主给 15 秒握手
const POLL_TIMEOUT_MS = 35000;       // 长轮询超时（要比服务端长）
const POLL_INTERVAL_MS = 1000;       // 出错后重试间隔
const MAX_MSG_CHARS = 20000;         // 宿主限制

// ───────────────────────────── 日志（只走 stderr）─────────────────────────────

function log(...args) {
  process.stderr.write(`[campfire] ${new Date().toISOString()} ${args.join(' ')}\n`);
}

// ───────────────────────────── 持久化 ─────────────────────────────

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    log('mkdir 失败', e.message);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (e) {
    log('写文件失败', file, e.message);
  }
}

/**
 * 配置：围炉地址 + 渠道令牌
 * 由 qoder/channel/manage 动作写入，也允许手工放 config.json
 */
function loadConfig() {
  const cfg = readJson(CONFIG_PATH, {});
  return {
    baseUrl: String(cfg.baseUrl || process.env.CAMPFIRE_URL || '').replace(/\/+$/, ''),
    token: String(cfg.token || process.env.CAMPFIRE_TOKEN || ''),
    member: String(cfg.member || process.env.CAMPFIRE_MEMBER || ''),
    sessionId: String(cfg.sessionId || ''),   // 已绑定的 Qoder 会话（create 后写入）
  };
}

function saveConfig(patch) {
  const next = { ...readJson(CONFIG_PATH, {}), ...patch };
  writeJson(CONFIG_PATH, next);
  return next;
}

/** 运行时状态：每个围炉会话对应哪个 Qoder sessionId、已处理到哪条消息 */
function loadState() {
  return readJson(STATE_PATH, { cursor: 0, sessions: {} });
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

// ───────────────────────────── Node IPC（宿主通道）─────────────────────────────

const ipc = {
  readySent: false,
  pendingHost: new Map(),   // id -> { resolve, reject, timer }
  seq: 0,

  /** 告诉宿主：我起来了 */
  sendReady() {
    if (this.readySent) return;
    this.readySent = true;
    this.send({ type: 'ready', version: 1 });
    log('已发送 ready');
  },

  send(frame) {
    try {
      if (typeof process.send === 'function') {
        process.send(frame);
      }
    } catch (e) {
      log('IPC 发送失败', e.message);
    }
  },

  /** 回应宿主的 call */
  replyCall(id, result, error) {
    if (error) this.send({ type: 'result', id, error: String(error) });
    else this.send({ type: 'result', id, result });
  },

  /** 向宿主发起操作请求（create / continue / watchState …），返回 Promise */
  hostRequest(operation, timeoutMs = 60000) {
    const id = `campfire-${Date.now()}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHost.delete(id);
        reject(new Error('CHANNEL_OPERATION_UNKNOWN'));
      }, timeoutMs);
      this.pendingHost.set(id, { resolve, reject, timer });
      this.send({ type: 'hostRequest', id, operation });
    });
  },

  /** 处理宿主发来的一帧 */
  handle(frame) {
    if (!frame || typeof frame !== 'object') return;

    // hostResult：我们刚才发的 hostRequest 有回执了
    if (frame.type === 'hostResult') {
      const p = this.pendingHost.get(frame.id);
      if (!p) return;
      this.pendingHost.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) p.reject(new Error(frame.error));
      else p.resolve(frame.result);
      return;
    }

    // call：宿主让我们做事（生命周期 / 状态推送）
    if (frame.type === 'call') {
      handleHostCall(frame).catch((e) => {
        log('handleHostCall 异常', e.message);
        this.replyCall(frame.id, null, e.message);
      });
      return;
    }
  },
};

/** 处理宿主下发的 call */
async function handleHostCall(frame) {
  const { id, method, params } = frame;
  log('收到宿主调用', method);

  switch (method) {
    // 渠道启动：开始连围炉
    case 'qoder/channel/start': {
      startBridge().catch((e) => log('startBridge 失败', e.message));
      ipc.replyCall(id, { ok: true });
      return;
    }

    // 配置 / 状态管理
    case 'qoder/channel/manage': {
      const result = await handleManage(params || {});
      ipc.replyCall(id, result);
      return;
    }

    // 会话状态推送（回复正文在这里）
    case 'qoder/channel/state': {
      handleChannelState(params || {}).catch((e) => log('handleChannelState 失败', e.message));
      ipc.replyCall(id, { ok: true });
      return;
    }

    // 宿主来取附件内容
    case 'qoder/channel/attachment': {
      ipc.replyCall(id, { ok: false }, 'CHANNEL_ATTACHMENT_UNAVAILABLE');
      return;
    }

    default:
      ipc.replyCall(id, null, 'CHANNEL_OPERATION_UNKNOWN');
  }
}

/** 配置管理动作 */
async function handleManage(params) {
  const action = String(params.action || '');

  if (action === 'status' || action === 'get') {
    const cfg = loadConfig();
    return {
      configured: Boolean(cfg.baseUrl && cfg.token),
      baseUrl: cfg.baseUrl,
      member: cfg.member,
      sessionId: cfg.sessionId,
      hasToken: Boolean(cfg.token),
    };
  }

  if (action === 'save' || action === 'configure' || action === 'setup') {
    const cfg = saveConfig({
      baseUrl: params.baseUrl ? String(params.baseUrl).replace(/\/+$/, '') : undefined,
      token: params.token ? String(params.token) : undefined,
      member: params.member ? String(params.member) : undefined,
    });
    log('配置已保存', cfg.baseUrl, cfg.member);
    // 配置变了就重启桥
    stopBridge();
    startBridge().catch((e) => log('重启桥失败', e.message));
    return { ok: true, configured: Boolean(cfg.baseUrl && cfg.token) };
  }

  if (action === 'clear') {
    saveConfig({ baseUrl: '', token: '', member: '', sessionId: '' });
    stopBridge();
    return { ok: true };
  }

  return { ok: false, error: 'UNKNOWN_ACTION' };
}

// ───────────────────────────── 会话状态（拿回复）─────────────────────────────

/** 每个 turnId 等到回复后要发回哪个围炉会话 */
const pendingTurns = new Map();   // `${sessionId}:${turnId}` -> { chatId, replyTo, messageId }

/** 宿主推来会话状态 */
async function handleChannelState(payload) {
  const { sessionId, turnId, messages, terminalOutcome, active } = payload;

  if (terminalOutcome === 'failed') {
    log('turn 失败', sessionId, turnId);
  }

  // 提取助手回复正文
  const text = extractAssistantText(messages);
  if (!text) {
    if (terminalOutcome === 'completed' && !active) {
      // 结束了但没文本，可能是纯工具轮次
      log('turn 完成但无文本', sessionId, turnId);
    }
    return;
  }

  const key = `${sessionId}:${turnId}`;
  const ctx = pendingTurns.get(key);
  if (!ctx) {
    log('收到未登记的 turn 状态，忽略', key);
    return;
  }

  // 只在 turn 结束时回帖，避免流式重复
  if (!terminalOutcome) return;

  pendingTurns.delete(key);
  await postToCampfire(text, ctx);
}

/** 从 messages 里拼出助手文本 */
function extractAssistantText(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role && m.role !== 'assistant') continue;
    if (typeof m.text === 'string') parts.push(m.text);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/** 把回复发回围炉 */
async function postToCampfire(text, ctx) {
  const cfg = loadConfig();
  if (!cfg.baseUrl || !cfg.token) {
    log('未配置围炉，无法回帖');
    return;
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chatId: ctx.chatId || 'main',
        text: text.slice(0, MAX_MSG_CHARS),
        clientMsgId: `qoder-${ctx.chatId}-${Date.now()}`,
        ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}),
      }),
    });
    if (!res.ok) log('回帖失败 HTTP', res.status, await safeText(res));
    else log('已回帖', text.slice(0, 40));
  } catch (e) {
    log('回帖异常', e.message);
  }
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}

// ───────────────────────────── 围炉客户端 ─────────────────────────────

let bridgeRunning = false;
let bridgeAbort = null;
const seenMessageIds = new Set();

async function startBridge() {
  if (bridgeRunning) return;
  const cfg = loadConfig();
  if (!cfg.baseUrl || !cfg.token) {
    log('未配置围炉，暂不启动轮询');
    return;
  }

  bridgeRunning = true;
  bridgeAbort = new AbortController();
  log('围炉桥启动', cfg.baseUrl, cfg.member || '(无成员名)');

  pollLoop(bridgeAbort.signal).catch((e) => {
    log('轮询循环退出', e.message);
    bridgeRunning = false;
  });
}

function stopBridge() {
  if (bridgeAbort) {
    try { bridgeAbort.abort(); } catch {}
  }
  bridgeAbort = null;
  bridgeRunning = false;
}

/**
 * 长轮询围炉，拿增量消息。
 *
 * 围炉的 GET /v1/updates 返回：
 *   { updates: [{ updateId, type, chatId, chatTitle, seq, message, replyRequired }],
 *     nextCursor, hasMore, serverTime }
 * 是 events 不是 messages，别搞错。
 */
async function pollLoop(signal) {
  let cursor = loadState().cursor || 0;

  while (!signal.aborted) {
    const cfg = loadConfig();
    if (!cfg.baseUrl || !cfg.token) {
      await sleep(3000);
      continue;
    }

    try {
      const url = `${cfg.baseUrl}/v1/updates?wait=1&cursor=${cursor}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal,
      });

      if (!res.ok) {
        log('poll HTTP', res.status);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const data = await res.json();
      if (typeof data.nextCursor === 'number') cursor = data.nextCursor;

      const state = loadState();
      state.cursor = cursor;
      saveState(state);

      const updates = Array.isArray(data.updates) ? data.updates : [];
      for (const update of updates) {
        await handleCampfireUpdate(update, cfg);
      }

      // 没有新消息就停一会儿，避免空转
      if (!updates.length) await sleep(500);
    } catch (e) {
      if (signal.aborted) return;
      log('poll 异常', e.message);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/** 处理一条围炉 update：投进 Qoder 会话 */
async function handleCampfireUpdate(update, cfg) {
  if (!update || typeof update !== 'object') return;

  // 只处理新消息（编辑/删除不管）
  if (update.type && update.type !== 'message.created') return;

  // 只处理需要回应的（围炉已经算好 @ 到没到自己）
  if (!update.replyRequired) return;

  const msg = update.message || {};
  const msgId = msg.id || update.updateId;
  if (msgId && seenMessageIds.has(msgId)) return;
  if (msgId) {
    seenMessageIds.add(msgId);
    if (seenMessageIds.size > 2000) {
      const first = seenMessageIds.values().next().value;
      seenMessageIds.delete(first);
    }
  }

  const text = String(msg.text || '').trim();
  if (!text) return;

  const chatId = update.chatId || msg.chatId || 'main';
  const state = loadState();
  let sessionId = state.sessions[chatId] || cfg.sessionId || '';

  try {
    let ack;
    if (sessionId) {
      ack = await ipc.hostRequest({
        type: 'continue',
        sessionId,
        message: {
          prompt: text.slice(0, MAX_MSG_CHARS),
          displayText: text.slice(0, MAX_MSG_CHARS),
        },
      });
    } else {
      ack = await ipc.hostRequest({
        type: 'create',
        message: {
          prompt: text.slice(0, MAX_MSG_CHARS),
          displayText: text.slice(0, MAX_MSG_CHARS),
          title: `围炉${cfg.member ? ' · ' + cfg.member : ''}`,
        },
      });
      if (ack && ack.sessionId) {
        sessionId = ack.sessionId;
        state.sessions[chatId] = sessionId;
        saveState(state);
        saveConfig({ sessionId });
        log('已创建会话', sessionId);
      }
    }

    if (!ack || !ack.sessionId || !ack.turnId) {
      log('投递回执不完整', JSON.stringify(ack));
      return;
    }

    // 登记：等这个 turn 的回复
    pendingTurns.set(`${ack.sessionId}:${ack.turnId}`, {
      chatId,
      replyTo: msg.id,
    });

    // 订阅该 turn 的状态推送
    await ipc.hostRequest({
      type: 'watchState',
      sessionId: ack.sessionId,
      turnId: ack.turnId,
    });

    log('已投递并订阅', msgId, ack.turnId);
  } catch (e) {
    log('投递失败', e.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────── MCP（stdio）─────────────────────────────

/**
 * 宿主把本 worker 当 MCP Server 拉起，走 stdio 的 JSON-RPC（逐行）。
 * 只实现宿主需要的最小集合：initialize / tools/list / tools/call。
 */

const MCP_TOOLS = [
  {
    name: 'campfire_send_message',
    description: '往围炉群聊发一条消息（以该成员身份）。用于主动汇报进度或 @ 别人。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的正文（≤20000 字）' },
        replyTo: { type: 'string', description: '可选：回复某条消息的 id' },
      },
      required: ['text'],
    },
  },
];

let mcpBuffer = '';

function mcpSend(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log('MCP 写失败', e.message);
  }
}

function mcpHandleLine(line) {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req || {};

  // 通知（无 id）直接忽略
  if (id === undefined) return;

  if (method === 'initialize') {
    mcpSend({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'campfire', version: '0.1.0' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    mcpSend({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    handleToolCall(params).then((result) => {
      mcpSend({ jsonrpc: '2.0', id, result });
    }).catch((e) => {
      mcpSend({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '失败：' + e.message }], isError: true } });
    });
    return;
  }

  // ping 等
  mcpSend({ jsonrpc: '2.0', id, result: {} });
}

async function handleToolCall(params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === 'campfire_send_message') {
    const cfg = loadConfig();
    if (!cfg.baseUrl || !cfg.token) {
      return { content: [{ type: 'text', text: '围炉未配置，请先在渠道设置里填写地址与令牌。' }], isError: true };
    }
    const text = String(args.text || '').slice(0, MAX_MSG_CHARS);
    const chatId = String(args.chatId || 'main');
    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId,
        text,
        clientMsgId: `qoder-tool-${Date.now()}`,
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `发送失败 HTTP ${res.status}` }], isError: true };
    }
    return { content: [{ type: 'text', text: '已发送到围炉。' }] };
  }

  return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
}

function startMcp() {
  // stdout 是 MCP 通道，只写 JSON 帧
  process.stdout.setDefaultEncoding?.('utf8');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    mcpBuffer += chunk;
    let idx;
    while ((idx = mcpBuffer.indexOf('\n')) !== -1) {
      const line = mcpBuffer.slice(0, idx);
      mcpBuffer = mcpBuffer.slice(idx + 1);
      mcpHandleLine(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// ───────────────────────────── 启动 ─────────────────────────────

function main() {
  ensureDataDir();
  startMcp();

  // Node IPC：收宿主的帧
  process.on('message', (frame) => ipc.handle(frame));

  // 立刻握手
  ipc.sendReady();

  // 若已有配置，主动连
  const cfg = loadConfig();
  if (cfg.baseUrl && cfg.token) {
    startBridge().catch((e) => log('初始启动桥失败', e.message));
  }

  process.on('uncaughtException', (e) => log('uncaught', e?.message));
  process.on('unhandledRejection', (e) => log('unhandled', e?.message));

  log(`worker 启动 kind=${KIND} data=${DATA_DIR}`);
}

main();
