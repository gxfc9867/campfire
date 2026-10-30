/**
 * 围炉 Channel API v1 的最小客户端。
 *
 * 契约：`docs/design/CONNECTION-DRAFT.md` §4（拉取更新 / 发送 / ack / 配额）。
 * 只用全局 fetch（Node ≥ 22），**不引第三方依赖**，也不 import DSH 包，
 * 这样插件能在 profile 之外被单测直接跑。
 */

/** 统一错误：HTTP 失败、网络失败、被取消都收敛到这里，调用方只看 code。 */
export class CampfireError extends Error {
  constructor(message, { code = 'campfire_error', status = null, details = null, path = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CampfireError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.path = path;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** 长轮询额外宽限：服务端 wait 秒数之外再给网络留这么久。 */
const LONG_POLL_GRACE_MS = 15_000;

function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

/**
 * 解析围炉的错误体。
 *
 * 围炉实际返回的是扁平形状 `{ error: "人话", code: "机器码" }`（前端 `public/js/api.js` 也按这个读）；
 * 草案 §4 曾写 `{ error: { code, message } }`。两种都认，优先取结构化那种，
 * 免得服务端换形状时客户端把 `cursor_expired` 之类的关键码读丢（丢了就没法自动重拉）。
 */
function readErrorEnvelope(data) {
  if (!data || typeof data !== 'object') return {};
  const structured = data.error;
  if (structured && typeof structured === 'object') {
    return { code: structured.code, message: structured.message, details: structured.details ?? null };
  }
  return {
    code: data.code,
    message: typeof structured === 'string' ? structured : data.message,
    details: data.details ?? null,
  };
}

/**
 * @param {{
 *   baseUrl: string,
 *   token?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   log?: (level: string, message: string) => void,
 * }} options
 */
export function createCampfireClient(options = {}) {
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new TypeError('createCampfireClient: baseUrl 必填');
  const token = options.token ? String(options.token) : '';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createCampfireClient: 当前运行环境没有 fetch（需要 Node ≥ 22）');
  }
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? 'dsh-campfire/0.1';
  const log = options.log ?? (() => {});
  const closed = new AbortController();

  async function request(method, path, { query, body, timeoutMs, signal } = {}) {
    if (closed.signal.aborted) {
      throw new CampfireError(`围炉客户端已关闭，放弃 ${method} ${path}`, { code: 'aborted', path });
    }
    let url;
    try {
      url = new URL(baseUrl + path);
    } catch (error) {
      throw new CampfireError(`围炉 baseUrl 不合法：${baseUrl}`, { code: 'invalid_base_url', path, cause: error });
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const budget = timeoutMs && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
    const signals = [closed.signal, AbortSignal.timeout(budget)];
    if (signal) signals.push(signal);

    const headers = {
      accept: 'application/json',
      'user-agent': userAgent,
      'x-campfire-client': userAgent,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (isAbortError(error)) {
        const cancelled = Boolean(signal?.aborted) || closed.signal.aborted;
        throw new CampfireError(
          cancelled ? `${method} ${path} 已取消` : `${method} ${path} 超时（${budget}ms）`,
          { code: cancelled ? 'aborted' : 'timeout', path, cause: error },
        );
      }
      throw new CampfireError(`${method} ${path} 网络失败：${error?.message ?? error}`, {
        code: 'network_error',
        path,
        cause: error,
      });
    }

    const raw = await response.text().catch(() => '');
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const envelope = readErrorEnvelope(data);
      throw new CampfireError(
        `围炉 ${method} ${path} 返回 ${response.status}：${envelope.code ?? 'http_error'}${
          envelope.message ? ` ${envelope.message}` : ''
        }`,
        {
          code: envelope.code ?? `http_${response.status}`,
          status: response.status,
          details: envelope.details ?? null,
          path,
        },
      );
    }
    return data;
  }

  return {
    baseUrl,
    get closed() {
      return closed.signal.aborted;
    },

    /** `GET /v1/meta` —— 能力协商。 */
    meta: (opts) => request('GET', '/v1/meta', opts),

    /**
     * `GET /v1/updates` —— 唯一对外拉流面。
     * `wait` 是服务端长轮询秒数；这里自动把客户端超时设成 wait + 宽限。
     */
    updates: ({ chat, cursor = 0, wait = 25, limit = 100, signal, timeoutMs } = {}) =>
      request('GET', '/v1/updates', {
        query: { chat, cursor, wait, limit },
        signal,
        timeoutMs: timeoutMs ?? (Number(wait) + LONG_POLL_GRACE_MS / 1000) * 1000,
      }),

    /** `POST /v1/messages` —— 发言，`clientMsgId` 幂等。 */
    sendMessage: ({ chatId, text, type = 'text', replyTo, clientMsgId, signal } = {}) =>
      request('POST', '/v1/messages', {
        body: {
          chatId,
          text,
          type,
          ...(replyTo ? { replyTo } : {}),
          ...(clientMsgId ? { clientMsgId } : {}),
        },
        signal,
      }),

    /** `POST /v1/updates/ack` —— 推进投递游标。 */
    ack: ({ chat, cursor, signal } = {}) =>
      request('POST', '/v1/updates/ack', { body: { chat, cursor }, signal }),

    /** `GET /v1/quota` —— 背压/丢弃观测。 */
    quota: (opts) => request('GET', '/v1/quota', opts),

    /** 停掉所有在途请求（插件卸载时调用）。 */
    close(reason = 'plugin unload') {
      if (closed.signal.aborted) return;
      log('debug', `围炉客户端关闭：${reason}`);
      closed.abort();
    },
  };
}
