import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * sidecar 的配置加载。
 * 单独成文件是为了让 sidecar 与 doctor 共用同一套解析逻辑——
 * 两处各写一遍的话，doctor 说「没问题」而 sidecar 起不来就会很难查。
 */

export const SIDECAR_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEFAULTS = {
  waitSec: 25, // 长轮询挂起秒数，必须小于反代空闲超时
  concurrency: 2, // 本机同时最多跑几个 agent 进程
  allowedCommands: null, // null = 不限制；数组 = 只允许这些命令
};

export function loadConfig() {
  const env = process.env;

  if (env.CAMPFIRE_URL && env.CAMPFIRE_MEMBER && env.CAMPFIRE_KEY) {
    return {
      url: env.CAMPFIRE_URL.replace(/\/+$/, ''),
      concurrency: Number(env.CAMPFIRE_CONCURRENCY) || DEFAULTS.concurrency,
      allowedCommands: env.CAMPFIRE_ALLOWED ? env.CAMPFIRE_ALLOWED.split(',').map((s) => s.trim()) : null,
      members: [
        {
          handle: env.CAMPFIRE_MEMBER,
          key: env.CAMPFIRE_KEY,
        },
      ],
    };
  }

  const file = env.CAMPFIRE_CONFIG || path.join(SIDECAR_ROOT, 'sidecar.config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    const e = new Error(`找不到配置文件 ${file}`);
    e.hint = '复制 sidecar.config.example.json 为 sidecar.config.json，或用环境变量 CAMPFIRE_URL / CAMPFIRE_MEMBER / CAMPFIRE_KEY';
    throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${e.message}`);
  }

  if (!parsed.url) throw new Error('配置缺少 url');
  if (!Array.isArray(parsed.members) || !parsed.members.length) throw new Error('配置缺少 members');

  for (const m of parsed.members) {
    if (!m.handle || !m.key) throw new Error('每个成员都需要 handle 和 key');
  }

  return {
    ...parsed,
    url: String(parsed.url).replace(/\/+$/, ''),
    concurrency: Number(parsed.concurrency) || DEFAULTS.concurrency,
    allowedCommands: Array.isArray(parsed.allowedCommands) ? parsed.allowedCommands : null,
  };
}
