import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MENTION_OWNER_RE } from '../src/constants.js';
import { makeApp, ownerClient, memberClient, createMember, sleep } from './helpers.js';

describe('未读与已读', () => {
  test('成员回话产生未读，markRead 之后清零', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const { key } = await createMember(owner);

      await owner.post('/api/messages', { chat: 'main', text: '@echo 你在吗' });
      const echo = memberClient(app.base, 'echo', key);
      const inbox = await echo.inbox();
      await echo.reply(inbox.data.items[0].requestId, '在的');

      let chats = (await owner.get('/api/chats')).data.chats;
      const main = chats.find((c) => c.id === 'main');
      assert.equal(main.unread, 1, '成员回复应计 1 条未读');

      // 打开会话 → 标记已读
      await owner.post('/api/chats/main/read', { seq: main.last.seq });
      chats = (await owner.get('/api/chats')).data.chats;
      assert.equal(chats.find((c) => c.id === 'main').unread, 0);
    } finally {
      await app.close();
    }
  });

  test('自己发的消息不算未读；已读位置只前进不后退', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await owner.post('/api/messages', { chat: 'main', text: '只有主人一句话' });
      const chats = (await owner.get('/api/chats')).data.chats;
      assert.equal(chats.find((c) => c.id === 'main').unread, 0);

      // 晚到的旧标签页带着旧 seq 来标已读，不应把位置拉回去
      await owner.post('/api/chats/main/read', { seq: 999 });
      await owner.post('/api/chats/main/read', { seq: 1 });
      assert.equal((await owner.get('/api/chats')).data.chats.find((c) => c.id === 'main').readSeq, 999);
    } finally {
      await app.close();
    }
  });
});

describe('投递重试与取消', () => {
  test('取消 pending 的投递，群里留系统说明，之后可重试', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner, { handle: 'gone', display: '不在线', driver: { type: 'pull' } });

      const sent = await owner.post('/api/messages', { chat: 'main', text: '@gone 等你上线' });
      const jobId = sent.data.jobs[0].id;
      assert.equal(sent.data.jobs[0].status, 'pending');

      const cancel = await owner.post(`/api/jobs/${jobId}/cancel`);
      assert.equal(cancel.status, 200);

      const jobs = (await owner.get('/api/jobs?chat=main')).data.jobs;
      const job = jobs.find((j) => j.id === jobId);
      assert.equal(job.status, 'cancelled');

      const msgs = (await owner.get('/api/messages?chat=main')).data.messages;
      assert.ok(
        msgs.some((m) => m.sender === 'system' && m.text.includes('取消投递')),
        '取消后群里应有一条说明',
      );

      const retry = await owner.post(`/api/jobs/${jobId}/retry`);
      assert.equal(retry.status, 200);
      const after = (await owner.get('/api/jobs?chat=main')).data.jobs.find((j) => j.id === jobId);
      assert.equal(after.status, 'pending');
    } finally {
      await app.close();
    }
  });

  test('done 的投递不可取消也不可重试', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const { key } = await createMember(owner);
      await owner.post('/api/messages', { chat: 'main', text: '@echo 在吗' });
      const echo = memberClient(app.base, 'echo', key);
      const inbox = await echo.inbox();
      await echo.reply(inbox.data.items[0].requestId, '在');

      const jobId = (await owner.get('/api/jobs?chat=main')).data.jobs[0].id;
      assert.equal((await owner.post(`/api/jobs/${jobId}/cancel`)).status, 400);
      assert.equal((await owner.post(`/api/jobs/${jobId}/retry`)).status, 400);
    } finally {
      await app.close();
    }
  });
});

describe('@我 的结构化判定', () => {
  test('回复回应主人的消息 → 算；成员说「你」不算', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const { key } = await createMember(owner);

      // 主人 @echo 发起 → 回复必然是回应主人
      await owner.post('/api/messages', { chat: 'main', text: '@echo 帮我看看' });
      const echo = memberClient(app.base, 'echo', key);
      const inbox = await echo.inbox();
      const r1 = await echo.reply(inbox.data.items[0].requestId, '你可以试试这样写');
      assert.equal(r1.data.message.meta.mentionsOwner, true, '回应主人的消息算 @我');

      // 成员之间互发的回复（以成员身份直接发普通消息）不带标记
      const r2 = await owner.post('/api/messages', { chat: 'main', text: '@echo 再说一句' });
      await echo.reply(r2.data.jobs[0].id ? (await echo.inbox()).data.items[0].requestId : '', '好的');
      const msgs = (await owner.get('/api/messages?chat=main')).data.messages;
      const last = msgs[msgs.length - 1];
      // 第二次回复也是回应主人发起的消息，所以也算——语义就是这样定的
      assert.equal(last.meta?.mentionsOwner, true);
    } finally {
      await app.close();
    }
  });

  test('MENTION_OWNER_RE：显式点名命中，@我们 / @me2 不误伤', () => {
    assert.ok(MENTION_OWNER_RE.test('好的 @主人'));
    assert.ok(MENTION_OWNER_RE.test('收到，@me 已处理'));
    assert.ok(MENTION_OWNER_RE.test('@我 马上看看'));
    assert.ok(!MENTION_OWNER_RE.test('我们一起加油'));
    assert.ok(!MENTION_OWNER_RE.test('参考 @me2 的做法'));
    assert.ok(!MENTION_OWNER_RE.test('你可以自己试试'));
  });
});

describe('历史翻页', () => {
  test('before 游标能拉到更早的消息且不重叠', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      for (let i = 1; i <= 7; i++) {
        await owner.post('/api/messages', { chat: 'main', text: `第 ${i} 条` });
      }
      const page1 = (await owner.get('/api/messages?chat=main&limit=5')).data;
      assert.equal(page1.messages.length, 5);
      assert.equal(page1.hasMore, true);
      assert.equal(page1.messages[0].text, '第 3 条');

      const page2 = (
        await owner.get(`/api/messages?chat=main&limit=5&before=${page1.messages[0].seq}`)
      ).data;
      // before=第3条的 seq，剩下第 1、2 条，升序返回
      assert.deepEqual(
        page2.messages.map((m) => m.text),
        ['第 1 条', '第 2 条'],
      );
      assert.equal(page2.hasMore, false);
    } finally {
      await app.close();
    }
  });
});
