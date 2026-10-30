'use strict';

/**
 * mock 围炉 —— 零依赖、纯内存的 /v1 API 服务，只服务一个目的：
 * 让 dsh-campfire 插件能在没有真围炉、没有网络的情况下被单测和端到端验收。
 *
 * 用法（单测）：
 *   const { createMockCampfire } = require('./mock-campfire.cjs');
 *   const mock = createMockCampfire({ token: 'dev-token' });
 *   const { baseUrl } = await mock.start(0);   // port=0 让系统分配
 *   ...
 *   await mock.stop();
 *
 * 用法（人工验收）：见 docs/probes/campfire-mock.cjs
 *
 * 设计取舍：
 *   - 全内存，不落盘，进程退出即丢。mock 不需要持久化。
 *   - 长轮询是「挂起 res + 事件唤醒」，不是定时轮询，所以 wait=25 时 CPU 空转率为零。
 *   - 只认 Authorization: Bearer <token>，用 crypto.timingSafeEqual 比较。
 *   - 默认安静（options.quiet === false 才打印），避免污染 npm test 的输出。
 *   - 出站消息（插件自己发的）不产生 update：本 mock 是单成员视角，
 *     让插件收到自己的消息会造成自激。inject 的入站消息才产生 update。
 *
 * 只依赖 Node 内置模块。要求 Node >= 22（本仓库 engines 要求 >= 22.5）。
 */

const http = require('node:http');
const crypto = require('node:crypto');

// ── 契约常量 ────────────────────────────────────────────────────────────
const API_VERSION = 1;
const API_VERSION_HEADER = 'X-Campfire-Api-Version';

/** 请求体上限：超过直接 413，不缓冲。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 长轮询默认/上限秒数（契约：默认 25，上限 30）。 */
const DEFAULT_WAIT_SEC = 25;
const MAX_WAIT_SEC = 30;

/** 单次返回的 update 条数（契约：默认 100）。 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** /v1/meta 里声明的能力集。 */
const MESSAGE_TYPES = ['text', 'markdown', 'system'];
const WAKEUP_MODES = ['none', 'notify', 'reply'];
const COALESCE = { windowMs: 30000, maxItems: 20 };
// 契约未给具体数值，这里取一组自洽的占位值；插件只需要「字段存在且是数字」。
const ATTACHMENT_MAX_SIZE = 25 * 1024 * 1024;
const ATTACHMENT_SIGNED_URL_TTL = 600;
const QUEUE_LIMIT = 1000;

// ── 小工具 ──────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const nextMessageId = () => `msg_${randomHex(8)}`;
const nextTraceId = () => `trc_${randomHex(8)}`;

/** 构造一个带 status/code 的错误，交给顶层统一转成 JSON。 */
function httpError(status, code, message, details = null) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

/** 定长安全比较，避免 token 被逐字节计时探测。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function clampNumber(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function clampInt(raw, fallback, min, max) {
  return Math.trunc(clampNumber(raw, fallback, min, max));
}

/**
 * 从文本里粗提 @handle。
 * 只在调用方没显式传 mentions 时兜底，让 `inject({ text: '@facai 在吗' })` 就能触发 reply。
 */
function extractMentions(text) {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const out = [];
  const re = /@([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
  let hit;
  while ((hit = re.exec(text)) !== null) out.push(hit[1]);
  return out;
}

/** mentions 元素可能是字符串（handle）或对象（{handle|id|name|display}）。 */
function mentionMatches(entry, handle) {
  if (entry === null || entry === undefined) return false;
  if (typeof entry === 'string') return entry.replace(/^@/, '') === handle;
  if (typeof entry === 'object') {
    return (
      entry.handle === handle ||
      entry.id === handle ||
      entry.name === handle ||
      entry.display === handle
    );
  }
  return false;
}

// ── 主体 ────────────────────────────────────────────────────────────────

/**
 * 创建一个 mock 围炉实例（尚未监听）。
 *
 * @param {object} [options]
 * @param {string} [options.token='dev-token']           Bearer token，必须匹配
 * @param {string} [options.memberHandle='facai']        被 mock 的成员 handle
 * @param {string} [options.memberDisplay='发财']        被 mock 的成员显示名
 * @param {string} [options.chatId='main']               默认 chat
 * @param {boolean} [options.quiet]                      false 时才打印日志；默认安静
 */
function createMockCampfire(options = {}) {
  const token = String(options.token || 'dev-token');
  const memberHandle = String(options.memberHandle || 'facai');
  const memberDisplay = String(options.memberDisplay || '发财');
  const defaultChatId = String(options.chatId || 'main');
  const verbose = options.quiet === false;

  // ── 内存状态 ──────────────────────────────────────────────────────────
  /** chatId -> { id, seq, updates: [], acks: Map<handle, cursor> } */
  const chats = new Map();
  /** 插件通过 POST /v1/messages 发回来的消息，按插入（= seq）顺序。 */
  const outboxMessages = [];
  /** `${chatId}\0${clientMsgId}` -> message，幂等用。 */
  const clientMsgIds = new Map();
  /** 当前挂起的长轮询请求。 */
  const polls = new Set();

  let server = null;
  let listeningPort = 0;
  let baseUrl = '';

  function log(...args) {
    if (verbose) console.log('[mock-campfire]', ...args);
  }

  // ── 状态读写 ──────────────────────────────────────────────────────────

  function ensureChat(chatId) {
    let chat = chats.get(chatId);
    if (!chat) {
      chat = { id: chatId, seq: 0, updates: [], acks: new Map() };
      chats.set(chatId, chat);
    }
    return chat;
  }

  /** 显式给了数组就用它（空数组也尊重），没给才从文本兜底提取。 */
  function normalizeMentions(input, text) {
    if (Array.isArray(input)) return input.slice();
    return extractMentions(text);
  }

  function computeWakeup(message) {
    if (message.type === 'system') return 'none';
    const hit = message.mentions.some((m) => mentionMatches(m, memberHandle));
    return hit ? 'reply' : 'notify';
  }

  /**
   * 落一条消息并（可选）生成对应 update。
   * @param {string} chatId
   * @param {object} spec   { sender, type, text, replyTo, mentions }
   * @param {object} [flags] { broadcast=true }  false 表示不产生 update（出站消息用）
   */
  function pushMessage(chatId, spec, flags = {}) {
    const chat = ensureChat(chatId);
    chat.seq += 1;
    const seq = chat.seq;

    const message = {
      id: nextMessageId(),
      chatId,
      seq,
      sender: spec.sender,
      type: spec.type || 'text',
      text: spec.text,
      attachments: [],
      replyTo: spec.replyTo === undefined ? null : spec.replyTo,
      mentions: Array.isArray(spec.mentions) ? spec.mentions.slice() : [],
      createdAt: nowIso(),
      editedAt: null,
      deletedAt: null,
    };

    let update = null;
    if (flags.broadcast !== false) {
      const wakeup = computeWakeup(message);
      update = {
        updateId: `${chatId}:${seq}`,
        type: 'message.created',
        chatId,
        seq,
        message,
        wakeup,
        replyRequired: wakeup === 'reply',
      };
      chat.updates.push(update);
    }

    return { message, update };
  }

  // ── 长轮询 ────────────────────────────────────────────────────────────

  /**
   * 尝试给一个挂起的轮询写响应。
   * 没有新 update 且没到 wait 时限时静默返回，继续挂起。
   */
  function flushPoll(entry) {
    if (entry.done) return;

    const chat = ensureChat(entry.chatId);
    const fresh = chat.updates.filter((u) => u.seq > entry.cursor);
    if (!fresh.length && !entry.timedOut) return;

    const slice = fresh.slice(0, entry.limit);
    const hasMore = fresh.length > slice.length;
    const nextCursor = slice.length ? slice[slice.length - 1].seq : entry.cursor;

    entry.done = true;
    polls.delete(entry);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    const res = entry.res;
    if (res.writableEnded || res.destroyed) return;

    sendJson(res, 200, {
      updates: slice,
      nextCursor,
      hasMore,
      serverTime: nowIso(),
    });
  }

  /** 客户端提前断开：摘掉这个挂起请求，别让 timer 泄漏。 */
  function abortPoll(entry) {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    polls.delete(entry);
  }

  /** 新消息到达：把所有匹配的挂起轮询立刻推出去。 */
  function pump() {
    if (!polls.size) return;
    for (const entry of [...polls]) flushPoll(entry);
  }

  // ── HTTP 基础 ─────────────────────────────────────────────────────────

  function sendJson(res, status, payload) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.setHeader(API_VERSION_HEADER, String(API_VERSION));
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  function sendError(res, status, code, message, details = null) {
    sendJson(res, status, {
      error: { code, message, details, traceId: nextTraceId() },
    });
  }

  /**
   * 读完整个请求体（上限 MAX_BODY_BYTES）。
   * 超限后不 destroy socket、也不提前响应，而是继续把剩余字节排空再回 413 ——
   * 提前响应会让客户端拿到 socket hang up 而不是那句 JSON。
   */
  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let overLimit = false;
      let settled = false;

      req.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          overLimit = true;
          chunks.length = 0; // 不再占内存，后续字节只做排空
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (settled) return;
        settled = true;
        if (overLimit) {
          reject(
            httpError(413, 'payload_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节上限`),
          );
          return;
        }
        resolve(Buffer.concat(chunks));
      });

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  /** 严格 JSON 解析：非法 JSON / 非对象一律 400。 */
  async function readJsonBody(req) {
    const raw = await readRawBody(req);
    if (!raw.length) return {};
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw httpError(400, 'bad_request', '请求体不是合法 JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw httpError(400, 'bad_request', '请求体必须是 JSON 对象');
    }
    return parsed;
  }

  function isAuthorized(req) {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return safeEqual(match[1].trim(), token);
  }

  function readString(value, fallback) {
    return typeof value === 'string' && value.length ? value : fallback;
  }

  // ── 业务处理 ──────────────────────────────────────────────────────────

  /** GET /v1/meta */
  function handleMeta(req, res) {
    sendJson(res, 200, {
      apiVersion: API_VERSION,
      serverTime: nowIso(),
      capabilities: {
        messageTypes: MESSAGE_TYPES.slice(),
        cursor: 'seq',
        wakeup: WAKEUP_MODES.slice(),
        coalesce: { ...COALESCE },
        attachments: {
          maxSize: ATTACHMENT_MAX_SIZE,
          signedUrlTtl: ATTACHMENT_SIGNED_URL_TTL,
        },
        editDelete: true,
        search: { vector: false, keyword: true },
      },
    });
  }

  /** GET /v1/updates —— 长轮询 */
  function handleUpdates(req, res, url) {
    const chatId = readString(url.searchParams.get('chat'), defaultChatId);
    const cursor = clampInt(url.searchParams.get('cursor'), 0, 0, Number.MAX_SAFE_INTEGER);
    const waitSec = clampNumber(url.searchParams.get('wait'), DEFAULT_WAIT_SEC, 0, MAX_WAIT_SEC);
    const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);

    const entry = { chatId, cursor, limit, res, timer: null, done: false, timedOut: false };
    polls.add(entry);
    res.on('close', () => abortPoll(entry));

    // 已经有货（或 wait=0）就立刻返回；否则挂起等 pump() 或 timer。
    flushPoll(entry);
    if (entry.done) return;

    if (waitSec <= 0) {
      entry.timedOut = true;
      flushPoll(entry);
      return;
    }

    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      flushPoll(entry);
    }, Math.round(waitSec * 1000));
    // 挂起期间不该阻止进程退出
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  /** POST /v1/messages —— 插件发消息，clientMsgId 幂等 */
  async function handlePostMessage(req, res) {
    const body = await readJsonBody(req);

    const chatId = readString(body.chatId, defaultChatId);
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw httpError(400, 'bad_request', 'text 不能为空');

    const type = readString(body.type, 'text');
    const replyTo = typeof body.replyTo === 'string' ? body.replyTo : null;
    const clientMsgId = readString(body.clientMsgId, null);

    // 幂等：同一 clientMsgId 直接回原来那条，不新增 seq
    if (clientMsgId) {
      const cached = clientMsgIds.get(`${chatId}\u0000${clientMsgId}`);
      if (cached) {
        log('幂等命中', chatId, clientMsgId);
        sendJson(res, 201, { message: cached });
        return;
      }
    }

    const { message } = pushMessage(
      chatId,
      {
        sender: { kind: 'member', handle: memberHandle, display: memberDisplay },
        type,
        text,
        replyTo,
        mentions: Array.isArray(body.mentions) ? body.mentions : [],
      },
      { broadcast: false }, // 出站消息不回头喂给自己
    );

    outboxMessages.push(message);
    if (clientMsgId) clientMsgIds.set(`${chatId}\u0000${clientMsgId}`, message);

    log('出站', message.id, `${chatId}:${message.seq}`);
    sendJson(res, 201, { message });
  }

  /** POST /v1/updates/ack —— cursor 只前进不后退 */
  async function handleAck(req, res) {
    const body = await readJsonBody(req);
    const chatId = readString(body.chat, defaultChatId);
    const cursor = clampInt(body.cursor, 0, 0, Number.MAX_SAFE_INTEGER);

    const chat = ensureChat(chatId);
    const prev = chat.acks.get(memberHandle) ?? 0;
    const next = Math.max(prev, cursor);
    chat.acks.set(memberHandle, next);

    sendJson(res, 200, { ok: true, cursor: next });
  }

  /** GET /v1/quota —— pending 统计「已产生但还没 ack 的 update」 */
  function handleQuota(req, res) {
    let pending = 0;
    let oldestPendingAt = null;

    for (const chat of chats.values()) {
      const ackCursor = chat.acks.get(memberHandle) ?? 0;
      const rest = chat.updates.filter((u) => u.seq > ackCursor);
      pending += rest.length;
      if (rest.length) {
        const at = rest[0].message.createdAt;
        if (!oldestPendingAt || at < oldestPendingAt) oldestPendingAt = at;
      }
    }

    sendJson(res, 200, {
      pending,
      oldestPendingAt,
      dropped: { count: 0, oldestAt: null },
      limits: { queue: QUEUE_LIMIT },
    });
  }

  /** POST /mock/inject —— 造一条入站消息并唤醒长轮询 */
  async function handleInject(req, res) {
    const body = await readJsonBody(req);
    const result = injectMessage({
      chatId: body.chatId,
      text: body.text,
      type: body.type,
      senderHandle: body.senderHandle,
      senderDisplay: body.senderDisplay,
      mentions: body.mentions,
    });
    sendJson(res, 200, { message: result.message });
  }

  /** GET /mock/outbox —— 插件发回来的消息，seq 升序 */
  function handleOutbox(req, res) {
    sendJson(res, 200, outbox());
  }

  /** POST /mock/reset —— 清空一切 */
  function handleReset(req, res) {
    reset();
    sendJson(res, 200, { ok: true });
  }

  // ── 路由表 ────────────────────────────────────────────────────────────
  // 先按「方法 + 路径」匹配，匹配不到直接 404；匹配到才查 Bearer。
  // 这样未鉴权访问未知路由拿到的是 404 而不是 401，符合契约里两条独立描述。
  const ROUTES = [
    { method: 'GET', path: '/v1/meta', handler: handleMeta },
    { method: 'GET', path: '/v1/updates', handler: handleUpdates },
    { method: 'POST', path: '/v1/messages', handler: handlePostMessage },
    { method: 'POST', path: '/v1/updates/ack', handler: handleAck },
    { method: 'GET', path: '/v1/quota', handler: handleQuota },
    { method: 'POST', path: '/mock/inject', handler: handleInject },
    { method: 'GET', path: '/mock/outbox', handler: handleOutbox },
    { method: 'POST', path: '/mock/reset', handler: handleReset },
  ];

  async function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendError(res, 400, 'bad_request', '请求路径无法解析');
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';

    const route = ROUTES.find((r) => r.method === method && r.path === path);
    if (!route) {
      sendError(res, 404, 'not_found', `没有这个路由：${method} ${path}`);
      return;
    }

    if (!isAuthorized(req)) {
      sendError(res, 401, 'unauthorized', '缺少或无效的 Bearer token');
      return;
    }

    await route.handler(req, res, url);
  }

  // ── 对外 API ──────────────────────────────────────────────────────────

  /** 造一条入站消息（sender.kind = "user"）并唤醒长轮询。 */
  function injectMessage(input, maybeText) {
    const spec =
      typeof input === 'string'
        ? { text: input }
        : input && typeof input === 'object'
          ? input
          : {};
    const text =
      typeof spec.text === 'string'
        ? spec.text
        : typeof maybeText === 'string'
          ? maybeText
          : '';
    if (!text.trim()) throw new Error('injectMessage 需要非空 text');

    const chatId = readString(spec.chatId, defaultChatId);
    const type = readString(spec.type, 'text');
    const senderHandle = readString(spec.senderHandle, '恭喜');
    const senderDisplay = readString(spec.senderDisplay, senderHandle);
    const mentions = normalizeMentions(spec.mentions, text);

    const { message, update } = pushMessage(
      chatId,
      {
        sender: { kind: 'user', handle: senderHandle, display: senderDisplay },
        type,
        text,
        replyTo: null,
        mentions,
      },
      { broadcast: true },
    );

    log('入站', message.id, `${chatId}:${message.seq}`, update ? update.wakeup : '-');
    pump();
    return { message, update };
  }

  /** 插件发回来的消息快照，seq 升序。 */
  function outbox() {
    return { messages: outboxMessages.slice().sort((a, b) => a.seq - b.seq) };
  }

  /** 清空所有状态；挂起的长轮询立刻拿到空响应。 */
  function reset() {
    chats.clear();
    outboxMessages.length = 0;
    clientMsgIds.clear();
    for (const entry of [...polls]) {
      entry.timedOut = true;
      flushPoll(entry);
    }
    polls.clear();
    log('reset');
  }

  /** 开始监听 127.0.0.1。port=0 由系统分配，从返回值里取真实端口。 */
  async function start(port = 0) {
    if (server) throw new Error('mock campfire 已经启动了，先 stop()');
    const s = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        if (res.writableEnded || res.destroyed) return;
        if (err && typeof err.status === 'number') {
          sendError(res, err.status, err.code || 'error', err.message, err.details ?? null);
        } else {
          log('未捕获异常', err && err.stack ? err.stack : err);
          sendError(res, 500, 'internal', 'mock campfire 内部错误');
        }
      });
    });

    // 客户端发了畸形 HTTP：给个 400 然后关掉，别让 mock 自己崩。
    s.on('clientError', (err, socket) => {
      if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      s.once('error', onError);
      s.listen(port, '127.0.0.1', () => {
        s.removeListener('error', onError);
        resolve();
      });
    });

    server = s;
    const addr = s.address();
    listeningPort = addr && typeof addr === 'object' ? addr.port : port;
    baseUrl = `http://127.0.0.1:${listeningPort}`;
    log('listening on', baseUrl);
    return { port: listeningPort, baseUrl };
  }

  /** 干净关闭：先放掉所有挂起的长轮询，再关连接，不留 handle。 */
  async function stop() {
    if (!server) return;
    const s = server;
    server = null;

    // 1) 挂起的轮询立刻拿到空响应，客户端不会干等
    for (const entry of [...polls]) {
      entry.timedOut = true;
      flushPoll(entry);
    }
    polls.clear();

    // 2) 停止接受新连接
    const closed = new Promise((resolve) => {
      s.close(() => resolve());
    });

    // 3) 给刚写出去的空响应一点 flush 时间，再断掉空闲的 keep-alive 连接
    const sweeper = setTimeout(() => {
      if (typeof s.closeIdleConnections === 'function') s.closeIdleConnections();
    }, 50);
    if (typeof sweeper.unref === 'function') sweeper.unref();

    // 4) 兜底：1s 还没关干净就强制断开
    const killer = setTimeout(() => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    }, 1000);
    if (typeof killer.unref === 'function') killer.unref();

    await closed;
    clearTimeout(sweeper);
    clearTimeout(killer);

    log('已停止', baseUrl);
    listeningPort = 0;
    baseUrl = '';
  }

  return {
    start,
    stop,
    injectMessage,
    outbox,
    reset,
    get port() {
      return listeningPort;
    },
    get baseUrl() {
      return baseUrl;
    },
  };
}

module.exports = { createMockCampfire };
