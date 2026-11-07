import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApp, ownerClient, createMember } from './helpers.js';

/** 建一个成员 + 渠道令牌，返回可以以该成员身份发消息的函数。 */
async function setup() {
  const app = await makeApp();
  const owner = ownerClient(app.base);
  await owner.login();
  await createMember(owner, { handle: 'ruyi', display: '如意' });

  const ch = await owner.post('/api/admin/channels', { member: 'ruyi', name: '测试渠道' });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  const token = ch.data.token;

  const asMember = (text) =>
    fetch(`${app.base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ chatId: 'main', text, clientMsgId: `c-${Math.random().toString(36).slice(2)}` }),
    });

  return { app, owner, token, asMember };
}

test('收件箱：成员 @ 主人 的消息会进来', async () => {
  const s = await setup();
  try {
    const res = await s.asMember('@主人 这个方案你看一下');
    assert.equal(res.status, 201);

    const data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].kind, 'mention');
    assert.equal(data.items[0].chatName, '大厅');
    assert.match(data.items[0].message.text, /@主人/);
  } finally {
    await s.app.close();
  }
});

test('收件箱：没 @ 主人的普通消息不进来', async () => {
  const s = await setup();
  try {
    await s.asMember('随手记一笔，没叫谁');
    const data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.items.length, 0);
    assert.equal(data.unread, 0);
  } finally {
    await s.app.close();
  }
});

test('收件箱：@我 / @owner / @me 都算', async () => {
  const s = await setup();
  try {
    await s.asMember('@我 看一眼');
    await s.asMember('@owner 看一眼');
    await s.asMember('@me 看一眼');
    const data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.items.length, 3);
  } finally {
    await s.app.close();
  }
});

test('收件箱：@ 了别人不算 @我', async () => {
  const s = await setup();
  try {
    await s.asMember('@dsh-pc 你来看看');
    const data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.items.length, 0);
  } finally {
    await s.app.close();
  }
});

test('收件箱：未读数与标记已读', async () => {
  const s = await setup();
  try {
    await s.asMember('@主人 第一条');
    await s.asMember('@主人 第二条');

    let data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.unread, 2);

    const mark = await s.owner.post('/api/inbox/seen', {});
    assert.equal(mark.status, 200);
    assert.ok(mark.data.seenAt > 0);

    data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.unread, 0, '标记后未读应清零');
    assert.equal(data.items.length, 2, '条目本身还在，只是不再算未读');
    assert.ok(data.items.every((i) => i.unread === false));
  } finally {
    await s.app.close();
  }
});

test('收件箱：新消息在已读之后仍然算未读', async () => {
  const s = await setup();
  try {
    await s.asMember('@主人 旧消息');
    await new Promise((r) => setTimeout(r, 15));
    await s.owner.post('/api/inbox/seen', {});
    await new Promise((r) => setTimeout(r, 15));
    await s.asMember('@主人 新消息');

    const data = (await s.owner.get('/api/inbox')).data;
    assert.equal(data.unread, 1);
    assert.match(data.items[0].message.text, /新消息/);
    assert.equal(data.items[0].unread, true);
  } finally {
    await s.app.close();
  }
});

test('收件箱：按时间倒序，最新的在前', async () => {
  const s = await setup();
  try {
    await s.asMember('@主人 第一');
    await new Promise((r) => setTimeout(r, 15));
    await s.asMember('@主人 第二');
    await new Promise((r) => setTimeout(r, 15));
    await s.asMember('@主人 第三');

    const data = (await s.owner.get('/api/inbox')).data;
    assert.match(data.items[0].message.text, /第三/);
    assert.match(data.items[2].message.text, /第一/);
  } finally {
    await s.app.close();
  }
});

test('收件箱：limit 生效', async () => {
  const s = await setup();
  try {
    for (let i = 1; i <= 5; i += 1) await s.asMember(`@主人 第 ${i} 条`);
    const data = (await s.owner.get('/api/inbox?limit=2')).data;
    assert.equal(data.items.length, 2);
    // unread 是总数，不受 limit 影响
    assert.equal(data.unread, 5);
  } finally {
    await s.app.close();
  }
});
