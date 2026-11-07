/**
 * 数据库迁移。
 *
 * 版本号存在 SQLite 的 PRAGMA user_version：0 表示老库，按序升级到最新。
 * 每个迁移单独一个事务，失败即回滚，绝不留下半套表。
 *
 * 约定：
 * - 迁移只增不改；已发布的版本不许再改内容（否则别人的库永远对不上）；
 * - 新迁移追加到数组末尾，version 连续递增。
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline',
    up() {
      // v1 之前的表由 Store 构造时用 CREATE TABLE IF NOT EXISTS 建成，这里只需打版本号
    },
  },
  {
    version: 2,
    name: 'channels',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id          TEXT PRIMARY KEY,
          member      TEXT NOT NULL,
          name        TEXT NOT NULL,
          token_hash  TEXT NOT NULL UNIQUE,
          scopes      TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_channels_member ON channels(member);
      `);
    },
  },
  {
    version: 3,
    name: 'channel_cursors',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_cursors (
          channel_id TEXT NOT NULL,
          chat_id    TEXT NOT NULL,
          cursor     INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (channel_id, chat_id)
        );
      `);
    },
  },
  {
    version: 4,
    name: 'memory',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_summaries (
          chat_id          TEXT PRIMARY KEY,
          summary          TEXT NOT NULL,
          covers_up_to_seq INTEGER NOT NULL,
          model            TEXT,
          updated_at       INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message_embeddings (
          message_id TEXT PRIMARY KEY,
          chat_id    TEXT NOT NULL,
          seq        INTEGER NOT NULL,
          vector     TEXT NOT NULL,
          dim        INTEGER NOT NULL,
          model      TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_chat ON message_embeddings(chat_id, seq);
      `);
    },
  },
  {
    version: 5,
    name: 'schedules',
    up(db) {
      // 定时消息：到点往群里发一条，复用正常投递管线（@ 照常叫醒成员）
      db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
          id          TEXT PRIMARY KEY,
          chat_id     TEXT NOT NULL,
          cron        TEXT NOT NULL,
          text        TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          next_run_at INTEGER,
          last_run_at INTEGER,
          created_at  INTEGER NOT NULL,
          created_by  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
        CREATE INDEX IF NOT EXISTS idx_schedules_chat ON schedules(chat_id);
      `);
    },
  },
  {
    version: 6,
    name: 'message_attachments',
    up(db) {
      // 附件元数据存 messages.attachments（JSON 数组），文件本体在 data/uploads/
      const cols = db.prepare('PRAGMA table_info(messages)').all();
      if (!cols.some((c) => c.name === 'attachments')) {
        db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
      }
      // 上传记录：谁传的、属于哪个会话、什么时候过期（孤儿文件清理用）
      db.exec(`
        CREATE TABLE IF NOT EXISTS uploads (
          id          TEXT PRIMARY KEY,
          chat_id     TEXT NOT NULL,
          uploader    TEXT NOT NULL,
          name        TEXT NOT NULL,
          mime        TEXT NOT NULL,
          size        INTEGER NOT NULL,
          path        TEXT NOT NULL,
          width       INTEGER,
          height      INTEGER,
          created_at  INTEGER NOT NULL,
          message_id  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_uploads_chat ON uploads(chat_id);
        CREATE INDEX IF NOT EXISTS idx_uploads_orphan ON uploads(created_at) WHERE message_id IS NULL;
      `);
    },
  },
];

export function currentVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version || 0);
}

/**
 * 执行未应用的迁移。
 * @returns {{from:number,to:number,applied:number[]}}
 */
export function migrate(db, log = null) {
  const from = currentVersion(db);
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 v${m.version}(${m.name}) 失败：${err.message}`);
    }
    applied.push(m.version);
    log?.info?.(`数据库迁移 v${m.version} ${m.name}`);
  }
  return { from, to: currentVersion(db), applied };
}
