import crypto from 'node:crypto';

/**
 * 短标识生成。
 * 消息、任务、会话都用 12 位十六进制（48 bit），在本项目的量级下碰撞概率可忽略，
 * 同时比 UUID 短，方便在 URL 和日志里看。
 */
export function shortId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

/** 24 位，用于需要更强唯一性的场合（例如成员密钥）。 */
export function longId(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}
