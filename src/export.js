/**
 * 会话导出。
 *
 * 两种格式，服务两种读者：
 * - Markdown：人和 agent 都能直接读，丢进任何上下文就能当对话记录用
 * - JSON：给需要程序处理的场景（统计、迁移、二次开发）
 *
 * 生成函数都是纯函数（只依赖传进来的数据），方便单测。
 */

import { SENDER } from './constants.js';

/**
 * 导出里所有时间都按这个时区渲染。
 *
 * 不能依赖容器系统时区：镜像里通常没装 tzdata，`TZ` 环境变量不生效，
 * 直接 new Date().getHours() 会按 UTC 输出，导致导出文件比实际早 8 小时。
 * Intl 自带时区数据库，用它可以不依赖系统 tzdata。
 */
const EXPORT_TZ = process.env.CAMPFIRE_TZ || 'Asia/Shanghai';

const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: EXPORT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: EXPORT_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 把 Intl 的分段结果拼成 {y, m, d} / {h, mi, s}。 */
function parts(fmt, ts) {
  const out = {};
  for (const { type, value } of fmt.formatToParts(new Date(ts))) out[type] = value;
  return out;
}

function dateOf(ts) {
  const p = parts(dateFmt, ts);
  return `${p.year}-${p.month}-${p.day}`;
}

function timeOf(ts) {
  const p = parts(timeFmt, ts);
  return `${p.hour}:${p.minute}:${p.second}`;
}

function stampOf(ts) {
  const d = parts(dateFmt, ts);
  const t = parts(timeFmt, ts);
  return `${d.year}${d.month}${d.day}-${t.hour}${t.minute}`;
}

/** 发送者的展示名：主人/系统/成员。 */
function displayOf(msg, members) {
  if (msg.sender === SENDER.user) return '你';
  if (msg.sender === SENDER.system) return '系统';
  return members.get(msg.sender)?.display || msg.sender;
}

/** 文件名里不能出现的字符换成下划线。 */
function safeName(input) {
  return String(input || 'chat').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
}

/**
 * 从消息里解析「引用」，返回可读的一行摘要。
 * 引用关系在 messages 里是 replyTo → 消息 id。
 */
function quoteLine(msg, byId, members) {
  if (!msg.replyTo) return '';
  const q = byId.get(msg.replyTo);
  if (!q) return '';
  const who = displayOf(q, members);
  const text = String(q.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `> ↳ 引用 ${timeOf(q.createdAt)} · ${who}：${text}${text.length >= 80 ? '…' : ''}`;
}

/**
 * 生成 Markdown。
 *
 * @param {{ chat: object, messages: object[], members: Map<string, object>, exportedAt?: number }} input
 */
export function toMarkdown({ chat, messages, members, exportedAt = Date.now() }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const participants = new Map();
  for (const m of messages) {
    if (m.sender === SENDER.system) continue;
    participants.set(m.sender, displayOf(m, members));
  }

  const lines = [];
  lines.push(`# 围炉 · ${chat?.name || chat?.id || '会话'}`);
  lines.push('');
  lines.push(`> 导出时间：${dateOf(exportedAt)} ${timeOf(exportedAt)}  `);
  lines.push(`> 消息数：${messages.length}  `);
  const who = [...participants.entries()]
    .map(([handle, display]) =>
      handle === SENDER.user ? '你' : `${display}（\`@${handle}\`）`,
    )
    .join('、');
  if (who) lines.push(`> 参与：${who}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  let lastDate = null;
  for (const m of messages) {
    const date = dateOf(m.createdAt);
    if (date !== lastDate) {
      lines.push(`## ${date}`);
      lines.push('');
      lastDate = date;
    }

    const display = displayOf(m, members);
    const handle =
      m.sender === SENDER.user || m.sender === SENDER.system ? '' : ` \`@${m.sender}\``;
    const flags = [];
    if (m.meta?.edited) flags.push('已编辑');
    if (m.meta?.deleted) flags.push('已删除');

    lines.push(
      `### ${timeOf(m.createdAt)} · ${display}${handle}${flags.length ? ` （${flags.join(' / ')}）` : ''}`,
    );

    const quote = quoteLine(m, byId, members);
    if (quote) {
      lines.push(quote);
      lines.push('');
    }

    const body = m.meta?.deleted ? '*（这条消息已被删除）*' : String(m.text || '').trim();
    lines.push(body || '*（空）*');
    lines.push('');
  }

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

/**
 * 生成 JSON。
 *
 * 结构刻意扁平：messages 是数组，每条自带 sender 的 handle/display，
 * 引用只留 replyTo（配合 id 就能自己串），不重复塞正文。
 */
export function toJson({ chat, messages, members, exportedAt = Date.now() }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    format: 'campfire.chat.v1',
    exportedAt,
    chat: {
      id: chat?.id ?? null,
      name: chat?.name ?? null,
      kind: chat?.kind ?? null,
      createdAt: chat?.createdAt ?? null,
    },
    members: [...members.values()].map((m) => ({
      handle: m.handle,
      display: m.display,
      // 成员对象上是 driver.type，不是扁平的 driverType
      driverType: m.driver?.type ?? m.driverType ?? null,
    })),
    messageCount: messages.length,
    messages: messages.map((m) => ({
      seq: m.seq,
      id: m.id,
      sender: {
        kind:
          m.sender === SENDER.user
            ? 'user'
            : m.sender === SENDER.system
              ? 'system'
              : 'member',
        handle: m.sender,
        display: displayOf(m, members),
      },
      text: m.text,
      createdAt: m.createdAt,
      replyTo: m.replyTo || null,
      replyPreview: m.replyTo
        ? (() => {
            const q = byId.get(m.replyTo);
            if (!q) return null;
            return { id: q.id, seq: q.seq, sender: displayOf(q, members), text: q.text };
          })()
        : null,
      edited: Boolean(m.meta?.edited),
      deleted: Boolean(m.meta?.deleted),
    })),
  };
}

/** 建议的下载文件名（不含扩展名）。 */
export function exportBaseName(chat, exportedAt = Date.now()) {
  return `围炉-${safeName(chat?.name || chat?.id)}-${stampOf(exportedAt)}`;
}
