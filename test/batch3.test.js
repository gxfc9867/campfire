import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeApp, ownerClient, memberClient, createMember, sleep } from './helpers.js';

describe('消息编辑与删除', () => {
  test('主人能编辑自己的消息，不能编辑成员的；删除是软删', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const { key } = await createMember(owner);

      const mine = await owner.post('/api/messages', { chat: 'main', text: '打错字了' });
      const edited = await owner.patch(`/api/messages/${mine.data.message.id}`, { text: '改好了' });
      assert.equal(edited.status, 200);
      assert.equal(edited.data.message.text, '改好了');
      assert.equal(edited.data.message.meta.edited, true);

      // 成员回复一条，尝试编辑它 → 拒绝
      await owner.post('/api/messages', { chat: 'main', text: '@echo 回一下' });
      const echo = memberClient(app.base, 'echo', key);
      const inbox = await echo.inbox();
      const reply = await echo.reply(inbox.data.items[0].requestId, '成员的回复');
      const patched = await owner.patch(`/api/messages/${reply.data.message.id}`, { text: '篡改' });
      assert.equal(patched.status, 404);

      // 删除：正文清空但消息行还在，meta.deleted = true
      const del = await owner.del(`/api/messages/${reply.data.message.id}`);
      assert.equal(del.status, 200);
      const msgs = (await owner.get('/api/messages?chat=main')).data.messages;
      const target = msgs.find((m) => m.id === reply.data.message.id);
      assert.ok(target, '软删后消息行仍在');
      assert.equal(target.text, '');
      assert.equal(target.meta.deleted, true);
    } finally {
      await app.close();
    }
  });
});

describe('引用回复', () => {
  test('quote 校验归属，落库到 replyTo，并回传给前端', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const first = await owner.post('/api/messages', { chat: 'main', text: '第一条' });

      const ok = await owner.post('/api/messages', {
        chat: 'main',
        text: '引用第一条来说话',
        quote: first.data.message.id,
      });
      assert.equal(ok.data.message.replyTo, first.data.message.id);

      // 跨会话的引用被拒：quote 落不下来
      await owner.post('/api/chats', { name: '别的群' });
      const bad = await owner.post('/api/messages', {
        chat: 'main',
        text: '试图引用别处',
        quote: 'm_nonexistent',
      });
      assert.equal(bad.data.message.replyTo, null);
    } finally {
      await app.close();
    }
  });
});

describe('成员接力与防环', () => {
  test('成员回复 @ 别的成员会接力，3 跳封顶', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const a = await createMember(owner, { handle: 'agent_a', display: '甲', driver: { type: 'pull' } });
      const b = await createMember(owner, { handle: 'agent_b', display: '乙', driver: { type: 'pull' } });

      const ma = memberClient(app.base, 'agent_a', a.key);
      const mb = memberClient(app.base, 'agent_b', b.key);

      // 主人 @ 甲
      await owner.post('/api/messages', { chat: 'main', text: '@agent_a 开始讨论' });

      // 甲回复并 @ 乙（第 1 跳，允许）
      const inboxA1 = await ma.inbox();
      await ma.reply(inboxA1.data.items[0].requestId, '@agent_b 你怎么看');

      const inboxB1 = await mb.inbox();
      assert.equal(inboxB1.data.items.length, 1, '乙应收到甲的接力');

      // 乙回复并 @ 甲（第 2 跳，允许）
      await mb.reply(inboxB1.data.items[0].requestId, '@agent_a 我同意');
      const inboxA2 = await ma.inbox();
      assert.equal(inboxA2.data.items.length, 1, '甲应收到乙的接力');

      // 甲再回复 @ 乙（第 3 跳，封顶停止）
      await ma.reply(inboxA2.data.items[0].requestId, '@agent_b 那就定了');
      await sleep(50);
      const inboxB2 = await mb.inbox();
      assert.equal(inboxB2.data.items.length, 0, '第 3 跳不再投递');

      const msgs = (await owner.get('/api/messages?chat=main')).data.messages;
      assert.ok(
        msgs.some((m) => m.sender === 'system' && m.text.includes('接力到此为止')),
        '群里应留一条说明',
      );
    } finally {
      await app.close();
    }
  });
});

describe('webhook 驱动', () => {
  test('投递会 POST 到成员地址，同步回执直接落群', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    const received = [];

    // 起一个假的 webhook 成员端
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        received.push({ secret: req.headers['x-campfire-secret'], payload: JSON.parse(body) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: 'webhook 成员已收到' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
      await owner.login();
      await createMember(owner, {
        handle: 'hook',
        display: '钩子',
        driver: { type: 'webhook', url: `http://127.0.0.1:${port}/hook`, secret: 's3cret', timeoutMs: 5000 },
      });

      const sent = await owner.post('/api/messages', { chat: 'main', text: '@hook 报个数' });
      const jobId = sent.data.jobs[0].id;

      await sleep(300);
      assert.equal(received.length, 1, '桥应推送一次');
      assert.equal(received[0].secret, 's3cret', '应带密钥头');
      assert.equal(received[0].payload.text, '@hook 报个数');
      assert.ok(received[0].payload.requestId, '应带 requestId');

      const jobs = (await owner.get('/api/jobs?chat=main')).data.jobs;
      assert.equal(jobs.find((j) => j.id === jobId).status, 'done', '同步回执应直接完成');

      const msgs = (await owner.get('/api/messages?chat=main')).data.messages;
      assert.ok(msgs.some((m) => m.sender === 'hook' && m.text === 'webhook 成员已收到'));
    } finally {
      server.close();
      await app.close();
    }
  });

  test('webhook 端点挂掉 → 投递标 failed，可重试', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await createMember(owner, {
        handle: 'dead',
        display: '掉线钩子',
        driver: { type: 'webhook', url: 'http://127.0.0.1:9/hook', timeoutMs: 2000 },
      });
      const sent = await owner.post('/api/messages', { chat: 'main', text: '@dead 在吗' });
      const jobId = sent.data.jobs[0].id;
      await sleep(2500);

      const jobs = (await owner.get('/api/jobs?chat=main')).data.jobs;
      assert.equal(jobs.find((j) => j.id === jobId).status, 'failed');

      const retried = await owner.post(`/api/jobs/${jobId}/retry`);
      assert.equal(retried.status, 200);
    } finally {
      await app.close();
    }
  });
});
