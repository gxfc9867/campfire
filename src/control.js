/**
 * 「停止」信号的暂存区。
 *
 * 用户在围炉里点停止时，成员那边的 agent 正卡在等待回复里（拉流被阻塞），
 * 收不到新消息。所以这里用一个带过期时间的内存标记：围炉侧写入，插件侧
 * 用独立的短轮询取走。取走即清除，避免重复停止。
 *
 * 单进程内存即可：围炉是单实例部署，停止信号本身也只活几十秒。
 */

const TTL_MS = 60_000;

/** chatId → 过期时间戳 */
const stops = new Map();

/** 记一次停止请求。 */
export function requestStop(chatId, ttlMs = TTL_MS) {
  if (!chatId) return;
  stops.set(String(chatId), Date.now() + Math.max(1_000, ttlMs));
}

/** 取走并消费一次停止请求；没有或已过期返回 false。 */
export function takeStop(chatId) {
  const key = String(chatId);
  const until = stops.get(key);
  if (!until) return false;
  stops.delete(key);
  return until > Date.now();
}

/** 只读：是否有待处理的停止请求（不消费）。 */
export function hasStop(chatId) {
  const until = stops.get(String(chatId));
  return Boolean(until && until > Date.now());
}

/** 清理过期项，定时器调用。 */
export function sweepStops(now = Date.now()) {
  for (const [key, until] of stops) {
    if (until <= now) stops.delete(key);
  }
}
