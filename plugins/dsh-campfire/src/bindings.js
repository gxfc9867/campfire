/**
 * 插件自己的小状态：`围炉 chat × 成员 → DSH sessionId` 绑定，以及每个群的投递游标。
 *
 * 存在一个 JSON 文件里（默认 `$DSH_HOME/campfire/state.json`），
 * 写盘用「临时文件 + rename」保证不会留下半个文件；
 * 读失败/文件损坏时降级为空状态并打日志，不阻断插件启动。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 2;

/** 去重表最多留这么多条：够覆盖断线重连的窗口，又不会让 state.json 无限长。 */
const PROCESSED_LIMIT = 300;

function emptyState() {
  return { version: STATE_VERSION, bindings: {}, cursors: {}, processed: {} };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  if (raw.bindings && typeof raw.bindings === 'object') {
    for (const [key, value] of Object.entries(raw.bindings)) {
      if (!value || typeof value !== 'object') continue;
      if (typeof value.sessionId !== 'string' || !value.sessionId) continue;
      base.bindings[key] = {
        sessionId: value.sessionId,
        chatId: typeof value.chatId === 'string' ? value.chatId : key,
        createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
        lastWakeAt: Number.isFinite(value.lastWakeAt) ? value.lastWakeAt : 0,
      };
    }
  }
  if (raw.cursors && typeof raw.cursors === 'object') {
    for (const [chat, seq] of Object.entries(raw.cursors)) {
      const value = Number(seq);
      if (Number.isFinite(value) && value >= 0) base.cursors[chat] = value;
    }
  }
  // 已处理的 updateId：跨重启去重，避免「回复成功但 ack 失败」时重放同一条
  if (raw.processed && typeof raw.processed === 'object') {
    for (const [id, at] of Object.entries(raw.processed)) {
      const value = Number(at);
      if (typeof id === 'string' && id && Number.isFinite(value)) base.processed[id] = value;
    }
  }
  return base;
}

/**
 * @param {{ filePath: string, log?: (level: string, message: string) => void }} options
 */
export function createStateStore({ filePath, log = () => {} } = {}) {
  if (!filePath) throw new TypeError('createStateStore: filePath 必填');
  let state = emptyState();
  let loaded = false;
  let pending = Promise.resolve();

  async function load() {
    if (loaded) return state;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      state = normalizeState(JSON.parse(raw));
      log('debug', `围炉插件状态已载入：${filePath}（绑定 ${Object.keys(state.bindings).length} 条）`);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        log('debug', `围炉插件状态文件还不存在，按空状态启动：${filePath}`);
      } else {
        log('warn', `围炉插件状态读取失败，按空状态启动：${error?.message ?? error}`);
      }
    }
    loaded = true;
    return state;
  }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    pending = pending
      .then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(tmp, snapshot, 'utf8');
        await fs.rename(tmp, filePath);
      })
      .catch((error) => {
        log('warn', `围炉插件状态写盘失败：${error?.message ?? error}`);
      });
    return pending;
  }

  return {
    filePath,
    get state() {
      return state;
    },
    load,
    flush: () => pending,
    getBinding: (key) => state.bindings[key],
    listBindings: () => ({ ...state.bindings }),
    async setBinding(key, record) {
      const now = Date.now();
      const previous = state.bindings[key];
      state.bindings[key] = {
        sessionId: record.sessionId,
        chatId: record.chatId ?? previous?.chatId ?? key,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        lastWakeAt: record.lastWakeAt ?? previous?.lastWakeAt ?? 0,
      };
      await persist();
      return state.bindings[key];
    },
    async touchBinding(key, patch = {}) {
      const previous = state.bindings[key];
      if (!previous) return undefined;
      state.bindings[key] = { ...previous, ...patch, updatedAt: Date.now() };
      await persist();
      return state.bindings[key];
    },
    async deleteBinding(key) {
      if (!state.bindings[key]) return false;
      delete state.bindings[key];
      await persist();
      return true;
    },
    getCursor: (chatId) => state.cursors[chatId] ?? 0,
    async setCursor(chatId, seq) {
      const value = Number(seq);
      if (!Number.isFinite(value) || value < 0) return;
      if ((state.cursors[chatId] ?? 0) === value) return;
      state.cursors[chatId] = value;
      await persist();
    },

    /** 这条 update 之前处理过吗（跨重启有效）。 */
    hasProcessed: (updateId) => Boolean(state.processed?.[updateId]),

    /** 记下已处理的 updateId，超过上限时丢最旧的。 */
    async markProcessed(updateId) {
      if (!updateId) return;
      state.processed[updateId] = Date.now();
      const keys = Object.keys(state.processed);
      if (keys.length > PROCESSED_LIMIT) {
        keys
          .sort((a, b) => state.processed[a] - state.processed[b])
          .slice(0, keys.length - PROCESSED_LIMIT)
          .forEach((k) => delete state.processed[k]);
      }
      await persist();
    },
  };
}
