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
