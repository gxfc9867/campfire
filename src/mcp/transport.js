import crypto from 'node:crypto';
import {
  RPC_ERROR,
  SUPPORTED_PROTOCOL_VERSIONS,
  isNotification,
  isRequest,
  isResponse,
  rpcError,
} from './protocol.js';

/**
 * MCP 的 streamable HTTP 传输层。
 *
 * 只负责「HTTP 语义」这一层：
 *   请求体解析 → 鉴权 → 会话（Mcp-Session-Id）→ JSON-RPC 分帧 → 回包（JSON 或 SSE）
 * 具体某个方法怎么实现，全部交给 server.js 的 dispatch。
 *
 * 端点行为（与 MCP 规范一致）：
 *   POST /mcp    客户端发请求/通知；请求回 JSON 或 SSE，纯通知回 202
 *   GET  /mcp    本服务端不提供服务端主动推送的 SSE 流，按规范回 405
 *   DELETE /mcp  结束会话，回 204
 *
 * 为什么 GET 直接 405 而不是挂一条 SSE：
 * 围炉的「推送」是长轮询 + 唤醒（Channel API 的活），MCP 面只做请求-响应。
 * 挂一条永远不说话的 SSE 只会让客户端以为有推送能力，属于骗人。
 */

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 30 * 60_000;

/** 会话表。内存实现：MCP 客户端本来就是短连接，重启丢会话是规范允许的。 */
export function createSessionStore({ ttlMs = SESSION_TTL_MS } = {}) {
  const sessions = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeenAt > ttlMs) sessions.delete(id);
  }, 60_000);
  timer.unref?.();

  return {
    create({ protocolVersion, clientInfo } = {}) {
      const id = crypto.randomUUID();
      sessions.set(id, { id, protocolVersion: protocolVersion || null, clientInfo: clientInfo || null, createdAt: Date.now(), lastSeenAt: Date.now() });
      return id;
    },
    get(id) {
      const s = sessions.get(id);
      if (!s) return null;
      s.lastSeenAt = Date.now();
      return s;
    },
    delete(id) {
      return sessions.delete(id);
    },
    get size() {
      return sessions.size;
    },
    close() {
      clearInterval(timer);
      sessions.clear();
    },
  };
}

/** 读请求体，超限抛 413。自己写而不是用 http/util 的 readJson：这里要的是 JSON-RPC 错误码，不是 HTTP 业务错误。 */
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error(`请求体超过 ${Math.round(maxBytes / 1024)} KB`);
      err.code = 'payload_too_large';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/**
 * 单条 SSE 回包。
 * 规范允许服务端对 POST 回 `text/event-stream`；这里只在客户端**明确不接受**
 * application/json 时才用——能回 JSON 就回 JSON，解析路径最短。
 */
function sendSse(res, payload, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...headers,
  });
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

function wantsSse(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

export function createMcpTransport({ path = '/mcp', basePath = '', auth, sessions, dispatch, log, maxBodyBytes = MAX_BODY_BYTES }) {
  const endpoint = `${basePath}${path}`;

  function authFailure(res) {
    // 不区分「没带令牌」和「令牌不对」，避免变成探测钥匙是否存在的接口
    sendJson(res, 401, rpcError(null, RPC_ERROR.unauthorized, '缺少或无效的 Bearer 令牌'), {
      'WWW-Authenticate': 'Bearer realm="campfire-mcp"',
    });
  }

  async function handlePost(req, res, identity) {
    let raw;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (e) {
      sendJson(res, 413, rpcError(null, RPC_ERROR.invalidRequest, e.message));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, rpcError(null, RPC_ERROR.parseError, '请求体不是合法 JSON'));
      return;
    }

    const batch = Array.isArray(parsed);
    const messages = batch ? parsed : [parsed];
    if (messages.length === 0) {
      sendJson(res, 400, rpcError(null, RPC_ERROR.invalidRequest, '空的批量请求'));
      return;
    }
    if (messages.some((m) => !m || typeof m !== 'object')) {
      sendJson(res, 400, rpcError(null, RPC_ERROR.invalidRequest, '报文必须是 JSON 对象'));
      return;
    }

    // 新版客户端的「能力探测」必须先于版本校验与会话校验处理：
    // 它带的是 2026 世代的版本头、也没有会话，按普通请求判会被 400 挡掉。
    // 规范允许服务端不支持 discover，回一条 -32601 即可，客户端会自动回退到 initialize。
    if (messages.length === 1 && messages[0]?.method === 'server/discover') {
      sendJson(res, 200, rpcError(messages[0].id ?? null, RPC_ERROR.methodNotFound, '不支持 server/discover，请用 initialize 握手'));
      return;
    }

    // 客户端在 initialize 之后的每个请求上都该带版本头；带了就必须是我们认识的
    const declared = String(req.headers['mcp-protocol-version'] || '').trim();
    if (declared && !SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
      sendJson(
        res,
        400,
        rpcError(null, RPC_ERROR.invalidRequest, `不支持的协议版本：${declared}`, {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
        }),
      );
      return;
    }

    const headerSessionId = String(req.headers['mcp-session-id'] || '').trim();
    const responses = [];
    let issuedSessionId = null;

    for (const msg of messages) {
      if (isResponse(msg)) {
        // 客户端不该给我们发响应；忽略比报错更宽容，也避免把它的 id 空间搅乱
        continue;
      }
      if (!isRequest(msg) && !isNotification(msg)) {
        responses.push(rpcError(msg?.id ?? null, RPC_ERROR.invalidRequest, '缺少 method 字段'));
        continue;
      }

      const isInit = msg.method === 'initialize';
      // 会话是「可发但不强制」的：
      // 我们会在 initialize 时签发 Mcp-Session-Id，但绝不因为「没带」或「过期」拒请求。
      // 理由是实测过的客户端行为——会话过期回 404 时，客户端不会重新握手，
      // 而是一直带着同一个失效 id 重试，等于把连接永久打死。
      // 本服务端本来就没有会话级状态，放行比严格更可靠（规范允许服务端不要求会话）。
      const session = headerSessionId ? sessions.get(headerSessionId) : null;
      if (headerSessionId && !session) {
        log?.debug?.(`未知会话 ${headerSessionId.slice(0, 8)}…，按无会话处理`);
      }

      let reply;
      try {
        reply = await dispatch(msg, { identity, session, isInit });
      } catch (e) {
        log?.warn?.(`MCP 处理失败 ${msg.method}：${e.message}`);
        if (isRequest(msg)) {
          responses.push(
            rpcError(msg.id, e.rpcCode || RPC_ERROR.internalError, e.message || '服务内部错误', e.rpcData),
          );
        }
        continue;
      }

      if (isInit && reply && !reply.error) {
        issuedSessionId = sessions.create({
          protocolVersion: reply.result?.protocolVersion,
          clientInfo: msg.params?.clientInfo,
        });
      }
      // 通知（无 id）不回包；请求回包
      if (isRequest(msg) && reply) responses.push(reply);
    }

    const headers = {};
    if (issuedSessionId) headers['Mcp-Session-Id'] = issuedSessionId;

    if (responses.length === 0) {
      // 全是通知：按规范回 202，无响应体
      res.writeHead(202, { 'Cache-Control': 'no-store', ...headers });
      res.end();
      return;
    }

    const payload = batch ? responses : responses[0];
    if (wantsSse(req)) sendSse(res, payload, headers);
    else sendJson(res, 200, payload, headers);
  }

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname !== endpoint && pathname !== `${endpoint}/`) {
      sendJson(res, 404, rpcError(null, RPC_ERROR.invalidRequest, `MCP 端点是 ${endpoint}`));
      return;
    }

    const identity = auth.identify(req);
    if (!identity) {
      authFailure(res);
      return;
    }

    const method = req.method || 'GET';
    if (method === 'POST') {
      await handlePost(req, res, identity);
      return;
    }
    if (method === 'DELETE') {
      const id = String(req.headers['mcp-session-id'] || '').trim();
      if (id) sessions.delete(id);
      // 幂等：会话本来就不存在也回 204，客户端不该因为「关两次」而报错
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      // 不提供服务端推送流；规范允许用 405 明确拒绝
      res.writeHead(405, { Allow: 'POST, DELETE', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(405, { Allow: 'POST, DELETE' });
    res.end();
  };
}
