import { AppError } from '../errors.js';

/**
 * HTTP 工具：统一的响应格式、请求体读取、Cookie 解析、限流。
 * 这里的函数都保持无状态，方便测试。
 */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(text);
}

export function sendError(res, err) {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  const code = known ? err.code : 'internal';
  if (!known) console.error('[http] 未预期错误:', err);
  sendJson(res, status, { error: known ? err.message : '服务内部错误', code });
}

/**
 * 读取并解析 JSON 请求体。
 * 必须有上限：没有上限的 readJson 是一个内存耗尽漏洞。
 */
/**
 * 读原始请求体（上传用）。
 *
 * 附件走「裸 body + 自定义头」而不是 multipart：前端 `fetch(url, {body: file})`
 * 一行就能发，服务端也不用写一遍 multipart 解析器。文件名和类型放在
 * X-Filename / Content-Type 里。
 */
export async function readBody(req, maxBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AppError(413, 'payload_too_large', `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 64 * 1024) {  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AppError(413, 'payload_too_large', `请求体超过 ${Math.round(maxBytes / 1024)} KB`);
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new AppError(400, 'bad_json', '请求体不是合法的 JSON 对象');
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * 取客户端 IP。
 * 只有明确配置了 TRUST_PROXY 才信 X-Forwarded-For——否则任何人都能伪造来源，
 * 把「按 IP 限流」变成摆设。
 */
export function clientIp(req, config) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * 简易滑动窗口限流。
 * 单进程内存实现，够用；多实例部署时应换成共享存储（本项目不做集群）。
 */
export function createLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      hits.set(key, arr);
      return true;
    }
    arr.push(now);
    hits.set(key, arr);
    // 顺手清理，防止 map 无界增长
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    }
    return false;
  };
}

/** SSE 与长轮询需要关掉缓冲，否则反代会攒着不发。 */
export function prepareStream(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.flushHeaders?.();
}
