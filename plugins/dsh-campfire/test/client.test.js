import assert from 'node:assert/strict';
import test from 'node:test';

import mockModule from '../mock-campfire.cjs';
import { CampfireError, createCampfireClient } from '../src/campfire-client.js';

const { createMockCampfire } = mockModule;

const TOKEN = 'test-token';

async function withMock(fn) {
  const mock = createMockCampfire({ token: TOKEN, memberHandle: 'facai', chatId: 'main' });
  const { baseUrl } = await mock.start(0);
  try {
    await fn({ mock, baseUrl });
  } finally {
    await mock.stop();
  }
}

test('meta：能力协商字段齐全', async () => {
  await withMock(async ({ baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: TOKEN });
    const meta = await client.meta();
    assert.equal(meta.apiVersion, 1);
    assert.equal(meta.capabilities.cursor, 'seq');
    assert.ok(meta.capabilities.wakeup.includes('reply'));
    client.close();
  });
});

test('鉴权：token 不对时抛 unauthorized，且不泄露 token', async () => {
  await withMock(async ({ baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: 'wrong-token' });
    await assert.rejects(
      () => client.meta(),
      (error) => {
        assert.ok(error instanceof CampfireError);
        assert.equal(error.code, 'unauthorized');
        assert.equal(error.status, 401);
        assert.ok(!String(error.message).includes('wrong-token'));
        return true;
      },
    );
    client.close();
  });
});

test('长轮询：挂起期间新消息能立刻唤醒', async () => {
  await withMock(async ({ mock, baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: TOKEN });
    const pending = client.updates({ chat: 'main', cursor: 0, wait: 5 });
    setTimeout(() => mock.injectMessage({ text: '@facai 在吗', mentions: ['facai'] }), 80);
    const started = Date.now();
    const result = await pending;
    assert.equal(result.updates.length, 1);
    assert.equal(result.updates[0].wakeup, 'reply');
    assert.equal(result.updates[0].replyRequired, true);
    assert.equal(result.nextCursor, 1);
    assert.ok(Date.now() - started < 4_000, '应该被新消息唤醒，而不是等到 wait 到点');
    client.close();
  });
});

test('发送：replyTo 与 clientMsgId 幂等', async () => {
  await withMock(async ({ mock, baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: TOKEN });
    const first = await client.sendMessage({ chatId: 'main', text: '第一条', clientMsgId: 'k-1' });
    const second = await client.sendMessage({ chatId: 'main', text: '第一条', clientMsgId: 'k-1' });
    assert.equal(first.message.id, second.message.id);
    const outbox = mock.outbox();
    assert.equal(outbox.messages.length, 1);
    assert.equal(outbox.messages[0].text, '第一条');
    assert.equal(outbox.messages[0].sender.handle, 'facai');
    client.close();
  });
});

test('ack 之后同一游标不再返回旧 update', async () => {
  await withMock(async ({ mock, baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: TOKEN });
    mock.injectMessage({ text: '一', mentions: ['facai'] });
    const first = await client.updates({ chat: 'main', cursor: 0, wait: 0 });
    assert.equal(first.updates.length, 1);
    await client.ack({ chat: 'main', cursor: first.nextCursor });
    const second = await client.updates({ chat: 'main', cursor: first.nextCursor, wait: 0 });
    assert.equal(second.updates.length, 0);
    client.close();
  });
});

test('未 ack 时重复投递同一 update（at-least-once）', async () => {
  await withMock(async ({ mock, baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: TOKEN });
    mock.injectMessage({ text: '二', mentions: ['facai'] });
    const first = await client.updates({ chat: 'main', cursor: 0, wait: 0 });
    const again = await client.updates({ chat: 'main', cursor: 0, wait: 0 });
    assert.equal(again.updates[0].updateId, first.updates[0].updateId);
    client.close();
  });
});

test('关闭客户端后请求以 aborted 收尾', async () => {
  await withMock(async ({ baseUrl }) => {
    const client = createCampfireClient({ baseUrl, token: TOKEN });
    client.close('test');
    await assert.rejects(
      () => client.meta(),
      (error) => error.code === 'aborted',
    );
  });
});

test('baseUrl 缺失直接抛 TypeError（早失败，别静默）', () => {
  assert.throws(() => createCampfireClient({ baseUrl: '' }), TypeError);
});
