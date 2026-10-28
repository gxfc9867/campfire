/**
 * 测试脚手架。
 *
 * 每个测试文件都在自己的临时数据目录里起一个完整实例，
 * 互不干扰，也不会污染项目里的 data/。
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createApp } = await import('../src/server.js');

export async function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-test-'));
  const app = createApp({
    config: {
      dataDir: dir,
      port: 0, // 交给系统分配，避免并行测试抢端口
      host: '127.0.0.1',
      ownerKey: 'test-owner-key',
      ownerKeySource: 'env',
      ownerKeyGenerated: false,
    },
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  return {
    app,
    base,
    dir,
    async close() {
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 带 Cookie 的主人客户端。 */
export function ownerClient(base) {
  let cookie = '';

  async function req(method, pathname, body) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      cookie = c.split(';')[0];
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    patch: (p, b) => req('PATCH', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),
    login: async (password = 'test-owner-key') => req('POST', '/api/login', { password }),
    get cookie() {
      return cookie;
    },
  };
}

/** 成员客户端。 */
export function memberClient(base, handle, key) {
  async function req(method, pathname, body) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'X-Campfire-Member': handle,
        'X-Campfire-Key': key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }
  return {
    inbox: (wait = 0) => req('GET', `/api/agent/inbox?wait=${wait}`),
    reply: (requestId, text) => req('POST', '/api/agent/reply', { requestId, text }),
    ack: (requestIds) => req('POST', '/api/agent/ack', { requestIds }),
    state: (payload) => req('POST', '/api/agent/state', payload),
    profile: () => req('GET', '/api/agent/profile'),
    prompt: (chat) => req('GET', `/api/agent/prompt?chat=${chat}`),
    memory: () => req('GET', '/api/agent/memory'),
    setMemory: (digest) => req('PUT', '/api/agent/memory', { digest }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一个 cli 驱动的成员，返回明文密钥。 */
export async function createMember(owner, overrides = {}) {
  const r = await owner.post('/api/members', {
    handle: 'echo',
    display: '回声',
    persona: '你只复述对方的话',
    driver: { type: 'cli', cmd: 'echo', args: ['{{prompt}}'] },
    chats: ['main'],
    ...overrides,
  });
  if (r.status !== 200) throw new Error(`建成员失败：${JSON.stringify(r.data)}`);
  return r.data;
}
