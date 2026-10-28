import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MAIN_CHAT, JOB_STATUS } from './constants.js';
import { shortId } from './id.js';

/**
 * 持久层。整个项目只有这里直接接触 SQLite。
 *
 * 设计取舍：
 * - 用 Node 内置 node:sqlite，不引 better-sqlite3，保持零 npm 依赖；
 * - 打开 WAL，读写并发不互相阻塞（长轮询场景下频繁读、偶发写）；
 * - 消息用自增 seq 做游标，不用时间戳——同毫秒多消息时时间戳会丢消息；
 * - 成员主体不在这里（在 members.json），这里只存「谁在哪个群」的归属关系。
 */
export class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'campfire.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
    this.ensureChat(MAIN_CHAT.id, MAIN_CHAT.name);
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        archived_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        id         TEXT NOT NULL UNIQUE,
        chat_id    TEXT NOT NULL REFERENCES chats(id),
        sender     TEXT NOT NULL,
        text       TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        client_id  TEXT,
        reply_to   TEXT,
        job_id     TEXT,
        meta       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client
        ON messages(sender, client_id) WHERE client_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS jobs (
        id         TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        message_id TEXT NOT NULL,
        handle     TEXT NOT NULL,
        request_id TEXT NOT NULL,
        status     TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        error      TEXT,
        text       TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, handle);
      CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_request ON jobs(request_id);

      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id     TEXT NOT NULL,
        handle      TEXT NOT NULL,
        joined_at   INTEGER NOT NULL,
        archived_at INTEGER,
        PRIMARY KEY (chat_id, handle)
      );

      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // 已关闭时忽略
    }
  }

  // ── 会话 ────────────────────────────────────────────────────────────

  ensureChat(id, name) {
    const now = Date.now();
    this.db
      .prepare('INSERT OR IGNORE INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name, now, now);
    return this.getChat(id);
  }

  getChat(id) {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    return row ? mapChat(row) : null;
  }

  listChats() {
    const rows = this.db
      .prepare('SELECT * FROM chats WHERE archived_at IS NULL ORDER BY updated_at DESC')
      .all();
    return rows.map(mapChat);
  }

  createChat(name) {
    const now = Date.now();
    const id = shortId('c_');
    this.db
      .prepare('INSERT INTO chats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name, now, now);
    return this.getChat(id);
  }

  renameChat(id, name) {
    this.db.prepare('UPDATE chats SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
    return this.getChat(id);
  }

  archiveChat(id) {
    this.db
      .prepare('UPDATE chats SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), id);
  }

  /** 有新消息时刷新会话排序。 */
  touchChat(id) {
    this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** 侧栏摘要：最后一条消息的片段，避免前端为每个会话各拉一次。 */
  lastMessageOf(chatId) {
    const row = this.db
      .prepare('SELECT sender, text, created_at FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1')
      .get(chatId);
    return row ? { sender: row.sender, text: row.text, createdAt: row.created_at } : null;
  }

  countMessages(chatId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId).n;
  }

  // ── 消息 ────────────────────────────────────────────────────────────

  /**
   * 写一条消息。
   * 显式开事务：后面还要建投递任务，两者必须一起成功或一起回滚。
   */
  insertMessage({ id, chatId, sender, text, clientId = null, replyTo = null, jobId = null, meta = null }) {
    const now = Date.now();
    const msgId = id || shortId('m_');
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, sender, text, created_at, client_id, reply_to, job_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(msgId, chatId, sender, text, now, clientId, replyTo, jobId, meta ? JSON.stringify(meta) : null);
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    return mapMessage(row);
  }

  getMessage(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? mapMessage(row) : null;
  }

  /** 幂等去重：同一发送者用同一 clientId 重复提交只认第一条。 */
  getMessageByClientId(sender, clientId) {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE sender = ? AND client_id = ?')
      .get(sender, clientId);
    return row ? mapMessage(row) : null;
  }

  /** 某次投递产出的回复。用于回执幂等：重复提交时返回第一次的结果。 */
  getMessageByJobId(jobId) {
    const row = this.db.prepare('SELECT * FROM messages WHERE job_id = ? LIMIT 1').get(jobId);
    return row ? mapMessage(row) : null;
  }

  /**
   * 按 seq 游标拉消息。
   * after 用于追新，before 用于往前翻历史，两者互斥（同时给时以 after 为准）。
   */
  listMessages({ chatId, after, before, limit = 50 }) {
    const n = Math.min(Math.max(limit, 1), 200);
    if (after) {
      const rows = this.db
        .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
        .all(chatId, after, n + 1);
      const hasMore = rows.length > n;
      return { items: rows.slice(0, n).map(mapMessage), hasMore };
    }
    if (before) {
      const rows = this.db
        .prepare('SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(chatId, before, n + 1);
      const hasMore = rows.length > n;
      return { items: rows.slice(0, n).map(mapMessage).reverse(), hasMore };
    }
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?')
      .all(chatId, n + 1);
    const hasMore = rows.length > n;
    return { items: rows.slice(0, n).map(mapMessage).reverse(), hasMore };
  }

  // ── 群成员归属 ──────────────────────────────────────────────────────

  /** 重建某成员的全部群归属（配置为准，库内跟随）。 */
  setMemberChats(handle, chatIds) {
    const now = Date.now();
    const wanted = new Set(chatIds);
    const current = this.db
      .prepare('SELECT chat_id FROM chat_members WHERE handle = ? AND archived_at IS NULL')
      .all(handle)
      .map((r) => r.chat_id);

    this.db.exec('BEGIN');
    try {
      for (const chatId of current) {
        if (!wanted.has(chatId)) {
          this.db
            .prepare('UPDATE chat_members SET archived_at = ? WHERE chat_id = ? AND handle = ?')
            .run(now, chatId, handle);
        }
      }
      for (const chatId of wanted) {
        // 曾经移出过就复活记录，避免主键冲突
        this.db
          .prepare(
            `INSERT INTO chat_members (chat_id, handle, joined_at, archived_at) VALUES (?, ?, ?, NULL)
             ON CONFLICT(chat_id, handle) DO UPDATE SET archived_at = NULL`,
          )
          .run(chatId, handle, now);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listMembersOf(chatId) {
    return this.db
      .prepare('SELECT handle FROM chat_members WHERE chat_id = ? AND archived_at IS NULL')
      .all(chatId)
      .map((r) => r.handle);
  }

  // ── 投递任务 ────────────────────────────────────────────────────────

  createJob({ chatId, messageId, handle, requestId, text, expiresInMs }) {
    const now = Date.now();
    const id = shortId('j_');
    this.db
      .prepare(
        `INSERT INTO jobs (id, chat_id, message_id, handle, request_id, status, text, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, chatId, messageId, handle, requestId, JOB_STATUS.pending, text, now, now, now + expiresInMs);
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? mapJob(row) : null;
  }

  getJobByRequestId(requestId) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE request_id = ?').get(requestId);
    return row ? mapJob(row) : null;
  }

  listJobs({ chatId, handle, status, limit = 50 }) {
    const where = [];
    const args = [];
    if (chatId) {
      where.push('chat_id = ?');
      args.push(chatId);
    }
    if (handle) {
      where.push('handle = ?');
      args.push(handle);
    }
    if (status) {
      where.push('status = ?');
      args.push(status);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    args.push(Math.min(Math.max(limit, 1), 200));
    return this.db.prepare(sql).all(...args).map(mapJob);
  }

  /** 认领：pending → processing。返回 false 说明已被别人领走（多 sidecar 时防重）。 */
  claimJob(id, handle) {
    const r = this.db
      .prepare(
        `UPDATE jobs SET status = ?, updated_at = ?, attempts = attempts + 1
         WHERE id = ? AND handle = ? AND status = ?`,
      )
      .run(JOB_STATUS.processing, Date.now(), id, handle, JOB_STATUS.pending);
    return r.changes > 0;
  }

  finishJob(id, status, error = null) {
    this.db
      .prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, Date.now(), id);
  }

  /** 到点未处理的投递降级为 expired（不是 failed），上层据此留一条说明消息。 */
  expireStaleJobs(now = Date.now()) {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE status IN (?, ?) AND expires_at < ?')
      .all(JOB_STATUS.pending, JOB_STATUS.processing, now);
    if (!rows.length) return [];
    const stmt = this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?');
    for (const r of rows) stmt.run(JOB_STATUS.expired, now, r.id);
    return rows.map(mapJob);
  }

  jobStats() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // ── 键值 ────────────────────────────────────────────────────────────

  getKV(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setKV(key, value) {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }
}

function mapChat(r) {
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

function mapMessage(r) {
  return {
    seq: r.seq,
    id: r.id,
    chatId: r.chat_id,
    sender: r.sender,
    text: r.text,
    createdAt: r.created_at,
    clientId: r.client_id,
    replyTo: r.reply_to,
    jobId: r.job_id,
    meta: r.meta ? safeJson(r.meta) : null,
  };
}

function mapJob(r) {
  return {
    id: r.id,
    chatId: r.chat_id,
    messageId: r.message_id,
    handle: r.handle,
    requestId: r.request_id,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    text: r.text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
