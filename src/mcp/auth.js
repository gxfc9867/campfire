import crypto from 'node:crypto';

/**
 * MCP 面的鉴权。
 *
 * 与 HTTP API 的差别：浏览器那边靠 Cookie 会话，MCP 客户端（DSH、Inspector、
 * 各种脚本）没有浏览器，只能用 `Authorization: Bearer <token>`。
 *
 * 令牌形态两种，都不需要新建数据表——直接复用已有的两把钥匙：
 *   1. 主人口令（data/owner-key.txt）→ 主人身份，可读写全部会话；
 *   2. `<handle>:<成员密钥>`         → 该成员身份，只能碰自己所在的会话。
 * 第二种把「以谁的身份说话」编码进令牌本身，省掉一个头，也符合
 * docs/design/CONNECTION-DRAFT.md §3「token 内嵌 memberHandle」的约定。
 *
 * 刻意不做 scope 表：单人自托管场景下，权限只有「主人 / 某个成员」两档，
 * 多一层 scope 解析只会多一处能写错的地方。
 */

/** 定长比较，避免按响应时间逐字符猜口令。长度不同直接判否。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function createMcpAuth({ config, members, store }) {
  const ownerKey = String(config?.ownerKey || '');

  /**
   * 从请求里认出身份。
   * @returns {{kind:'owner'|'member', handle:string, display:string}|null}
   *   null 表示没带令牌或令牌不对——调用方据此回 401，不区分「没带」和「错了」，
   *   否则等于告诉攻击者「这把钥匙存在，只是配错了」。
   */
  function identify(req) {
    const header = String(req?.headers?.authorization || '').trim();
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return null;
    const raw = m[1].trim();
    if (!raw) return null;

    // 主人口令优先：它是唯一能升到「读写全部」的钥匙
    if (ownerKey && safeEqual(raw, ownerKey)) {
      return { kind: 'owner', handle: 'user', display: '主人' };
    }

    // 成员令牌：handle:key，两边都非空才解析
    const sep = raw.indexOf(':');
    if (sep > 0) {
      const handle = raw.slice(0, sep).trim().toLowerCase();
      const key = raw.slice(sep + 1).trim();
      if (handle && key && members.verifyKey(handle, key)) {
        const member = members.get(handle);
        return { kind: 'member', handle, display: member?.display || handle };
      }
    }
    return null;
  }

  /**
   * 能不能碰这个会话。
   *
   * 主人的边界是「全部会话」；成员的边界是「我所在的会话」——
   * 与 /api/agent/* 的既有语义保持一致（成员只能操作自己的收件箱）。
   * 私聊的归属由 store.listMembersOf 按 peer 推导，所以成员能进自己的私聊。
   */
  function canAccess(identity, chatId) {
    if (!identity || !chatId) return false;
    if (identity.kind === 'owner') return true;
    return store.listMembersOf(chatId).includes(identity.handle);
  }

  return { identify, canAccess, ownerKeyPresent: Boolean(ownerKey) };
}
