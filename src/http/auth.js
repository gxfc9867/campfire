import crypto from 'node:crypto';
import { parseCookies } from './util.js';

/**
 * 鉴权。
 *
 * 两种身份：
 * 1. owner —— 主人。浏览器用口令换取会话 Cookie；可读写一切。
 * 2. member —— 成员。用「handle + 密钥」两个头；只能操作自己的收件箱与记忆。
 *
 * 刻意不做多用户与角色系统：这是单人自托管工具，多角色只会增加攻击面。
 */
export class Auth {
  constructor({ config, members }) {
    this.config = config;
    this.members = members;
    this.cookieName = 'cf_session';
    this.sessions = new Map(); // token -> expiresAt

    // 定期清理过期会话，避免长期运行后 map 膨胀
    this.timer = setInterval(() => this.sweep(), 10 * 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    this.sessions.clear();
  }

  sweep() {
    const now = Date.now();
    for (const [token, exp] of this.sessions) if (exp < now) this.sessions.delete(token);
  }

  /** 口令正确则签发会话，返回 token；否则 null。 */
  login(password) {
    const given = String(password || '');
    const expected = String(this.config.ownerKey || '');
    if (!expected) return null;
    // 定长比较，避免按响应时间猜字符
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, Date.now() + this.config.sessionTtlMs);
    return token;
  }

  logout(token) {
    if (token) this.sessions.delete(token);
  }

  cookieHeader(token) {
    const maxAge = Math.floor(this.config.sessionTtlMs / 1000);
    const path = this.config.basePath || '/';
    const secure = this.config.publicUrl.startsWith('https://') ? '; Secure' : '';
    // SameSite=Lax 足够挡住跨站写操作，又不影响从外部链接点进来
    return `${this.cookieName}=${encodeURIComponent(token)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
  }

  clearCookieHeader() {
    const path = this.config.basePath || '/';
    return `${this.cookieName}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;
  }

  /**
   * 解析请求身份。
   * 成员判定必须在主人判定之前：成员密钥只代表它自己，永远不能升级成主人。
   */
  identify(req) {
    const handle = String(req.headers['x-campfire-member'] || '').trim();
    const key = String(req.headers['x-campfire-key'] || '').trim();
    if (handle && key) {
      if (this.members.verifyKey(handle, key)) {
        return { kind: 'member', member: handle };
      }
      return { kind: 'anon', reason: 'bad_member_key' };
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[this.cookieName];
    if (token) {
      const exp = this.sessions.get(token);
      if (exp && exp > Date.now()) return { kind: 'owner', token };
      this.sessions.delete(token);
    }
    return { kind: 'anon' };
  }

  get sessionCookieName() {
    return this.cookieName;
  }
}
