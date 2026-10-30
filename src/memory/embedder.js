/**
 * 消息向量与检索。
 *
 * 不引向量库：数据量按「一个自托管群聊」估，几千条以内，暴力余弦足够快，
 * 也省掉一个外部依赖。真要上百万条再换 sqlite-vec。
 */
export class Embedder {
  constructor({ store, embed, model = 'unknown', batch = 32 }) {
    if (!store) throw new Error('Embedder 需要 store');
    if (typeof embed !== 'function') throw new Error('Embedder 需要 embed(texts) 函数');
    this.store = store;
    this.embed = embed;
    this.model = model;
    this.batch = batch;
  }

  /** 给某会话里还没向量的消息补上向量。 */
  async indexChat(chatId, { limit = 100 } = {}) {
    const pending = this.store.messagesNeedingEmbedding(chatId, { limit });
    if (pending.length === 0) return { indexed: 0 };

    let indexed = 0;
    for (let i = 0; i < pending.length; i += this.batch) {
      const chunk = pending.slice(i, i + this.batch);
      const vectors = await this.embed(chunk.map((m) => String(m.text || '')));
      if (!Array.isArray(vectors) || vectors.length !== chunk.length) {
        throw new Error(`embed 返回数量不符：期望 ${chunk.length}，实际 ${vectors?.length}`);
      }
      chunk.forEach((m, idx) => {
        this.store.upsertEmbedding({
          messageId: m.id,
          chatId: m.chatId,
          seq: m.seq,
          vector: vectors[idx],
          model: this.model,
        });
        indexed += 1;
      });
    }
    return { indexed };
  }

  /**
   * 语义检索。
   * @returns {Promise<Array<{messageId,seq,score}>>} 按相似度降序
   */
  async search({ chatId, query, k = 5 }) {
    const text = String(query || '').trim();
    if (!text) return [];
    const [qv] = await this.embed([text]);
    if (!Array.isArray(qv)) throw new Error('query 向量生成失败');

    const rows = this.store.listEmbeddings(chatId);
    const scored = rows
      .filter((r) => r.vector.length === qv.length)
      .map((r) => ({ messageId: r.messageId, seq: r.seq, score: cosine(qv, r.vector) }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, k));
  }
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
