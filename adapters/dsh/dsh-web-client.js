import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

/**
 * 针对 DSH Web Host 的通用客户端：RPC 调用、会话续接、回合关联。
 * NAS 与电脑两端复用同一套逻辑，差异只在上层（Cookie / 隧道 / 工作区）。
 */
export class DshWebClient {
  constructor({ name, baseUrl, workspace, cookieProvider, store, intro, timeoutMs, logger, fetchImpl, pollMs = 3000 }) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.workspace = workspace;
    this.cookieProvider = cookieProvider;
    this.store = store;
    this.intro = intro;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.pollMs = pollMs;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async rpc(method, args, timeoutMs = this.timeoutMs) {
    const cookie = await this.cookieProvider();
    if (!cookie) throw new Error(`${this.name} 缺少 Cookie`);
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args },
    });
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs + 8000);
    let res;
    try {
      res = await this.fetch(this.baseUrl + '/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(`${this.name} RPC 请求失败: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`${this.name} RPC 返回非法数据 (HTTP ${res.status})`);
    }
    if (res.status === 401) throw new Error(`${this.name} Cookie 已失效`);
    const result = data && data.result;
    if (!result || result.ok !== true) {
      throw new Error(`${this.name} RPC 错误: ${JSON.stringify(result && result.error ? result.error : data).slice(0, 160)}`);
    }
    return result.value || {};
  }

  async listSessions() {
    const v = await this.rpc('session/list', { _request: {} }, 40000);
    return (v && v.items) || [];
  }

  async sessionExists(sessionId) {
    const items = await this.listSessions();
    return items.some((x) => x.sessionId === sessionId);
  }

  async ensureSession(chatId, seed) {
    const existing = this.store.getAgentSession(chatId, this.name);
    if (existing) {
      try {
        if (await this.sessionExists(existing.session_id)) return { sessionId: existing.session_id, isNew: false };
      } catch {
        // 查询失败不代表会话失效，继续使用，失败时由上层决定。
      }
    }
    const v = await this.rpc('session/create', { request: { cwd: this.workspace } });
    const sid = v && (v.sessionId || v.id);
    if (!sid) throw new Error(`${this.name} 会话创建失败`);
    this.store.saveAgentSession(chatId, this.name, sid);
    return { sessionId: sid, isNew: true, seed };
  }

  async pageText(sessionId, asOfSeq) {
    const req = { address: { kind: 'session', sessionId }, maxMessages: 200 };
    if (asOfSeq) req.throughSeq = asOfSeq;
    const page = await this.rpc('session/page', { request: req }, 40000);
    const records = (page && page.records) || [];
    const last = records
      .filter((r) => r.event && r.event.type === 'assistant/message')
      .slice(-1)[0];
    return extractText(last && last.event && last.event.data && last.event.data.message && last.event.data.message.content);
  }

  /**
   * 发送一条消息并等待该回合的完整回复。
   * 通过 requestId 精确关联本回合，避免把上一轮的旧回复当成答案。
   */
  async ask({ chatId, label, text, blocks, seed, requestId }) {
    const { sessionId, isNew } = await this.ensureSession(chatId, seed);

    // 新会话：把群聊背景与近期历史并进首条消息，避免额外的“就位”回合。
    let contentBlocks = blocks || [{ type: 'text', text: String(text) }];
    if (isNew) {
      const parts = [this.intro];
      if (seed && seed.length) {
        parts.push(
          '【近期群聊背景 · 仅供理解上下文，不必逐条回应】\n' +
            seed.map((m, i) => `${i + 1}. ${m.sender}：${m.text}`).join('\n')
        );
      }
      const preamble = parts.join('\n\n');
      contentBlocks = [{ type: 'text', text: preamble + '\n\n【当前消息】\n' + String(text) }];
    }

    const before = await this.listSessions();
    const bItem = before.find((x) => x.sessionId === sessionId);
    const bOl = (bItem && bItem.projections && bItem.projections.values && bItem.projections.values.turnOutline) || [];
    const baselineLen = bOl.length;

    const v = await this.rpc(
      'session/prompt',
      {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: contentBlocks,
          clientTimeZone: 'Asia/Shanghai',
        },
      },
      60000
    );
    if (!v || v.accepted !== true) {
      if ((contentBlocks || []).length > 1) {
        // 图片不被受理时退回纯文本，明确告知原因，不静默吞掉图片。
        return this.ask({ chatId, label, text: String(text) + '\n\n（图片未能附上：目标模型不支持图片输入）', blocks: null, seed, requestId });
      }
      throw new Error(`${this.name} 未受理会话请求`);
    }

    const deadline = Date.now() + this.timeoutMs;
    const pollMs = this.pollMs;
    while (Date.now() < deadline) {
      const items = await this.listSessions();
      const it = items.find((x) => x.sessionId === sessionId);
      if (it) {
        const ol = (it.projections && it.projections.values && it.projections.values.turnOutline) || [];
        const match = this.#matchTurn(ol, requestId, baselineLen);
        if (match) {
          const response = (match.entry && match.entry.response) || '';
          if (response && !it.running) {
            const asOfSeq = it.projections && it.projections.asOfSeq;
            const full = (await this.pageText(sessionId, asOfSeq)) || String(response);
            return { text: String(full).trim() };
          }
        }
      }
      await sleep(pollMs);
    }
    throw new Error(`${this.name} 回合超时`);
  }

  #matchTurn(ol, requestId, baselineLen) {
    // 优先精确匹配本回合 requestId。
    const idx = ol.findIndex((e) => {
      const rid = (e && e.request && e.request.requestId) || (e && e.requestId);
      return rid === requestId;
    });
    if (idx >= 0) return { entry: ol[idx] };
    // 兜底：会话串行时，基线之后新增的回合即本回合。
    if (ol.length > baselineLen) return { entry: ol[ol.length - 1] };
    return null;
  }
}
