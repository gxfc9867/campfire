import { DatabaseSync } from 'node:sqlite';

/**
 * WorkBuddy 桥。
 *
 * 职责很窄：把一条围炉消息投进指定桌面会话，拿回模型回复。
 * 三条硬约束（都来自实测，见 docs/handoffs/HANDOFF-WORKBUDDY-BRIDGE-2026-10-30.md）：
 *   1. 同一会话串行，绝不并发写同一份 jsonl；
 *   2. 会话只 load 一次，之后复用；
 *   3. 写入后同步 workbuddy.db 的 sessions 行，否则 App 列表不更新。
 */
export class BridgeError extends Error {
  constructor(message, { code = 'bridge_error', detail = null } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
  }
}

export class WorkBuddyBridge {
  constructor({ acp, sessionIndex = null, log = null, dedupeLimit = 1000 }) {
    if (!acp) throw new Error('WorkBuddyBridge 需要 acp 客户端');
    this.acp = acp;
    this.sessionIndex = sessionIndex;
    this.log = log;
    this.loaded = new Set();
    this.queues = new Map();
    this.seen = new Map(); // messageId -> 时间戳，防重复投递
    this.dedupeLimit = dedupeLimit;
  }

  /** 按会话串行执行，前一个失败不阻塞后一个。 */
  enqueue(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    // 队列里只保留「已消化」的引用，避免 Promise 链无限增长
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * 投递一条消息。
   * @param {{sessionId:string, cwd:string, text:string, messageId?:string}} input
   * @returns {Promise<{text:string, stopReason:string, duplicate?:boolean}>}
   */
  async deliver({ sessionId, cwd, text, messageId = null }) {
    if (!sessionId) throw new BridgeError('缺少 sessionId', { code: 'bridge_bad_request' });
    if (!cwd) throw new BridgeError('缺少 cwd', { code: 'bridge_bad_request' });
    if (!text || !String(text).trim()) throw new BridgeError('消息为空', { code: 'bridge_bad_request' });

    if (messageId && this.isDuplicate(messageId)) {
      return { text: '', stopReason: 'duplicate', duplicate: true };
    }

    return this.enqueue(sessionId, async () => {
      if (!this.loaded.has(sessionId)) {
        await this.acp.loadSession({ sessionId, cwd });
        this.loaded.add(sessionId);
        this.log?.info?.(`[workbuddy] session loaded ${sessionId}`);
      }

      let out;
      try {
        out = await this.acp.prompt({ sessionId, text });
      } catch (err) {
        // 会话失效（被删/换目录）后下次重新 load
        this.loaded.delete(sessionId);
        throw new BridgeError(`投递失败：${err.message}`, { code: err.code || 'bridge_prompt_failed', detail: err.detail });
      }

      if (out.stopReason !== 'end_turn') {
        // 未正常完成说明这条会话的上下文可能已经坏了，下次重新 load
        this.loaded.delete(sessionId);
        throw new BridgeError(`模型未完成：${out.stopReason || 'unknown'}`, {
          code: out.stopReason === 'refusal' ? 'bridge_refused' : 'bridge_incomplete',
          detail: out.raw,
        });
      }

      if (messageId) this.markSeen(messageId);
      await this.touchSession(sessionId);

      return { text: out.texts.join('').trim(), stopReason: out.stopReason };
    });
  }

  /** 写会话索引；失败只告警，不影响投递结果。 */
  async touchSession(sessionId) {
    if (!this.sessionIndex) return;
    try {
      const changed = this.sessionIndex.touch({ sessionId });
      if (changed === 0) this.log?.warn?.(`[workbuddy] sessions 表没有 ${sessionId}，列表时间不会更新`);
    } catch (err) {
      this.log?.warn?.(`[workbuddy] 同步 sessions 失败：${err.message}`);
    }
  }

  isDuplicate(messageId) {
    const at = this.seen.get(messageId);
    if (!at) return false;
    return Date.now() - at < 10 * 60_000;
  }

  markSeen(messageId) {
    this.seen.set(messageId, Date.now());
    if (this.seen.size > this.dedupeLimit) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, v] of this.seen) {
        if (v < cutoff) this.seen.delete(k);
        if (this.seen.size <= this.dedupeLimit) break;
      }
    }
  }
}

/**
 * workbuddy.db 的只写索引。
 *
 * 只做一件事：把某条会话的时间与未读推上去，让 App 列表能感知新消息。
 * 每次操作单独开连接，避免长期持有 WAL 锁。
 */
export class SessionIndex {
  constructor({ dbPath, unread = 1 }) {
    if (!dbPath) throw new Error('SessionIndex 需要 dbPath');
    this.dbPath = dbPath;
    this.unread = unread;
  }

  touch({ sessionId, at = Date.now() }) {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec('PRAGMA busy_timeout=3000');
      const stmt = db.prepare(
        'UPDATE sessions SET updated_at = ?, last_activity_at = ?, unread = ? WHERE id = ?',
      );
      const info = stmt.run(at, at, this.unread, sessionId);
      return Number(info.changes || 0);
    } finally {
      db.close();
    }
  }
}
