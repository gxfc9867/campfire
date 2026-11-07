import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApp, ownerClient } from './helpers.js';

let seq = 0;

/** 发一条消息（clientId 唯一，避免幂等去重把测试内容吃掉）。 */
async function send(owner, chat, text, extra = {}) {
  seq += 1;
  const res = await owner.post('/api/messages', { chat, text, clientId: `t-${seq}`, ...extra });
  assert.equal(res.status, 200, `发消息失败：${JSON.stringify(res.data)}`);
  return res.data.message;
}

/** 上传一个文件（要传裸二进制，ownerClient 的 req 只能发 JSON）。 */
async function upload(owner, base, buffer, { chat, filename, mime }) {
  return fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: {
      Cookie: owner.cookie,
      'x-chat': chat,
      'x-filename': encodeURIComponent(filename),
      'content-type': mime,
    },
    body: buffer,
  });
}

async function setup() {
  const ctx = await makeApp();
  const owner = await ownerClient(ctx.base);
  await owner.login();
  return { ...ctx, owner };
}

const search = async (owner, q, extra = '') =>
  (await owner.get(`/api/search?q=${encodeURIComponent(q)}${extra}`)).data;

test('搜索：中文短词能命中（FTS5 做不到这点，所以用 LIKE）', async () => {
  const s = await setup();
  try {
    await send(s.owner, 'main', '有个修伞的老头，在巷口摆了三十年摊');
    await send(s.owner, 'main', '他给发财出一道初中的数学题');

    const data = await search(s.owner, '修伞');
    assert.equal(data.total, 1);
    assert.equal(data.results.length, 1);
    assert.match(data.results[0].snippet, /<mark>修伞<\/mark>/);
  } finally {
    await s.close();
  }
});

test('搜索：两字词同样命中', async () => {
  const s = await setup();
  try {
    await send(s.owner, 'main', '恭喜回复身体两个字');
    const data = await search(s.owner, '恭喜');
    assert.equal(data.total, 1);
  } finally {
    await s.close();
  }
});

test('搜索：关键词里的 % 和 _ 被当字面量，不是通配符', async () => {
  const s = await setup();
  try {
    await send(s.owner, 'main', '进度 100% 完成');
    await send(s.owner, 'main', '完全无关的一句话');

    const pct = await search(s.owner, '%');
    assert.equal(pct.total, 1, '搜 % 只该命中含百分号那条');

    const under = await search(s.owner, '_');
    assert.equal(under.total, 0, '没有下划线的消息不该被命中');
  } finally {
    await s.close();
  }
});

test('搜索：大小写不敏感（ASCII）', async () => {
  const s = await setup();
  try {
    await send(s.owner, 'main', 'Hello World 你好');
    const data = await search(s.owner, 'hello');
    assert.equal(data.total, 1);
  } finally {
    await s.close();
  }
});

test('搜索：空关键词返回空结果，不报错', async () => {
  const s = await setup();
  try {
    const data = await search(s.owner, '');
    assert.deepEqual(data.results, []);
    assert.equal(data.total, 0);
  } finally {
    await s.close();
  }
});

test('搜索：能按会话过滤', async () => {
  const s = await setup();
  try {
    await send(s.owner, 'main', '同一个关键词 苹果');

    const created = await s.owner.post('/api/chats', { name: '测试群B' });
    assert.equal(created.status, 200);
    const chat = created.data.chat;
    await send(s.owner, chat.id, '同一个关键词 苹果');

    const all = await search(s.owner, '苹果');
    assert.equal(all.total, 2);

    const onlyMain = await search(s.owner, '苹果', '&chat=main');
    assert.equal(onlyMain.total, 1);
    assert.equal(onlyMain.results[0].chatName, '大厅');
  } finally {
    await s.close();
  }
});

test('搜索：附件文件名也能搜到', async () => {
  const s = await setup();
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const up = await upload(s.owner, s.base, png, {
      chat: 'main',
      filename: '季度报表.png',
      mime: 'image/png',
    });
    assert.equal(up.status, 201);
    const att = (await up.json()).attachment;

    await send(s.owner, 'main', '看这个', { attachmentIds: [att.id] });

    const data = await search(s.owner, '季度报表');
    assert.equal(data.total, 1);
    assert.deepEqual(data.results[0].attachmentHits, ['季度报表.png']);
  } finally {
    await s.close();
  }
});

test('搜索：结果按新到旧，limit 生效', async () => {
  const s = await setup();
  try {
    for (let i = 1; i <= 5; i += 1) {
      await send(s.owner, 'main', `第 ${i} 条 苹果消息`);
    }
    const data = await search(s.owner, '苹果', '&limit=3');
    assert.equal(data.results.length, 3);
    assert.equal(data.total, 5);
    assert.equal(data.hasMore, true);
    assert.match(data.results[0].message.text, /第 5 条/);
  } finally {
    await s.close();
  }
});
