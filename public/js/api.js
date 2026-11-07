/**
 * 接口封装。
 * 所有请求都带 same-origin 凭据；错误统一抛 ApiError，调用方只需要处理 message。
 */

const BASE = (document.querySelector('meta[name="cf-base"]')?.content || '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.code || 'error', data?.error || `请求失败（${res.status}）`);
  }
  return data;
}

export const api = {
  base: BASE,
  me: () => request('/api/me'),
  login: (password) => request('/api/login', { method: 'POST', body: { password } }),
  logout: () => request('/api/logout', { method: 'POST' }),

  chats: (opts) => request(`/api/chats${opts?.archived ? '?archived=1' : ''}`),
  createChat: (name) => request('/api/chats', { method: 'POST', body: { name } }),
  createDm: (handle) => request('/api/chats/dm', { method: 'POST', body: { handle } }),
  renameChat: (id, name) => request(`/api/chats/${id}`, { method: 'PATCH', body: { name } }),
  deleteChat: (id) => request(`/api/chats/${id}`, { method: 'DELETE' }),
  /** 归档：只收进归档列表，成员归属不动，可恢复。 */
  archiveChat: (id) => request(`/api/chats/${id}/archive`, { method: 'POST' }),
  restoreChat: (id) => request(`/api/chats/${id}/restore`, { method: 'POST' }),
  markRead: (id, seq) => request(`/api/chats/${id}/read`, { method: 'POST', body: { seq } }),

  messages: (chatId, params = {}) => {
    const q = new URLSearchParams({ chat: chatId, ...params });
    return request(`/api/messages?${q}`);
  },
  send: (chatId, text, clientId, quote = null, attachmentIds = null) =>
    request('/api/messages', {
      method: 'POST',
      body: { chat: chatId, text, clientId, quote, attachmentIds },
    }),
  editMessage: (id, text) => request(`/api/messages/${id}`, { method: 'PATCH', body: { text } }),
  deleteMessage: (id) => request(`/api/messages/${id}`, { method: 'DELETE' }),
  /** 让正在跑这一轮的成员中断生成（对标 DSH 会话里的「停止」）。 */
  stopChat: (chat) => request('/api/stop', { method: 'POST', body: { chat } }),
  /** 会话导出地址：用 <a download> 直接打开，靠 cookie 鉴权。 */
  exportChatUrl: (id, format = 'md') =>
    `/api/chats/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,

  // 附件
  uploadFile: async (file, chat) => {
    const res = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        'x-chat': chat,
        'x-filename': encodeURIComponent(file.name || 'file'),
        'content-type': file.type || 'application/octet-stream',
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.code || 'upload_failed', data.message || `上传失败（HTTP ${res.status}）`);
    return data.attachment;
  },

  // 定时消息
  schedules: (chat) => request(`/api/schedules${chat ? `?chat=${encodeURIComponent(chat)}` : ''}`),
  createSchedule: ({ chat, cron, text }) =>
    request('/api/schedules', { method: 'POST', body: { chat, cron, text } }),
  updateSchedule: (id, patch) =>
    request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deleteSchedule: (id) =>
    request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  status: (chatId) => request(`/api/status${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`),
  jobs: (chatId) => request(`/api/jobs?chat=${encodeURIComponent(chatId)}`),
  retryJob: (id) => request(`/api/jobs/${id}/retry`, { method: 'POST' }),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  members: (opts) => request(`/api/members${opts?.archived ? '?archived=1' : ''}`),
  member: (handle) => request(`/api/members/${handle}?reveal=1`),
  createMember: (payload) => request('/api/members', { method: 'POST', body: payload }),
  updateMember: (handle, payload, etag) =>
    request(`/api/members/${handle}`, { method: 'PATCH', body: { ...payload, etag } }),
  archiveMember: (handle, etag) =>
    request(`/api/members/${handle}`, { method: 'DELETE', headers: { 'If-Match': etag } }),
  /** 从归档里恢复成员。 */
  restoreMember: (handle) => request(`/api/members/${handle}/restore`, { method: 'POST' }),
  /** 彻底删除：从配置里移除，并吊销该成员全部渠道令牌。历史消息保留。 */
  purgeMember: (handle, etag) =>
    request(`/api/members/${handle}/purge`, { method: 'DELETE', headers: { 'If-Match': etag } }),

  // 渠道令牌（v1 接入面：DSH 插件、WorkBuddy 桥都靠它）
  channels: (member) =>
    request(`/api/admin/channels${member ? `?member=${encodeURIComponent(member)}` : ''}`),
  createChannel: (member, name) =>
    request('/api/admin/channels', { method: 'POST', body: { member, name } }),
  revokeChannel: (id) => request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rotateKey: (handle) => request(`/api/members/${handle}/rotate`, { method: 'POST' }),
  probeMember: (handle) => request(`/api/members/${handle}/probe`, { method: 'POST' }),
  saveMemory: (handle, digest) =>
    request(`/api/members/${handle}/memory`, { method: 'PUT', body: { digest } }),
  avatars: () => request('/api/avatars'),
  llmProviders: () => request('/api/llm-providers'),

  /** SSE 只用来「叫醒」，真实数据仍然靠上面的增量接口。 */
  events(chatId, onEvent, onError) {
    const url = `${BASE}/api/events${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`;
    const es = new EventSource(url);
    es.addEventListener('change', (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        onEvent({ type: 'unknown' });
      }
    });
    es.onerror = () => onError?.(es);
    return es;
  },
};
