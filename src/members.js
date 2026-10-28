import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HANDLE_RE, DRIVER, AVATAR_PRESET_COUNT } from './constants.js';
import { badRequest, conflict, notFound } from './errors.js';
import { randomKey } from './config.js';
import { logger } from './logger.js';

const log = logger.child('members');

/**
 * 成员配置（data/members.json）。
 *
 * 为什么用文件而不是数据库：
 * - 配置量小（几十条），手改友好；
 * - 便于备份、便于用户丢进 git 做版本管理；
 * - 与消息数据分离，误删数据库不会丢人设。
 *
 * 并发控制用「内容哈希当 ETag」而不是自增 version：
 * 用户可以直接用编辑器改文件，自增版本号在那种情况下不会变，乐观锁就失效了。
 */

/**
 * 默认值集中在这里，避免各处 if 判空。
 * 任何新增字段都应该在这里给一个合理默认，让老配置文件不用改也能继续用。
 */
function defaults() {
  return {
    display: '',
    avatar: 'initial',
    avatarSalt: 0,
    persona: '',
    driver: { type: DRIVER.pull },
    chats: [],
    aliases: [],
    // 热窗口 2 分钟：足够覆盖一次连续对话；之后降温到低频轮询
    wake: { hotMs: 120_000, warmMs: 600_000 },
    caps: {},
    archivedAt: null,
  };
}

/** 校验并补全一个成员条目。输入的 untrusted 部分都过一遍。 */
function normalize(input, prev = null) {
  const handle = String(input.handle ?? prev?.handle ?? '').trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    throw badRequest('handle 不合法：需小写字母开头，仅含小写字母、数字、-、_，最长 32');
  }

  const base = { ...defaults(), ...(prev || {}) };
  const display = String(input.display ?? base.display ?? handle).trim().slice(0, 40) || handle;

  const driver = normalizeDriver(input.driver ?? base.driver);

  const chats = Array.isArray(input.chats ?? base.chats)
    ? [...new Set((input.chats ?? base.chats).map((c) => String(c).trim()).filter(Boolean))].slice(0, 50)
    : [];

  const aliases = Array.isArray(input.aliases ?? base.aliases)
    ? [...new Set((input.aliases ?? base.aliases).map((a) => String(a).trim()).filter(Boolean))].slice(0, 8)
    : [];

  const wake = {
    hotMs: clampInt(input.wake?.hotMs ?? base.wake?.hotMs, 10_000, 3_600_000, 120_000),
    warmMs: clampInt(input.wake?.warmMs ?? base.wake?.warmMs, 0, 86_400_000, 600_000),
  };

  return {
    handle,
    display,
    avatar: normalizeAvatar(input.avatar ?? base.avatar),
    avatarSalt: clampInt(input.avatarSalt ?? base.avatarSalt, 0, 1e9, 0),
    persona: String(input.persona ?? base.persona ?? '').slice(0, 4000),
    driver,
    chats,
    aliases,
    wake,
    caps: typeof (input.caps ?? base.caps) === 'object' ? (input.caps ?? base.caps) : {},
    // 密钥只在创建时生成，之后不随编辑变化；显式传 key 允许迁移场景
    key: String(input.key ?? prev?.key ?? '') || randomKey(24),
    createdAt: prev?.createdAt ?? Date.now(),
    archivedAt: input.archivedAt ?? prev?.archivedAt ?? null,
  };
}

function normalizeDriver(d) {
  const type = String(d?.type || DRIVER.pull);
  if (!Object.values(DRIVER).includes(type)) {
    throw badRequest(`driver.type 必须是 ${Object.values(DRIVER).join(' / ')}`);
  }
  if (type === DRIVER.cli) {
    const cmd = String(d.cmd || '').trim();
    if (!cmd) throw badRequest('cli 驱动必须提供 cmd');
    return {
      type,
      cmd,
      args: Array.isArray(d.args) ? d.args.map((a) => String(a)) : [],
      cwd: String(d.cwd || '').trim(),
      env: d.env && typeof d.env === 'object' ? d.env : {},
      // 单轮超时：卡死的 CLI 必须能被杀掉，否则会永久占住并发闸门
      timeoutMs: clampInt(d.timeoutMs, 5_000, 600_000, 180_000),
      promptStdin: Boolean(d.promptStdin),
      // Windows 下 .cmd / .bat 必须经 shell 才能执行
      shell: Boolean(d.shell),
    };
  }
  if (type === DRIVER.webhook) {
    const url = String(d.url || '').trim();
    if (!/^https?:\/\//.test(url)) throw badRequest('webhook 驱动必须提供 http(s) 地址');
    return { type, url, secret: String(d.secret || ''), timeoutMs: clampInt(d.timeoutMs, 1_000, 120_000, 30_000) };
  }
  return { type: DRIVER.pull };
}

function normalizeAvatar(v) {
  const s = String(v || 'initial');
  if (s === 'initial') return s;
  const m = /^preset:(\d{2})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= AVATAR_PRESET_COUNT ? `preset:${m[1]}` : 'initial';
  }
  if (/^upload:[a-z0-9._-]{1,64}$/i.test(s)) return s;
  return 'initial';
}

function clampInt(v, min, max, def) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 脱敏。
 * 驱动配置里可能含 API key（写在 args 或 env 里），列表接口和日志都不能原样带出去。
 * 规则保守：env 一律打码，args 里紧跟 --xxx-key/--token 的值打码，sk-* 形态打码。
 */
export function maskDriver(driver) {
  if (!driver) return null;
  const out = { ...driver };
  if (out.env) {
    out.env = Object.fromEntries(Object.keys(out.env).map((k) => [k, '****']));
  }
  if (out.secret) out.secret = '****';
  if (Array.isArray(out.args)) {
    out.args = out.args.map((a, i, arr) => {
      if (/(key|token|secret|password)$/i.test(String(arr[i - 1] || '').replace(/^--?/, ''))) return '****';
      if (/^sk-[A-Za-z0-9_-]{6,}$/.test(a)) return '****';
      return a;
    });
  }
  return out;
}

/** 对外暴露的成员视图：不含密钥明文，驱动脱敏。 */
export function publicView(m, { withChats = true } = {}) {
  return {
    handle: m.handle,
    display: m.display,
    avatar: m.avatar,
    avatarSalt: m.avatarSalt,
    persona: m.persona,
    driver: maskDriver(m.driver),
    driverType: m.driver?.type || DRIVER.pull,
    chats: withChats ? m.chats : undefined,
    aliases: m.aliases,
    wake: m.wake,
    caps: m.caps,
    keyMask: maskKey(m.key),
    createdAt: m.createdAt,
    archivedAt: m.archivedAt,
  };
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-2)}`;
}

export class Members {
  constructor({ file, config }) {
    this.file = file;
    this.config = config;
    this.items = [];
    this.hash = '';
    this._mtime = -1;
    this.#load(true);
  }

  #load(force = false) {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (!force && mtime === this._mtime) return false;
    this._mtime = mtime;

    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      // 首次运行：建空文件
      this.items = [];
      this.hash = '';
      this.#persist({ items: [] }, { silent: true });
      return true;
    }

    this.hash = crypto.createHash('sha1').update(raw).digest('hex');
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(list)) throw new Error('顶层必须是数组或 { items: [] }');
      this.items = list.map((e) => normalize(e));
      // 去重：手改容易复制粘贴出重复 handle，保留第一条并告警而不是整体失败
      const seen = new Set();
      this.items = this.items.filter((m) => {
        if (seen.has(m.handle)) {
          log.warn(`重复的 handle 已忽略：${m.handle}`);
          return false;
        }
        seen.add(m.handle);
        return true;
      });
      return true;
    } catch (e) {
      // 配置坏了不能让服务起不来，也不能覆盖用户的文件——保持上一份可用配置
      log.error(`members.json 解析失败：${e.message}`);
      return false;
    }
  }

  /** 每次读之前轻量检查 mtime，用户手改文件后无需重启。 */
  reload() {
    return this.#load(false);
  }

  #persist(payload, { silent = false } = {}) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Windows 上 chmod 基本无效，忽略
    }
    this.hash = crypto.createHash('sha1').update(body).digest('hex');
    this._mtime = fs.statSync(this.file).mtimeMs;
    if (!silent) log.debug('members.json 已写入', this.items.length);
  }

  #save() {
    this.#persist({ items: this.items });
  }

  /** 内容哈希，用作乐观锁的 ETag。 */
  etag() {
    this.reload();
    return this.hash;
  }

  list({ includeArchived = false } = {}) {
    this.reload();
    return this.items
      .filter((m) => includeArchived || !m.archivedAt)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 内部使用，含密钥明文。调用方不得直接返回给客户端。 */
  get(handle) {
    this.reload();
    return this.items.find((m) => m.handle === handle) || null;
  }

  /** 解析 @：handle、display、别名都能命中。 */
  find(ref) {
    this.reload();
    const key = String(ref || '').trim();
    if (!key) return null;
    return (
      this.items.find((m) => m.handle === key) ||
      this.items.find((m) => m.display === key) ||
      this.items.find((m) => m.aliases.includes(key)) ||
      null
    );
  }

  /**
   * 新建或更新。
   * @param {object} input 成员字段（部分字段可选）
   * @param {string} [expectedEtag] 传入则做乐观锁校验，防止界面保存覆盖手改
   */
  upsert(input, expectedEtag) {
    this.reload();
    if (expectedEtag && expectedEtag !== this.hash) {
      throw conflict('成员配置已被其他人修改，请刷新后重试');
    }

    const isNew = !input.handle || !this.items.some((m) => m.handle === String(input.handle).toLowerCase());
    const prev = isNew ? null : this.get(input.handle);
    const m = normalize(input, prev);

    if (isNew && this.items.length >= this.config.maxMembers) {
      throw badRequest(`成员数量已达上限 ${this.config.maxMembers}`);
    }

    const idx = this.items.findIndex((x) => x.handle === m.handle);
    if (idx >= 0) this.items[idx] = m;
    else this.items.push(m);

    this.#save();
    log.info(idx >= 0 ? `更新成员 ${m.handle}` : `新建成员 ${m.handle}`);
    return m;
  }

  /** 软删除：保留记录，历史消息的 sender 才不会悬空。 */
  archive(handle, expectedEtag) {
    this.reload();
    if (expectedEtag && expectedEtag !== this.hash) {
      throw conflict('成员配置已被其他人修改，请刷新后重试');
    }
    const m = this.get(handle);
    if (!m) throw notFound('成员不存在');
    m.archivedAt = Date.now();
    this.#save();
    log.info(`归档成员 ${handle}`);
    return m;
  }

  /** 恢复归档。 */
  restore(handle) {
    const m = this.get(handle);
    if (!m) throw notFound('成员不存在');
    m.archivedAt = null;
    this.#save();
    return m;
  }

  /** 成员密钥校验，用定时安全比较避免按字节猜。 */
  verifyKey(handle, key) {
    const m = this.get(handle);
    if (!m || m.archivedAt) return false;
    const a = Buffer.from(String(key || ''));
    const b = Buffer.from(m.key);
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** 轮换密钥：老客户端会立刻失效。 */
  rotateKey(handle) {
    const m = this.get(handle);
    if (!m) throw notFound('成员不存在');
    m.key = randomKey(24);
    this.#save();
    return m.key;
  }
}
