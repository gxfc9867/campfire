/**
 * 围炉消息 ↔ DSH 会话文本的格式约定。
 *
 * 关键要求（`docs/design/CONNECTION-DRAFT.md` §6.4 不可信上下文）：
 * 投进会话的每条外部消息都必须带**来源标记**，让模型知道这是「群里的数据」而不是用户指令。
 */

/** 默认来源标记模板；`{chat}` `{sender}` 会被替换。 */
export const DEFAULT_MARKER_TEMPLATE = '[来自围炉/群 {chat}/成员 {sender}]';

const MAX_INBOUND_CHARS = 20_000;

export function fillTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match,
  );
}

/** 一条消息的来源标记，例如 `[来自围炉/群 main/成员 恭喜]`。 */
export function sourceMarker({ chatId, chatTitle, senderDisplay, senderHandle }, template = DEFAULT_MARKER_TEMPLATE) {
  const chat = chatTitle || chatId || '未知群';
  const sender = senderDisplay || senderHandle || '未知成员';
  return fillTemplate(template, { chat, chatId, sender, handle: senderHandle ?? '' });
}

function attachmentLines(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  return attachments.map((item) => {
    const name = item?.name ?? item?.id ?? '未命名附件';
    const mime = item?.mime ?? 'application/octet-stream';
    const size = Number.isFinite(item?.size) ? `${item.size}B` : '未知大小';
    const url = item?.url ? ` ${item.url}` : '';
    return `[附件] ${name} (${mime}, ${size})${url}`;
  });
}

/**
 * 把一条围炉消息渲染成注入会话的文本：`来源标记 + 正文 + 附件行`。
 * 超长正文会截断并明确标注，避免把上下文一次打满。
 */
export function renderInboundMessage({ message, chatId, chatTitle, markerTemplate } = {}) {
  const sender = message?.sender ?? {};
  const marker = sourceMarker(
    {
      chatId: chatId ?? message?.chatId,
      chatTitle,
      senderDisplay: sender.display,
      senderHandle: sender.handle,
    },
    markerTemplate,
  );

  let text = typeof message?.text === 'string' ? message.text : '';
  let truncated = false;
  if (text.length > MAX_INBOUND_CHARS) {
    text = text.slice(0, MAX_INBOUND_CHARS);
    truncated = true;
  }

  const head = `${marker} ${text}`.trimEnd();
  const lines = [head, ...attachmentLines(message?.attachments)];
  if (truncated) lines.push(`[已截断] 原文超过 ${MAX_INBOUND_CHARS} 字，只投递前 ${MAX_INBOUND_CHARS} 字`);
  return lines.join('\n');
}

/**
 * 出站文本整理：去掉首尾空白与模型常见的包裹引号，保留内部换行。
 * 返回 null 表示「没有可发的内容」。
 */
export function normalizeOutboundText(input, { maxChars = 8000 } = {}) {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;
  text = text.replace(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/u, '$1').trim();
  if (!text) return null;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（回复过长已截断）`;
  return text;
}
