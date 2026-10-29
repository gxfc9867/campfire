import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, ownerClient, memberClient, createMember, sleep } from './helpers.js';

describe('单聊', () => {
  test('一个成员只有一条私聊，重复開会复用', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner);

      const first = await owner.post('/api/chats/dm', { handle: 'echo' });
      assert.equal(first.status, 200);
      assert.equal(first.data.chat.kind, 'dm');
      assert.equal(first.data.chat.peer, 'echo');
      assert.equal(first.data.chat.name, '回声', '默认用成员显示名');
      assert.deepEqual(first.data.chat.members, ['echo']);

      const again = await owner.post('/api/chats/dm', { handle: 'echo' });
      assert.equal(again.data.chat.id, first.data.chat.id, '重复点私聊不该造第二条');
    } finally {
      await app.close();
    }
  });

  test('私聊不用 @ 也会投递，成员回执落回同一个会话', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const { key } = await createMember(owner);
      const { chat } = (await owner.post('/api/chats/dm', { handle: 'echo' })).data;

      const sent = await owner.post('/api/messages', { chat: chat.id, text: '在吗' });
      assert.equal(sent.status, 200);
      assert.equal(sent.data.jobs.length, 1, '私聊里不带 @ 也要产生投递');
      assert.equal(sent.data.jobs[0].handle, 'echo');

      const echo = memberClient(app.base, 'echo', key);
      const inbox = await echo.inbox();
      assert.equal(inbox.data.items.length, 1);
      assert.equal(inbox.data.items[0].chatId, chat.id);

      const reply = await echo.reply(inbox.data.items[0].requestId, '在的');
      assert.equal(reply.status, 200);
      assert.equal(reply.data.message.chatId, chat.id);

      const msgs = (await owner.get(`/api/messages?chat=${chat.id}`)).data.messages;
      assert.deepEqual(
        msgs.map((m) => m.sender),
        ['user', 'echo'],
      );
    } finally {
      await app.close();
    }
  });

  test('私聊不接力：成员在私聊里 @ 别人，不会把话带到外面', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const { key } = await createMember(owner);
      const other = await createMember(owner, { handle: 'other', display: '另一个' });
      const { chat } = (await owner.post('/api/chats/dm', { handle: 'echo' })).data;

      await owner.post('/api/messages', { chat: chat.id, text: '第一句' });
      const echo = memberClient(app.base, 'echo', key);
      const inbox = await echo.inbox();
      const reply = await echo.reply(inbox.data.items[0].requestId, '@另一个 你也来说两句');

      const otherClient = memberClient(app.base, 'other', other.key);
      const otherInbox = await otherClient.inbox();
      assert.equal(otherInbox.data.items.length, 0, '私聊里的 @ 不该给第三个人派活');

      const msgs = (await owner.get(`/api/messages?chat=${chat.id}`)).data.messages;
      assert.equal(msgs.find((m) => m.id === reply.data.message.id).sender, 'echo');
    } finally {
      await app.close();
    }
  });

  test('改备注只改显示名，peer 不变', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner);
      const { chat } = (await owner.post('/api/chats/dm', { handle: 'echo' })).data;

      const renamed = await owner.patch(`/api/chats/${chat.id}`, { name: '我的小助手' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.data.chat.name, '我的小助手');
      assert.equal(renamed.data.chat.peer, 'echo');

      const list = (await owner.get('/api/chats')).data.chats;
      const item = list.find((c) => c.id === chat.id);
      assert.equal(item.name, '我的小助手');
      // 侧栏要画对端头像，所以备注名变了也要带出真实成员信息
      assert.equal(item.peerInfo.display, '回声');
    } finally {
      await app.close();
    }
  });

  test('删掉私聊后消息还在，再点私聊能接上', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner);
      const { chat } = (await owner.post('/api/chats/dm', { handle: 'echo' })).data;
      await owner.post('/api/messages', { chat: chat.id, text: '留个记录' });

      const del = await owner.del(`/api/chats/${chat.id}`);
      assert.equal(del.status, 200);
      let list = (await owner.get('/api/chats')).data.chats;
      assert.ok(!list.some((c) => c.id === chat.id), '删除后不在列表里');

      const again = await owner.post('/api/chats/dm', { handle: 'echo' });
      assert.equal(again.data.chat.id, chat.id, '复活的是同一条会话');
      list = (await owner.get('/api/chats')).data.chats;
      assert.ok(list.some((c) => c.id === chat.id));

      const msgs = (await owner.get(`/api/messages?chat=${chat.id}`)).data.messages;
      assert.equal(msgs.length, 1, '历史消息没丢');
    } finally {
      await app.close();
    }
  });

  test('成员不存在时不能开私聊', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const r = await owner.post('/api/chats/dm', { handle: 'nobody' });
      assert.equal(r.status, 404);
    } finally {
      await app.close();
    }
  });
});

describe('解散群聊', () => {
  test('会话从列表消失，成员归属一并摘掉', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner);
      const { chat } = (await owner.post('/api/chats', { name: '临时群' })).data;

      // 把成员拉进这个群
      const detail = (await owner.get('/api/members/echo')).data.member;
      await owner.patch('/api/members/echo', { chats: [...detail.chats, chat.id], etag: detail.etag });

      const del = await owner.del(`/api/chats/${chat.id}`);
      assert.equal(del.status, 200);

      const list = (await owner.get('/api/chats')).data.chats;
      assert.ok(!list.some((c) => c.id === chat.id), '解散后不在会话列表');

      const after = (await owner.get('/api/members/echo')).data.member;
      assert.ok(!after.chats.includes(chat.id), '成员的归属里也不该留着已解散的群');
    } finally {
      await app.close();
    }
  });

  test('主会话（大厅）不能被解散', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const r = await owner.del('/api/chats/main');
      assert.equal(r.status, 400);
      assert.match(r.data.error, /大厅/);
      const list = (await owner.get('/api/chats')).data.chats;
      assert.ok(list.some((c) => c.id === 'main'));
    } finally {
      await app.close();
    }
  });

  test('备注长度有上限，空备注被拒', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner);
      const { chat } = (await owner.post('/api/chats/dm', { handle: 'echo' })).data;

      const empty = await owner.patch(`/api/chats/${chat.id}`, { name: '   ' });
      assert.equal(empty.status, 400);

      const long = await owner.patch(`/api/chats/${chat.id}`, { name: '备'.repeat(200) });
      assert.equal(long.status, 400);
    } finally {
      await app.close();
    }
  });
});
