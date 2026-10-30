import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import mockModule from '../mock-campfire.cjs';
import { createBridge } from '../src/bridge.js';
import { createStateStore } from '../src/bindings.js';
import { createCampfireClient } from '../src/campfire-client.js';
import { DEFAULT_MARKER_TEMPLATE } from '../src/format.js';

const { createMockCampfire } = mockModule;
const TOKEN = 'test-token';

const BASE_CONFIG = {
  chatIds: ['main'],
  wait: 0,
  limit: 100,
  sessionScope: 'member',
  memberHandle: 'facai',
  sourceMarker: DEFAULT_MARKER_TEMPLATE,
  replyTimeoutMs: 5_000,
  maxReplyChars: 8_000,
  maxBackoffMs: 1_000,
};

function createFakeHost({ reply = '收到', askThrows = false } = {}) {
  const calls = { create: [], open: [], ask: [], inject: [] };
  const openable = new Set();
  let counter = 0;
  return {
    calls,
    openable,
    mintSessionId(chatId) {
      counter += 1;
      return `campfire-${chatId}-s${counter}`;
    },
    async openSession({ sessionId }) {
      calls.open.push(sessionId);
      return openable.has(sessionId) ? { agent: { id: sessionId } } : { error: 'not_found' };
    },
    async createSession({ sessionId, chatId }) {
      calls.create.push({ sessionId, chatId });
      openable.add(sessionId);
      return { id: sessionId };
    },
    async ask({ sessionId, text }) {
      calls.ask.push({ sessionId, text });
      if (askThrows) throw new Error('模型炸了');
      return reply;
    },
    async inject({ sessionId, text }) {
      calls.inject.push({ sessionId, text });
      return true;
    },
    async dispose() {},
  };
}

async function setup({ config = {}, hostOptions } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campfire-bridge-'));
  const mock = createMockCampfire({ token: TOKEN, memberHandle: 'facai', chatId: 'main' });
  const { baseUrl } = await mock.start(0);
  const client = createCampfireClient({ baseUrl, token: TOKEN });
  const store = createStateStore({ filePath: path.join(dir, 'state.json') });
  await store.load();
  const host = createFakeHost(hostOptions);
  const logs = [];
  const bridge = createBridge({
    client,
    store,
    host,
    config: { ...BASE_CONFIG, ...config },
    log: (level, message) => logs.push([level, message]),
  });
  return {
    dir,
    mock,
    client,
    store,
    host,
    bridge,
    logs,
    async close() {
      await bridge.stop();
      client.close('test');
      await mock.stop();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function craftedUpdate({
  chatId = 'main',
  seq = 1,
  text = 'hi',
  wakeup = 'reply',
  sender = { kind: 'user', handle: 'gongxi', display: '恭喜' },
} = {}) {
  return {
    updateId: `${chatId}:${seq}`,
    type: 'message.created',
    chatId,
    seq,
    wakeup,
    replyRequired: wakeup === 'reply',
    message: {
      id: `msg_${seq}`,
      chatId,
      seq,
      sender,
      type: 'text',
      text,
      attachments: [],
      createdAt: Date.now(),
    },
  };
}

test('reply 级别：投进会话 → 拿回复 → 发回围炉 → 推进游标', async () => {
  const ctx = await setup({ hostOptions: { reply: '在，有事说' } });
  try {
    const { message } = ctx.mock.injectMessage({ text: '@facai 在吗', mentions: ['facai'] });
    const count = await ctx.bridge.pollChat('main');
    assert.equal(count, 1);

    assert.equal(ctx.host.calls.create.length, 1);
    assert.equal(ctx.host.calls.ask.length, 1);
    assert.match(ctx.host.calls.ask[0].text, /^\[来自围炉\/群 main\/成员 恭喜\] @facai 在吗$/);

    const outbox = ctx.mock.outbox().messages;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].text, '在，有事说');
    assert.equal(outbox[0].replyTo, message.id);
    assert.equal(ctx.store.getCursor('main'), 1);
    assert.equal(ctx.bridge.stats.replies, 1);
  } finally {
    await ctx.close();
  }
});

test('同一群第二条消息复用同一个会话（成员:会话 = 1:1）', async () => {
  const ctx = await setup();
  try {
    ctx.mock.injectMessage({ text: '@facai 一', mentions: ['facai'] });
    await ctx.bridge.pollChat('main');
    ctx.mock.injectMessage({ text: '@facai 二', mentions: ['facai'] });
    await ctx.bridge.pollChat('main');

    assert.equal(ctx.host.calls.create.length, 1);
    assert.equal(ctx.host.calls.ask.length, 2);
    assert.equal(ctx.host.calls.ask[0].sessionId, ctx.host.calls.ask[1].sessionId);
  } finally {
    await ctx.close();
  }
});

test('notify 级别：只注入不唤醒，不发帖', async () => {
  const ctx = await setup();
  try {
    ctx.mock.injectMessage({ text: '今天天气不错', mentions: [] });
    await ctx.bridge.pollChat('main');
    assert.equal(ctx.host.calls.inject.length, 1);
    assert.equal(ctx.host.calls.ask.length, 0);
    assert.equal(ctx.mock.outbox().messages.length, 0);
    assert.equal(ctx.bridge.stats.injected, 1);
  } finally {
    await ctx.close();
  }
});

test('wakeup=none 的消息只推进游标', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.bridge.handleUpdate(craftedUpdate({ wakeup: 'none' }));
    assert.equal(result.reason, 'wakeup_none');
    assert.equal(ctx.host.calls.ask.length, 0);
    assert.equal(ctx.host.calls.inject.length, 0);
  } finally {
    await ctx.close();
  }
});

test('跳过本成员自己发的消息（不自激）', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.bridge.handleUpdate(
      craftedUpdate({ sender: { kind: 'member', handle: 'facai', display: '发财' } }),
    );
    assert.equal(result.reason, 'self');
    assert.equal(ctx.host.calls.ask.length, 0);
  } finally {
    await ctx.close();
  }
});

test('不在 chatIds 里的群一律不处理', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.bridge.handleUpdate(craftedUpdate({ chatId: 'other' }));
    assert.equal(result.reason, 'chat_not_allowed');
  } finally {
    await ctx.close();
  }
});

test('重复投递同一 updateId 只处理一次', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campfire-dedupe-'));
  const store = createStateStore({ filePath: path.join(dir, 'state.json') });
  await store.load();
  const host = createFakeHost();
  const acks = [];
  const update = craftedUpdate();
  const client = {
    async updates() {
      return { updates: [update], nextCursor: update.seq };
    },
    async ack({ chat, cursor }) {
      acks.push([chat, cursor]);
      return { ok: true };
    },
    async sendMessage() {
      return { message: {} };
    },
    close() {},
  };
  const bridge = createBridge({ client, store, host, config: BASE_CONFIG, log: () => {} });
  try {
    await bridge.pollChat('main');
    await bridge.pollChat('main');
    assert.equal(host.calls.ask.length, 1, '第二次是重复投递，不能再唤醒一次');
    assert.equal(acks.length, 2, '重复投递也要 ack，避免服务端一直重发');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('单个成员处理失败不阻塞群：游标照推、失败计数', async () => {
  const ctx = await setup({ hostOptions: { askThrows: true } });
  try {
    ctx.mock.injectMessage({ text: '@facai 你好', mentions: ['facai'] });
    const count = await ctx.bridge.pollChat('main');
    assert.equal(count, 1);
    assert.equal(ctx.bridge.stats.failures, 1);
    assert.equal(ctx.store.getCursor('main'), 1);
    assert.equal(ctx.mock.outbox().messages.length, 0);
  } finally {
    await ctx.close();
  }
});

test('绑定的会话盘上没有记录 → 同 id 重建，绑定不漂移', async () => {
  const ctx = await setup();
  try {
    await ctx.store.setBinding('*', { sessionId: 'campfire-main-gone', chatId: 'main' });
    ctx.mock.injectMessage({ text: '@facai 还在吗', mentions: ['facai'] });
    await ctx.bridge.pollChat('main');

    assert.deepEqual(ctx.host.calls.open, ['campfire-main-gone']);
    assert.equal(ctx.host.calls.create.length, 1);
    assert.equal(ctx.host.calls.create[0].sessionId, 'campfire-main-gone');
    assert.equal(ctx.store.getBinding('*').sessionId, 'campfire-main-gone');
  } finally {
    await ctx.close();
  }
});

test('绑定的会话被别的进程占用 → 换新 id，不撞 AlreadyOwned', async () => {
  const ctx = await setup();
  try {
    ctx.host.calls.open.length = 0;
    ctx.host.openSession = async ({ sessionId }) => {
      ctx.host.calls.open.push(sessionId);
      return { error: 'owned', message: 'session already owned' };
    };
    await ctx.store.setBinding('*', { sessionId: 'campfire-main-owned', chatId: 'main' });
    ctx.mock.injectMessage({ text: '@facai 在吗', mentions: ['facai'] });
    await ctx.bridge.pollChat('main');

    assert.equal(ctx.host.calls.create.length, 1);
    assert.notEqual(ctx.host.calls.create[0].sessionId, 'campfire-main-owned');
    assert.equal(ctx.store.getBinding('*').sessionId, 'campfire-main-s1');
  } finally {
    await ctx.close();
  }
});

test('per-chat 模式下每个群各自一个绑定键', async () => {
  const ctx = await setup({ config: { chatIds: ['main', 'nas'], sessionScope: 'per-chat' } });
  try {
    assert.equal(ctx.bridge.scopeKey('main'), 'main');
    assert.equal(ctx.bridge.scopeKey('nas'), 'nas');
  } finally {
    await ctx.close();
  }
});

test('模型没产出文本时只 ack 不发空帖', async () => {
  const ctx = await setup({ hostOptions: { reply: '   ' } });
  try {
    ctx.mock.injectMessage({ text: '@facai 在吗', mentions: ['facai'] });
    await ctx.bridge.pollChat('main');
    assert.equal(ctx.mock.outbox().messages.length, 0);
    assert.equal(ctx.store.getCursor('main'), 1);
  } finally {
    await ctx.close();
  }
});

test('start/stop：后台拉流能收到消息，stop 后进程不再有挂起请求', async () => {
  const ctx = await setup({ config: { wait: 5 } });
  try {
    ctx.bridge.start();
    ctx.mock.injectMessage({ text: '@facai 后台收到没', mentions: ['facai'] });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && ctx.mock.outbox().messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ctx.mock.outbox().messages.length, 1);

    await ctx.bridge.stop();
    // 回复自身也会回流入流（真围炉只有一条消息流），bridge 拉到后按 isSelf 跳过并推进游标，
    // 所以这里只断言「注入的那条已被确认」，不锁死具体 seq。
    assert.ok(ctx.store.getCursor('main') >= 1, `游标应已推进，实际 ${ctx.store.getCursor('main')}`);
  } finally {
    await ctx.close();
  }
});
