import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, ownerClient, createMember } from './helpers.js';

/**
 * Channel API v1 的契约测试。
 * 只验证「对外承诺」：鉴权、游标、幂等、越权、吊销。
 */
describe('Channel API v1', () => {
  let app;
  let owner;
  let token;
  let channel;

  const api = (pathname, init = {}) =>
    fetch(app.base + pathname, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });

  before(async () => {
    app = await makeApp();
    owner = ownerClient(app.base);
    await owner.login();
    await createMember(owner, { handle: 'ruyi', display: '如意' });
    const r = await owner.post('/api/admin/channels', { member: 'ruyi', name: '如意群聊' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    token = r.data.token;
    channel = r.data.channel;
  });

  after(async () => {
    await app.close();
  });

  test('meta 免鉴权，声明能力与上限', async () => {
    const res = await fetch(`${app.base}/v1/meta`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.apiVersion, 1);
    assert.equal(body.capabilities.cursor, 'seq');
    assert.ok(body.capabilities.wakeup.includes('reply'));
    assert.ok(body.limits.maxTextLength > 0);
  });

  test('没有令牌访问 updates 返回 401', async () => {
    const res = await fetch(`${app.base}/v1/updates?chat=main`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'unauthorized');
  });

  test('游标流：主人 @ 成员后能拉到 update，wakeup=reply', async () => {
    await owner.post('/api/messages', { chat: 'main', text: '@ruyi 在吗' });
    const res = await api('/v1/updates?chat=main&cursor=0');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.updates.length, 1);
    const u = body.updates[0];
    assert.equal(u.type, 'message.created');
    assert.equal(u.wakeup, 'reply');
    assert.equal(u.replyRequired, true);
    assert.equal(u.message.text, '@ruyi 在吗');
    assert.equal(body.nextCursor, u.seq);
  });

  test('未被 @ 的消息是 notify，不是 reply', async () => {
    await owner.post('/api/messages', { chat: 'main', text: '大家早' });
    const res = await api('/v1/updates?chat=main&cursor=0&limit=10');
    const body = await res.json();
    const last = body.updates.at(-1);
    assert.equal(last.wakeup, 'notify');
    assert.equal(last.replyRequired, false);
  });

  test('发消息幂等：同一 clientMsgId 只落一条', async () => {
    const body = JSON.stringify({ chatId: 'main', text: '收到', clientMsgId: 'c-1' });
    const first = await api('/v1/messages', { method: 'POST', body });
    assert.equal(first.status, 201);
    const second = await api('/v1/messages', { method: 'POST', body });
    assert.equal(second.status, 200);
    const data = await second.json();
    assert.equal(data.duplicate, true);
  });

  test('ack 推进游标，下次默认从新位置开始', async () => {
    const ack = await api('/v1/updates/ack', {
      method: 'POST',
      body: JSON.stringify({ chat: 'main', cursor: 999 }),
    });
    assert.equal(ack.status, 200);
    const res = await api('/v1/updates?chat=main');
    const body = await res.json();
    assert.equal(body.updates.length, 0);
    assert.equal(body.nextCursor, 999);
  });

  test('不在群里发消息返回 403', async () => {
    const res = await api('/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ chatId: 'elsewhere', text: '越权' }),
    });
    assert.equal(res.status, 403);
  });

  test('长轮询：有新消息立刻唤醒返回，不等满 wait', async () => {
    const head = await api('/v1/updates?chat=main&cursor=0&limit=200');
    const cursor = (await head.json()).nextCursor;

    const started = Date.now();
    const pending = api(`/v1/updates?chat=main&cursor=${cursor}&wait=8`);
    const timer = setTimeout(() => {
      owner.post('/api/messages', { chat: 'main', text: '唤醒测试' }).catch(() => {});
    }, 300);

    const res = await pending;
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.updates.length, 1, '应拿到刚发的那条');
    assert.ok(body.updates[0].chatTitle, 'update 应带 chatTitle');
    assert.ok(elapsed < 4000, `应被事件立刻唤醒，实际耗时 ${elapsed}ms`);
  });

  test('主人可列出与吊销渠道，吊销后令牌失效', async () => {
    const list = await owner.get('/api/admin/channels?member=ruyi');
    assert.equal(list.status, 200);
    assert.ok(list.data.channels.some((c) => c.id === channel.id));
    assert.equal(list.data.channels[0].token, undefined, '不得回传明文令牌');

    const del = await owner.del(`/api/admin/channels/${channel.id}`);
    assert.equal(del.status, 200);

    const res = await api('/v1/updates?chat=main');
    assert.equal(res.status, 401);
  });
});
