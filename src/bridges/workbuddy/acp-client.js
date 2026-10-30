/**
 * HTTP-ACP 客户端。
 *
 * 只负责「说话」：连接、握手、加载会话、投递 prompt、解析 SSE。
 * 不做重试、不做排队、不碰数据库——那些属于 bridge 层。
 *
 * 协议要点（实测于 WorkBuddy 2.165.0）：
 * - POST /api/v1/acp/connect 建立连接，拿 connectionId；
 * - 之后的 JSON-RPC 都走 POST /api/v1/acp，响应是 SSE；
 * - 必须带 Accept: application/json, text/event-stream，否则 406；
 * - 必须带 acp-connection-id 头。
 */
export class AcpError extends Error {
  constructor(message, { code = 'acp_error', status = 0, detail = null } = {}) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export class AcpClient {
  constructor({ baseUrl, password, timeoutMs = 180_000 }) {
    if (!baseUrl) throw new Error('AcpClient 需要 baseUrl');
    if (!password) throw new Error('AcpClient 需要 password');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.connectionId = null;
    this.nextId = 1;
  }

  headers(extra = {}) {
    return {
      'x-codebuddy-request': '1',
      Authorization: `Bearer ${this.password}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.connectionId ? { 'acp-connection-id': this.connectionId } : {}),
      ...extra,
    };
  }

  async connect() {
    const res = await this.fetchJson('/api/v1/acp/connect', { method: 'POST' });
    const id = res?.connectionId || res?.data?.connectionId;
    if (!id) throw new AcpError('connect 未返回 connectionId', { code: 'acp_connect_failed', detail: res });
    this.connectionId = id;
    return id;
  }

  async initialize(clientInfo = { name: 'campfire', version: '1' }) {
    return this.rpc('initialize', {
      protocolVersion: 1,
      clientInfo,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
  }

  async loadSession({ sessionId, cwd }) {
    return this.rpc('session/load', { sessionId, cwd, mcpServers: [] });
  }

  /**
   * 投递一轮对话。
   * @returns {{stopReason:string, texts:string[], raw:object|null}}
   */
  async prompt({ sessionId, text, timeoutMs }) {
    const out = await this.rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs ?? this.timeoutMs);
    return out;
  }

  async rpc(method, params, timeoutMs = this.timeoutMs) {
    if (!this.connectionId) throw new AcpError('尚未 connect', { code: 'acp_not_connected' });
    const id = this.nextId++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/acp`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e?.name === 'AbortError';
      throw new AcpError(aborted ? `请求超时：${method}` : `请求失败：${e.message}`, {
        code: aborted ? 'acp_timeout' : 'acp_network',
      });
    }
    clearTimeout(timer);

    const body = await res.text();
    if (res.status === 406) {
      throw new AcpError('服务端要求同时接受 json 与 event-stream', { code: 'acp_not_acceptable', status: 406 });
    }
    if (res.status === 401 || res.status === 403) {
      throw new AcpError('网关口令无效', { code: 'acp_unauthorized', status: res.status });
    }
    if (!res.ok) {
      throw new AcpError(`ACP 返回 ${res.status}`, { code: 'acp_http_error', status: res.status, detail: body.slice(0, 300) });
    }

    return parseSse(body, method);
  }

  async fetchJson(pathname, init = {}) {
    const res = await fetch(this.baseUrl + pathname, { ...init, headers: this.headers() });
    const text = await res.text();
    if (!res.ok) {
      throw new AcpError(`请求失败 ${res.status}`, { code: 'acp_http_error', status: res.status, detail: text.slice(0, 300) });
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new AcpError('响应不是 JSON', { code: 'acp_bad_json', detail: text.slice(0, 300) });
    }
  }
}

/**
 * 解析 SSE 响应体。
 * 只关心两类：agent_message_chunk 的文本增量、最终 result/error。
 */
export function parseSse(body, method = '') {
  const texts = [];
  let result = null;
  let error = null;

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update || {};
      if (u.sessionUpdate === 'agent_message_chunk') {
        const t = u.content?.text ?? u.delta?.text ?? '';
        if (t) texts.push(t);
      }
      continue;
    }
    if (msg.result && typeof msg.result === 'object') result = msg.result;
    if (msg.error) error = msg.error;
  }

  if (error) {
    const err = new AcpError(error.message || 'ACP 返回错误', {
      code: error.code === -32000 ? mapBizCode(error) : 'acp_rpc_error',
      detail: error.data,
    });
    throw err;
  }

  const stopReason = result?.stopReason || null;
  return { stopReason, texts, raw: result, method };
}

/** 把 -32000 的业务错误翻成稳定错误码，便于桥做降级判断。 */
function mapBizCode(error) {
  const msg = String(error?.data?.details || error?.message || '');
  if (/Authentication required/i.test(msg)) return 'acp_auth_required';
  if (/模型|model/i.test(msg)) return 'acp_model_error';
  return 'acp_rpc_error';
}
