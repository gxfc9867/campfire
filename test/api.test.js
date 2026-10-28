import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, ownerClient, memberClient, createMember, sleep } from './helpers.js';

describe('围炉 API', () => {
  let app;
  let owner;

  before(async () => {
    app = await makeApp();
    owner = ownerClient(app.base);
  });

  after(async () => {
    await app.close();
  });

  test('健康检查免鉴权，且不泄露业务数据', async () => {
    const res = await fetch(`${app.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.version);
    assert.equal(body.members, 0);
  });

  test('未登录访问业务接口返回 401', async () => {
    const r = await owner.get('/api/messages');
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'unauthorized');
  });

  test('口令错误被拒，正确则签发会话', async () => {
    const bad = await owner.login('wrong');
    assert.equal(bad.status, 400);

    const ok = await owner.login();
    assert.equal(ok.status, 200);
    assert.ok(owner.cookie.includes('cf_session'));
  });

  test('未登录也能拉首页，且注入了 basePath 占位符', async () => {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('围炉'));
    assert.ok(!html.includes('__BASE_PATH__'), '占位符应被替换');
  });

  test('创建成员返回一次性明文密钥，列表只给掩码', async () => {
    const { member, key } = await createMember(owner, { handle: 'ruyi', display: '如意' });
    assert.equal(member.handle, 'ruyi');
    assert.equal(member.driverType, 'cli');
    assert.ok(key.length >= 20);
    assert.ok(!JSON.stringify(member).includes(key), '列表视图里不应出现明文密钥');

    const list = await owner.get('/api/members');
    assert.equal(list.status, 200);
    assert.ok(list.data.members.some((m) => m.handle === 'ruyi'));
    assert.ok(!JSON.stringify(list.data).includes(key));
  });

  test('成员密钥可以换取 profile，错误密钥被拒', async () => {
    const { key } = await createMember(owner, { handle: 'worker', display: '工人' });
    const ok = memberClient(app.base, 'worker', key);
    const p = await ok.profile();
    assert.equal(p.status, 200);
    assert.equal(p.data.handle, 'worker');

    const bad = memberClient(app.base, 'worker', 'not-the-key');
    const r = await bad.profile();
    assert.equal(r.status, 401);
  });

  test('发消息后按 @ 建投递，inbox 认领一次，reply 落库', async () => {
    const { key } = await createMember(owner, { handle: 'echo', display: '回声' });
    const member = memberClient(app.base, 'echo', key);

    const sent = await owner.post('/api/messages', { chat: 'main', text: '@echo 你好' });
    assert.equal(sent.status, 200);
    assert.equal(sent.data.jobs.length, 1);
    assert.equal(sent.data.jobs[0].handle, 'echo');

    const first = await member.inbox(0);
    assert.equal(first.data.items.length, 1);
    const { requestId } = first.data.items[0];
    assert.equal(first.data.wake, true);

    // 认领后再拉就是空的：同一份投递不会被两个进程各处理一遍
    const second = await member.inbox(0);
    assert.equal(second.data.items.length, 0);

    const replied = await member.reply(requestId, '你好呀');
    assert.equal(replied.status, 200);
    assert.equal(replied.data.message.sender, 'echo');

    const msgs = await owner.get('/api/messages?chat=main');
    assert.ok(msgs.data.messages.some((m) => m.text === '你好呀' && m.sender === 'echo'));
  });

  test('同一 requestId 重复回执只生效一次', async () => {
    const { key } = await createMember(owner, { handle: 'dup', display: '重复' });
    const member = memberClient(app.base, 'dup', key);

    await owner.post('/api/messages', { chat: 'main', text: '@dup 测试幂等' });
    const { data } = await member.inbox(0);
    const { requestId } = data.items[0];

    const a = await member.reply(requestId, '第一次');
    const b = await member.reply(requestId, '第二次');
    assert.equal(a.status, 200);
    assert.equal(b.data.duplicate, true);
    assert.equal(b.data.message.id, a.data.message.id);

    const msgs = await owner.get('/api/messages?chat=main');
    const hits = msgs.data.messages.filter((m) => m.text.startsWith('第') && m.sender === 'dup');
    assert.equal(hits.length, 1, '不应产生两条回复');
  });

  test('长轮询在消息到达时立刻返回，不等满超时', async () => {
    const { key } = await createMember(owner, { handle: 'poller', display: '等待者' });
    const member = memberClient(app.base, 'poller', key);

    const waiting = member.inbox(5);
    await sleep(250);

    const t0 = Date.now();
    await owner.post('/api/messages', { chat: 'main', text: '@poller 叫醒你' });
    const r = await waiting;
    const elapsed = Date.now() - t0;

    assert.equal(r.status, 200);
    assert.equal(r.data.items.length, 1);
    assert.ok(elapsed < 2000, `应被立即唤醒，实际等了 ${elapsed}ms`);
  });

  test('长轮询超时返回空数组，客户端可据此重连', async () => {
    const { key } = await createMember(owner, { handle: 'idle', display: '空闲' });
    const member = memberClient(app.base, 'idle', key);

    const t0 = Date.now();
    const r = await member.inbox(1);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.data.items.length, 0);
    assert.ok(elapsed >= 900, `应挂起到超时，实际 ${elapsed}ms`);
    assert.ok(elapsed < 3000);
  });

  test('@所有人 会展开成该会话的全部成员', async () => {
    await createMember(owner, { handle: 'a1', display: '甲' });
    await createMember(owner, { handle: 'a2', display: '乙' });

    const r = await owner.post('/api/messages', { chat: 'main', text: '@所有人 开会了' });
    assert.equal(r.status, 200);
    const handles = r.data.jobs.map((j) => j.handle);
    assert.ok(handles.includes('a1'));
    assert.ok(handles.includes('a2'));
  });

  test('同一 clientId 重复发送只落一条消息', async () => {
    const before = (await owner.get('/api/messages?chat=main')).data.messages.length;
    const cid = 'fixed-client-id-1';
    await owner.post('/api/messages', { chat: 'main', text: '幂等测试', clientId: cid });
    await owner.post('/api/messages', { chat: 'main', text: '幂等测试', clientId: cid });
    const after = (await owner.get('/api/messages?chat=main')).data.messages.length;
    assert.equal(after, before + 1);
  });

  test('记忆摘要可写可读，并出现在提示词里', async () => {
    const { key } = await createMember(owner, { handle: 'memo', display: '记事' });
    const member = memberClient(app.base, 'memo', key);

    await member.setMemory('主人喜欢先看结论。');
    const got = await member.memory();
    assert.equal(got.data.digest, '主人喜欢先看结论。');

    const p = await member.prompt('main');
    assert.equal(p.status, 200);
    assert.ok(p.data.prompt.includes('[人设]'));
    assert.ok(p.data.prompt.includes('主人喜欢先看结论。'));
    assert.ok(p.data.prompt.includes('[当前群聊'));
  });

  test('状态上报影响「可唤醒 / 就绪」判定', async () => {
    const { key } = await createMember(owner, { handle: 'waker', display: '被叫' });
    const member = memberClient(app.base, 'waker', key);

    await member.state({ state: 'warm', running: 0, limit: 2 });
    let s = await owner.get('/api/status?chat=main');
    let found = s.data.members.find((m) => m.handle === 'waker');
    assert.equal(found.presence.reachable, true);
    assert.equal(found.presence.ready, false);
    assert.equal(found.online, 'wakeable');

    await member.state({ state: 'hot', running: 1, limit: 2 });
    s = await owner.get('/api/status?chat=main');
    found = s.data.members.find((m) => m.handle === 'waker');
    assert.equal(found.presence.ready, true);
    assert.equal(found.online, 'ready');
  });

  test('归档成员后不再出现在会话成员里，历史消息保留', async () => {
    const { key } = await createMember(owner, { handle: 'gone', display: '将走' });
    const member = memberClient(app.base, 'gone', key);
    await owner.post('/api/messages', { chat: 'main', text: '@gone 说句话' });
    const { data } = await member.inbox(0);
    await member.reply(data.items[0].requestId, '我说过了');

    const del = await owner.del('/api/members/gone');
    assert.equal(del.status, 200);

    const s = await owner.get('/api/status?chat=main');
    assert.ok(!s.data.members.some((m) => m.handle === 'gone'));

    const msgs = await owner.get('/api/messages?chat=main');
    assert.ok(msgs.data.messages.some((m) => m.sender === 'gone'), '历史消息不该消失');
  });

  test('乐观锁：用过期 etag 保存会被拒绝', async () => {
    const list = await owner.get('/api/members');
    const stale = list.data.etag;
    await owner.post('/api/members', { handle: 'locker', display: '锁', chats: ['main'] });

    const r = await owner.patch('/api/members/locker', { display: '改名', etag: stale });
    assert.equal(r.status, 409);
  });

  test('非法 handle 被拒绝', async () => {
    const r = await owner.post('/api/members', { handle: 'Bad Handle', display: 'x' });
    assert.equal(r.status, 400);
  });

  test('投递面板能查到任务', async () => {
    const r = await owner.get('/api/jobs?chat=main');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.jobs));
    assert.ok(r.data.stats);
  });
});
