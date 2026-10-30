/**
 * 群摘要。
 *
 * 输入：某会话自上次摘要之后的新消息；输出：一段滚动摘要 + 覆盖到的 seq。
 * 设计成「注入 complete 函数」而不是直连 HTTP：测试不需要网络，换模型也不改逻辑。
 */
export class Summarizer {
  constructor({ store, complete, model = 'unknown', minMessages = 20, maxBatch = 100, maxChars = 8000 }) {
    if (!store) throw new Error('Summarizer 需要 store');
    if (typeof complete !== 'function') throw new Error('Summarizer 需要 complete(prompt) 函数');
    this.store = store;
    this.complete = complete;
    this.model = model;
    this.minMessages = minMessages;
    this.maxBatch = maxBatch;
    this.maxChars = maxChars;
  }

  /**
   * 跑一次增量摘要。
   * @param {string} chatId
   * @param {{force?:boolean}} opts force=true 时不做条数门槛（首次或手动触发）
   */
  async run(chatId, { force = false } = {}) {
    const prev = this.store.getChatSummary(chatId);
    const after = prev?.coversUpToSeq || 0;

    const { items } = this.store.listMessages({ chatId, after, limit: this.maxBatch });
    if (items.length === 0) return { skipped: 'no_new', covers: after };

    if (!force && items.length < this.minMessages) {
      return { skipped: 'too_few', pending: items.length, covers: after };
    }

    const body = renderMessages(items, this.maxChars);
    const prompt = [
      '你在维护一个群聊的滚动摘要。把下面的对话压缩成要点，供后续 agent 回忆。',
      '要求：只写事实与结论（谁说了什么、定了什么、还有什么没做），不要编造，不要寒暄。',
      '控制在 300 字以内，用短句或列表。',
      prev?.summary ? `\n【已有摘要】\n${prev.summary}` : '',
      `\n【新增对话】\n${body}`,
    ].join('\n');

    const text = String(await this.complete(prompt)).trim();
    const covers = items[items.length - 1].seq;
    this.store.upsertChatSummary({ chatId, summary: text, coversUpToSeq: covers, model: this.model });
    return { summary: text, covers, count: items.length };
  }
}

/** 把消息渲染成紧凑文本；超长时保留最近的部分。 */
export function renderMessages(items, maxChars = 8000) {
  const lines = items.map((m) => `${m.sender}: ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 500)}`);
  let out = lines.join('\n');
  if (out.length <= maxChars) return out;
  return '…（更早的消息已省略）\n' + out.slice(-maxChars);
}
