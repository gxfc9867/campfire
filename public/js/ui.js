/**
 * 渲染小工具。
 * 只做「把数据变成 DOM / 字符串」这一件事，不碰业务状态。
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 文本一律走 textContent，只有需要拼 HTML 时才用这个做转义。 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** 由 handle 稳定地取一个色相：改备注名不换色，这是刻意的。 */
export function hueOf(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function firstChar(name) {
  const s = String(name || '?').trim();
  // 英文名取首字母，中文取首字
  return /^[a-zA-Z]/.test(s) ? s[0].toUpperCase() : s.slice(0, 1);
}

/**
 * 「首字 + 纯色底」头像。
 * 用 SVG data URI 而非 canvas：分辨率无损、可缓存、深浅主题下都不糊。
 */
export function initialAvatar(display, handle, salt = 0) {
  const hue = hueOf(`${handle}:${salt}`);
  const bg = `hsl(${hue} 58% 46%)`;
  const ch = esc(firstChar(display));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${bg}"/>` +
    `<text x="32" y="33" font-size="30" font-weight="600" fill="#fff" text-anchor="middle" ` +
    `dominant-baseline="central" font-family="-apple-system,Segoe UI,PingFang SC,sans-serif">${ch}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 成员头像：预设模板走静态文件，其余走首字生成。 */
export function avatarUrl(member, base = '') {
  const a = member?.avatar || 'initial';
  if (a.startsWith('preset:')) return `${base}/avatars/preset-${a.slice(7)}.svg`;
  if (a.startsWith('upload:')) return `${base}/uploads/${a.slice(7)}`;
  return initialAvatar(member?.display || member?.handle, member?.handle || 'x', member?.avatarSalt || 0);
}

export function avatarEl(member, base = '', cls = 'msg-avatar') {
  const wrap = document.createElement('div');
  wrap.className = cls;
  const img = document.createElement('img');
  img.src = avatarUrl(member, base);
  img.alt = '';
  img.loading = 'lazy';
  wrap.append(img);
  return wrap;
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}

export function fmtRelative(ts) {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === now.toDateString()) return '今天';
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/** 状态徽标的三态文案，只在这里定义，避免各处说法不一。 */
export function presenceLabel(p, driverType) {
  if (!p) return { text: '未知', cls: 'is-offline' };
  if (p.ready) return { text: driverType === 'pull' ? '在线' : '就绪', cls: 'is-ready' };
  if (p.reachable) return { text: '可唤醒', cls: 'is-wakeable' };
  return { text: '离线', cls: 'is-offline' };
}
