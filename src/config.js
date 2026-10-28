import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

/**
 * 配置解析。
 *
 * 优先级：进程环境变量 > 项目根目录 .env > 内置默认值。
 * 这里刻意不引入 dotenv 之类的依赖——解析规则简单到不值得为它增加一个包。
 */

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 读取 .env 并注入 process.env（已存在的变量不覆盖，方便命令行临时覆盖）。 */
function loadDotEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // 没有 .env 是正常情况
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    // 去掉成对的引号，保留引号内的空格
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

/** 取整数并夹到区间内，非法值退回默认值而不是让服务起不来。 */
function int(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    logger.warn(`[config] ${name}=${raw} 不是整数，使用默认值 ${def}`);
    return def;
  }
  return Math.min(max, Math.max(min, n));
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** 统一成 '' 或 '/xxx'，不带尾斜杠。 */
function basePath(raw) {
  const s = String(raw || '').trim().replace(/^\/+|\/+$/g, '');
  return s ? `/${s}` : '';
}

/** 口令字符集去掉易混字符（0/O/1/l/I），便于手抄。 */
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomKey(len = 20) {
  let out = '';
  for (let i = 0; i < len; i++) out += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return out;
}

/**
 * 解析主人口令。这里**只读不写**：
 * 没有环境变量也没有文件时返回空串，真正的生成动作留给 start()。
 * 否则 check / doctor 之类只要 import 本模块就会往 data/ 里塞文件。
 */
function resolveOwnerKey(dataDir) {
  const fromEnv = String(process.env.OWNER_PASSWORD || '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env', generated: false };

  const file = path.join(dataDir, 'owner-key.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return { key: saved, source: 'file', generated: false };
  } catch {
    // 文件不存在，等 start() 生成
  }
  return { key: '', source: 'none', generated: false };
}

/** 生成并落盘口令。只在服务真正启动时调用一次。 */
export function ensureOwnerKey(cfg) {
  if (cfg.ownerKey) return cfg.ownerKey;
  const key = randomKey(16);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(cfg.paths.ownerKey, `${key}\n`, { mode: 0o600 });
  cfg.ownerKey = key;
  cfg.ownerKeySource = 'file';
  cfg.ownerKeyGenerated = true;
  return key;
}

/**
 * 由数据目录推导出所有落盘路径。
 * 抽成函数是为了让测试能用临时目录建一个完全独立的实例，
 * 而不必去改进程环境变量。
 */
export function resolvePaths(dataDir) {
  return {
    db: path.join(dataDir, 'campfire.db'),
    members: path.join(dataDir, 'members.json'),
    memoryDir: path.join(dataDir, 'memory'),
    avatarDir: path.join(dataDir, 'avatars'),
    ownerKey: path.join(dataDir, 'owner-key.txt'),
    publicDir: path.join(ROOT, 'public'),
  };
}

const dataDir = path.isAbsolute(process.env.DATA_DIR || '')
  ? process.env.DATA_DIR
  : path.join(ROOT, process.env.DATA_DIR || 'data');

const owner = resolveOwnerKey(dataDir);

const port = int('PORT', 8099, 1, 65535);
const host = String(process.env.HOST || '0.0.0.0').trim();

const config = {
  root: ROOT,
  dataDir,
  paths: resolvePaths(dataDir),

  port,
  host,

  /** 主人登录口令。只有它能换取浏览器会话。 */
  ownerKey: owner.key,
  ownerKeySource: owner.source,
  ownerKeyGenerated: owner.generated,

  /** 会话 Cookie 有效期。 */
  sessionTtlMs: int('SESSION_TTL_HOURS', 168, 1, 24 * 365) * 3600_000,

  /** 对外地址，用于拼唤醒指令与 sidecar 回连。空则由请求头推断。 */
  publicUrl: String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),

  /** 子路径部署，例如 /chat。 */
  basePath: basePath(process.env.BASE_PATH),

  /** 在反代后面才信任 X-Forwarded-For，否则任何人都能伪造来源 IP。 */
  trustProxy: bool('TRUST_PROXY', false),

  /** 长轮询约束：wait 上限必须小于反代空闲超时，留出余量。 */
  inboxWaitMax: int('INBOX_WAIT_MAX', 50, 1, 120),
  inboxWaitDefault: int('INBOX_WAIT_DEFAULT', 25, 0, 120),

  /**
   * HTTP keep-alive 空闲时长。
   * 必须显著大于 inboxWaitMax，否则长轮询返回后复用连接会撞上已关闭的半死连接。
   * Node 默认只有 5s，是长轮询最常见的坑。
   */
  keepAliveMs: int('KEEP_ALIVE_SECONDS', 70, 10, 300) * 1000,

  /** 在线判定：多久没有任何拉取/心跳算不可达。 */
  presenceTtlMs: int('PRESENCE_TTL', 90, 15, 3600) * 1000,

  /**
   * 「就绪」判定：pull 型成员多久内拉过就算能立刻响应。
   * cli 型不用这个——它是否有进程在跑由 sidecar 上报的 running 决定。
   */
  presenceHotMs: int('PRESENCE_HOT', 45, 5, 600) * 1000,

  /** 唤醒冷却窗：同一成员在该窗口内最多被唤醒一次，用来吸收消息风暴。 */
  wakeCooldownMs: int('WAKE_COOLDOWN', 30, 1, 600) * 1000,

  /** 单次投递最长等待；超时降级为普通消息，不判失败。 */
  jobExpireMs: int('JOB_EXPIRE', 600, 30, 86400) * 1000,

  /** 规模上限，防止误配置把单进程压垮。 */
  maxMembers: int('MAX_MEMBERS', 50, 1, 500),
  maxPolls: int('MAX_POLLS', 200, 10, 5000),

  /** 单条消息与正文长度。 */
  maxTextLength: int('MAX_TEXT', 32000, 100, 200_000),
  maxChatNameLength: 40,

  /** 成员清单里允许的最大群数，避免误传超大数组。 */
  maxChatsPerMember: 50,
};

/** 启动时把生成的门口令打出来一次，并提示它存在哪。 */
export function announceOwnerKey(log = logger) {
  if (config.ownerKeyGenerated) {
    log.warn('══════════════════════════════════════════════');
    log.warn('  首次启动，已自动生成主人口令：');
    log.warn(`  ${config.ownerKey}`);
    log.warn(`  已保存到 ${config.paths.ownerKey}（权限 0600）`);
    log.warn('  请立刻保存，登录后可在设置里修改');
    log.warn('══════════════════════════════════════════════');
  } else if (config.ownerKeySource === 'env') {
    log.info('[config] 主人口令来自环境变量 OWNER_PASSWORD');
  }
}

export default config;
