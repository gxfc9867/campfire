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

  chats: () => request('/api/chats'),
  createChat: (name) => request('/api/chats', { method: 'POST', body: { name } }),
  renameChat: (id, name) => request(`/api/chats/${id}`, { method: 'PATCH', body: { name } }),
  deleteChat: (id) => request(`/api/chats/${id}`, { method: 'DELETE' }),
  markRead: (id, seq) => request(`/api/chats/${id}/read`, { method: 'POST', body: { seq } }),

  messages: (chatId, params = {}) => {
    const q = new URLSearchParams({ chat: chatId, ...params });
    return request(`/api/messages?${q}`);
  },
  send: (chatId, text, clientId) =>
    request('/api/messages', { method: 'POST', body: { chat: chatId, text, clientId } }),

  status: (chatId) => request(`/api/status${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`),
  jobs: (chatId) => request(`/api/jobs?chat=${encodeURIComponent(chatId)}`),
  retryJob: (id) => request(`/api/jobs/${id}/retry`, { method: 'POST' }),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  members: () => request('/api/members'),
  member: (handle) => request(`/api/members/${handle}?reveal=1`),
  createMember: (payload) => request('/api/members', { method: 'POST', body: payload }),
  updateMember: (handle, payload, etag) =>
    request(`/api/members/${handle}`, { method: 'PATCH', body: { ...payload, etag } }),
  archiveMember: (handle, etag) =>
    request(`/api/members/${handle}`, { method: 'DELETE', headers: { 'If-Match': etag } }),
  rotateKey: (handle) => request(`/api/members/${handle}/rotate`, { method: 'POST' }),
  probeMember: (handle) => request(`/api/members/${handle}/probe`, { method: 'POST' }),
  saveMemory: (handle, digest) =>
    request(`/api/members/${handle}/memory`, { method: 'PUT', body: { digest } }),
  avatars: () => request('/api/avatars'),

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
