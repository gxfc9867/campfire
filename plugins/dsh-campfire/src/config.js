/**
 * 插件配置解析：三处来源，优先级 **行内 config > 环境变量 > 配置文件 > 默认值**。
 *
 * 为什么要有配置文件这一层：真实 token 不该写进 `cordis.patch.yml`（会进版本库/备份），
 * 而 DSH 进程启动后再改环境变量也来不及，所以留一个插件自己的 JSON 配置文件
 * （默认 `$DSH_HOME/campfire/config.json`），既能用命令行脚本写，也不进仓库。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_MARKER_TEMPLATE } from './format.js';

function dshRoot(env) {
  return env.DSH_HOME || env.DSH_PROFILE_DIR || path.join(os.homedir(), '.campfire');
}

export function defaultDataDir(env = process.env) {
  return path.join(dshRoot(env), 'campfire');
}

export const DEFAULT_CONFIG = Object.freeze({
  /** 围炉服务地址，例如 http://127.0.0.1:8787 或 https://group.example.com */
  baseUrl: '',
  /** 渠道 token（一 token = 一成员）。留空则依次看 tokenEnv / tokenFile。 */
  token: '',
  /** 从哪个环境变量取 token。 */
  tokenEnv: 'CAMPFIRE_TOKEN',
  /** 从文件取 token（支持 ~ 开头）。LAYOUT 约定的位置是 ~/.campfire/secrets/。 */
  tokenFile: '',
  /** 本插件在围炉里的成员 handle。 */
  memberHandle: 'facai',
  /** 要接的群；空数组 = 不接任何群（待命）。 */
  chatIds: ['main'],
  /** 'member' = 一个成员一个会话（默认，推荐）；'per-chat' = 每个群一个会话。 */
  sessionScope: 'member',
  /** 长轮询秒数（0–30）。 */
  wait: 25,
  /** 一次拉取最多多少条 update。 */
  limit: 100,
  /** 等模型把一轮跑完的上限（毫秒）。 */
  replyTimeoutMs: 120_000,
  /** 发回围炉的单条回复字数上限。 */
  maxReplyChars: 8000,
  /** 来源标记模板，`{chat}` `{sender}` 会被替换。 */
  sourceMarker: DEFAULT_MARKER_TEMPLATE,
  /** 会话工作目录；留空则用 DSH 的默认目录。 */
  cwd: '',
  /** 会话模型路由；留空则继承 Harness 当前默认模型。 */
  provider: '',
  model: '',
  reasoningEffort: '',
  /** 绑定/游标状态文件；留空用 `$DSH_HOME/campfire/state.json`。 */
  stateFile: '',
  /** 配置文件位置；留空用 `$DSH_HOME/campfire/config.json`。 */
  configFile: '',
  /** 出错后的最大退避（毫秒）。 */
  maxBackoffMs: 30_000,
  /** 日志级别：debug | info | warn | error | silent。 */
  logLevel: 'info',
});

const ROW_KEYS = Object.keys(DEFAULT_CONFIG);

function pickDefined(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of ROW_KEYS) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

function normalizeChatIds(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function clampNumber(value, { min, max, fallback }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function expandHome(filePath, env = process.env) {
  if (!filePath) return '';
  if (filePath === '~') return env.USERPROFILE || env.HOME || os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(env.USERPROFILE || env.HOME || os.homedir(), filePath.slice(2));
  }
  return filePath;
}

async function readSecretFile(filePath, log) {
  if (!filePath) return '';
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw.trim();
  } catch (error) {
    log('warn', `围炉 token 文件读取失败：${filePath}（${error?.message ?? error}）`);
    return '';
  }
}

/**
 * @param {Record<string, unknown>} row 插件行内 config
 * @param {{ env?: NodeJS.ProcessEnv, log?: (level: string, message: string) => void }} options
 */
export async function resolveConfig(row = {}, { env = process.env, log = () => {} } = {}) {
  const configFile = expandHome(row.configFile || env.CAMPFIRE_CONFIG_FILE || '', env) || path.join(defaultDataDir(env), 'config.json');

  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await fs.readFile(configFile, 'utf8'));
    if (!fileConfig || typeof fileConfig !== 'object') fileConfig = {};
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('warn', `围炉插件配置文件解析失败，已忽略：${configFile}（${error?.message ?? error}）`);
    }
  }

  const envLayer = {
    baseUrl: env.CAMPFIRE_BASE_URL,
    token: env.CAMPFIRE_TOKEN,
    memberHandle: env.CAMPFIRE_MEMBER,
    chatIds: env.CAMPFIRE_CHATS,
    sessionScope: env.CAMPFIRE_SESSION_SCOPE,
    cwd: env.CAMPFIRE_CWD,
  };

  const merged = {
    ...DEFAULT_CONFIG,
    ...pickDefined(fileConfig),
    ...pickDefined(envLayer),
    ...pickDefined(row),
  };

  const resolved = {
    ...merged,
    configFile,
    baseUrl: String(merged.baseUrl || '').trim().replace(/\/+$/, ''),
    memberHandle: String(merged.memberHandle || 'facai').trim(),
    chatIds: normalizeChatIds(merged.chatIds),
    sessionScope: merged.sessionScope === 'per-chat' ? 'per-chat' : 'member',
    wait: clampNumber(merged.wait, { min: 0, max: 30, fallback: 25 }),
    limit: clampNumber(merged.limit, { min: 1, max: 1000, fallback: 100 }),
    replyTimeoutMs: clampNumber(merged.replyTimeoutMs, { min: 5_000, max: 3_600_000, fallback: 120_000 }),
    maxReplyChars: clampNumber(merged.maxReplyChars, { min: 200, max: 100_000, fallback: 8000 }),
    maxBackoffMs: clampNumber(merged.maxBackoffMs, { min: 1_000, max: 600_000, fallback: 30_000 }),
    sourceMarker: String(merged.sourceMarker || DEFAULT_MARKER_TEMPLATE),
    cwd: String(merged.cwd || '').trim(),
    stateFile: expandHome(String(merged.stateFile || ''), env) || path.join(defaultDataDir(env), 'state.json'),
    logLevel: String(merged.logLevel || 'info'),
  };

  if (!resolved.token) {
    const tokenEnvName = String(merged.tokenEnv || 'CAMPFIRE_TOKEN');
    resolved.token = String(env[tokenEnvName] || '').trim();
  }
  if (!resolved.token) {
    resolved.token = await readSecretFile(expandHome(String(merged.tokenFile || ''), env), log);
  }
  resolved.token = String(resolved.token || '').trim();

  return resolved;
}

/** 给人看的一句话摘要（不含 token）。 */
export function describeConfig(config) {
  const chats = config.chatIds?.length ? config.chatIds.join(',') : '(未配置)';
  return [
    `baseUrl=${config.baseUrl || '(未配置)'}`,
    `member=${config.memberHandle}`,
    `chats=${chats}`,
    `scope=${config.sessionScope}`,
    `token=${config.token ? '已配置' : '缺失'}`,
    `state=${config.stateFile}`,
  ].join(' ');
}
