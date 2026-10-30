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
  constructor({ baseUrl, password, timeoutMs = 180_000, log = null }) {
    if (!baseUrl) throw new Error('AcpClient 需要 baseUrl');
    if (!password) throw new Error('AcpClient 需要 password');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.log = log;
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
      // 不声明 fs/terminal 能力：一旦声明，codebuddy 会把工具执行/批准请求发给 host，
      // 桥不执行工具就会一直卡到超时。留空则工具由会话自己用内置实现跑，
      // 桥只做消息管道——这正是我们要的分工。
      clientCapabilities: {},
    });
  }

  async loadSession({ sessionId, cwd }) {
    return this.rpc('session/load', { sessionId, cwd, mcpServers: [] });
  }

  /**
   * 切换权限模式。bypassPermissions = 工具自动执行，不再等 host 批准。
   * 桥不执行任何工具，工具跑在会话侧——这正是「桥只传信息」的关键一环。
   */
  async setMode({ sessionId, modeId = 'bypassPermissions' }) {
    return this.rpc('session/set_mode', { sessionId, modeId });
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

    // 状态码先判，避免把错误页当 SSE 解析
    if (res.status === 406) {
      clearTimeout(timer);
      throw new AcpError('服务端要求同时接受 json 与 event-stream', { code: 'acp_not_acceptable', status: 406 });
    }
    if (res.status === 401 || res.status === 403) {
      clearTimeout(timer);
      throw new AcpError('网关口令无效', { code: 'acp_unauthorized', status: res.status });
    }
    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      throw new AcpError(`ACP 返回 ${res.status}`, { code: 'acp_http_error', status: res.status, detail: text.slice(0, 300) });
    }

    // 关键：流式读 SSE。模型调工具前会发 control_request 要 host 批准，
    // 不回它就永远卡在等批准（180s 超时）。边读边自动放行，工具仍由会话自己执行。
    try {
      const out = await this.readSseStream(res, method);
      clearTimeout(timer);
      return out;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof AcpError) throw e;
      const aborted = e?.name === 'AbortError';
      throw new AcpError(aborted ? `请求超时：${method}` : `读取响应失败：${e.message}`, {
        code: aborted ? 'acp_timeout' : 'acp_network',
      });
    }
  }

  /**
   * 流式解析 SSE。
   * - agent_message_chunk → 累积文本
   * - control_request     → 自动放行（工具由会话执行，桥只做管道）
   * - result / error      → 本轮结束
   */
  async readSseStream(res, method) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const texts = [];
    let result = null;
    let error = null;
    let settled = false;

    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'control_request') {
        void this.answerControlRequest(msg);
        return;
      }
      if (msg.type === 'control_response') return;
      if (msg.method === 'session/update') {
        const u = msg.params?.update || {};
        if (u.sessionUpdate === 'agent_message_chunk') {
          const t = u.content?.text ?? u.delta?.text ?? '';
          if (t) texts.push(t);
        }
        return;
      }
      if (msg.result && typeof msg.result === 'object') {
        result = msg.result;
        settled = true;
      }
      if (msg.error) {
        error = msg.error;
        settled = true;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, idx).replace(/\r$/, ''));
          buf = buf.slice(idx + 1);
        }
        if (settled) break; // 拿到结果就收尾，不依赖服务端关流
      }
      if (!settled && buf) handleLine(buf.replace(/\r$/, ''));
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 已经结束
      }
    }

    if (error) {
      throw new AcpError(error.message || 'ACP 返回错误', {
        code: error.code === -32000 ? mapBizCode(error) : 'acp_rpc_error',
        detail: error.data,
      });
    }

    return { stopReason: result?.stopReason || null, texts, raw: result, method };
  }

  /** 回应工具批准请求：一律放行；执行仍在会话侧，桥不碰任何工具。 */
  async answerControlRequest(msg) {
    const requestId = msg.request_id;
    if (!requestId) return;
    const subtype = msg.request?.subtype;
    const payload = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: subtype === 'can_use_tool' ? { allowed: true, reason: 'campfire bridge auto-approve' } : {},
      },
    };
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/acp`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) this.log?.warn?.(`[workbuddy] 控制请求应答 ${res.status}`);
    } catch (e) {
      this.log?.warn?.(`[workbuddy] 控制请求应答失败：${e.message}`);
    }
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
