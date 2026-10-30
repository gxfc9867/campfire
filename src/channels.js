import crypto from 'node:crypto';
import { shortId } from './id.js';
import { badRequest, notFound } from './errors.js';

const TOKEN_PREFIX = 'cf_';

/**
 * 渠道（v1 接入方）。
 *
 * 一个渠道 = 一个成员的一把钥匙。刻意不允许多成员共用一把：
 * 泄密半径最小，权限模型也最简单。
 *
 * token 只在创建时明文返回一次，库里只存 sha256 —— 与成员密钥同一套思路。
 */
export class Channels {
  constructor({ store, members }) {
    this.store = store;
    this.members = members;
  }

  static hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  create({ member, name, scopes }) {
    const m = this.members.get(member);
    if (!m) throw badRequest(`成员不存在：${member}`);
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const channel = this.store.createChannel({
      id: shortId('ch_'),
      member,
      name: String(name || m.display || member).slice(0, 64),
      tokenHash: Channels.hashToken(token),
      scopes: Array.isArray(scopes) && scopes.length ? scopes : ['read', 'write'],
    });
    // 明文只在这一次返回
    return { channel, token };
  }

  /** @returns 渠道对象或 null */
  verify(token) {
    const raw = String(token || '').trim();
    if (!raw.startsWith(TOKEN_PREFIX)) return null;
    const ch = this.store.findChannelByTokenHash(Channels.hashToken(raw));
    if (!ch) return null;
    // 记录使用时间，便于排查长期不用的钥匙
    this.store.touchChannel(ch.id);
    return ch;
  }

  list(member) {
    return this.store.listChannels(member);
  }

  revoke(id) {
    const ch = this.store.getChannel(id);
    if (!ch) throw notFound('渠道不存在');
    return this.store.revokeChannel(id);
  }
}
