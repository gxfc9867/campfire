/**
 * @ 提及解析。
 *
 * 中文和英文的边界规则必须不同，否则两头都会错：
 * - 英文：要求右侧是词边界，否则 @ruyi 会命中 @ruyi2；
 * - 中文：**不能**要求边界，因为「@如意你帮我看下」是最常见的写法，
 *   中间不会加空格。多个名字同起点时取更长的那个。
 */

const ALL_TOKENS = ['@所有人', '@全体成员', '@全体', '@all', '@everyone'];

export function hasBroadcast(text) {
  const lower = String(text || '').toLowerCase();
  for (const t of ALL_TOKENS) {
    const idx = lower.indexOf(t);
    if (idx < 0) continue;
    // 纯英文的 token（@all）需要边界，否则 @allow 会被误判成广播
    if (/^@[a-z]+$/.test(t)) {
      const after = lower[idx + t.length] || '';
      if (/[a-z0-9_-]/.test(after)) continue;
    }
    return true;
  }
  return false;
}

/**
 * 找出所有被提及的位置，同一位置只保留最长的那个名字。
 * @returns {Map<number, {handle: string, len: number}>} 起始下标 -> 命中
 */
function findMentions(body, candidates) {
  const lower = body.toLowerCase();
  const hits = new Map();

  for (const m of candidates) {
    const names = [m.handle, m.display, ...(m.aliases || [])].filter(Boolean);
    for (const name of names) {
      const needle = `@${name}`.toLowerCase();
      const isAscii = /^[a-z0-9_-]+$/i.test(name);

      let idx = lower.indexOf(needle);
      while (idx >= 0) {
        const after = lower[idx + needle.length] || '';
        // 英文/数字名要词边界；中文名不加限制
        const boundaryOk = isAscii ? !/[a-z0-9_-]/.test(after) : true;
        if (boundaryOk) {
          const cur = hits.get(idx);
          if (!cur || name.length > cur.len) {
            hits.set(idx, { handle: m.handle, len: name.length });
          }
        }
        idx = lower.indexOf(needle, idx + 1);
      }
    }
  }
  return hits;
}

/**
 * 从正文里解析出目标成员。
 *
 * @param {string} text 消息正文
 * @param {Array<{handle:string, display:string, aliases?:string[]}>} candidates 当前会话的成员
 * @param {{broadcastToAll?: boolean}} opts
 * @returns {{targets: string[], broadcast: boolean}}
 */
export function parseTargets(text, candidates, { broadcastToAll = true } = {}) {
  const body = String(text || '');
  const broadcast = hasBroadcast(body);
  const hits = findMentions(body, candidates);
  const named = [...new Set([...hits.values()].map((h) => h.handle))];

  if (broadcast && broadcastToAll) {
    // 显式点名优先：@所有人 的同时被点名的人不会因为去重而漏掉
    const all = candidates.map((m) => m.handle);
    return { targets: [...new Set([...named, ...all])], broadcast: true };
  }

  return { targets: named, broadcast };
}
