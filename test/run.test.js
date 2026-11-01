import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/bridges/workbuddy/run.js';

/** 假围炉：只实现桥用到的三个端点，记录请求体。 */
function fakeCampfire({ updates }) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method: init.method || 'GET', body });

    if (url.pathname === '/v1/updates') {
      return json({ updates, nextCursor: 7 });
    }
    if (url.pathname === '/v1/messages') {
      return json({ message: { id: 'm-new', seq: 8 } }, 201);
    }
    if (url.pathname === '/v1/updates/ack') {
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  };
  return { fetchImpl, calls };
}

const json = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

function baseCfg() {
  return {
    campfireBaseUrl: 'http://campfire.test',
    channelToken: 'cf_abc',
    member: 'ruyi',
    sessionId: 's-1',
    cwd: '/tmp/x',
  };
}

test('处理被 @ 的消息：投递 → 回发 → ack', async () => {
  const { fetchImpl, calls } = fakeCampfire({
    updates: [
      {
        updateId: 'main:5',
        type: 'message.created',
        chatId: 'main',
        replyRequired: true,
        message: { id: 'm-5', text: '@ruyi 在吗', sender: { handle: 'user', display: '主人' } },
      },
    ],
  });

  const delivered = [];
  const bridge = { deliver: async (input) => { delivered.push(input); return { text: '在', stopReason: 'end_turn' }; } };

  const r = await runOnce({ cfg: baseCfg(), bridge, fetchImpl });
  assert.equal(r.handled, 1);
  assert.equal(delivered.length, 1);
  // 投递文本带来源标记，避免模型把群消息当成自己的任务（见 run.js 里那段注释）
  assert.match(delivered[0].text, /\[围炉群聊\]/);
  assert.match(delivered[0].text, /主人/);
  assert.match(delivered[0].text, /@ruyi 在吗/);
  assert.equal(delivered[0].messageId, 'main:5');

  const send = calls.find((c) => c.path === '/v1/messages');
  assert.ok(send);
  assert.equal(send.body.text, '在');
  assert.equal(send.body.clientMsgId, 'wb:main:5');
  assert.equal(send.body.replyTo, 'm-5');

  const ack = calls.find((c) => c.path === '/v1/updates/ack');
  assert.equal(ack.body.cursor, 7);
});

test('跳过自己的发言与未被 @ 的消息', async () => {
  const { fetchImpl, calls } = fakeCampfire({
    updates: [
      {
        updateId: 'main:6',
        type: 'message.created',
        chatId: 'main',
        replyRequired: true,
        message: { id: 'm-6', text: '@ruyi 自己', sender: { handle: 'ruyi', display: '如意' } },
      },
      {
        updateId: 'main:7',
        type: 'message.created',
        chatId: 'main',
        replyRequired: false,
        message: { id: 'm-7', text: '闲聊', sender: { handle: 'user', display: '主人' } },
      },
    ],
  });

  const delivered = [];
  const bridge = { deliver: async (i) => { delivered.push(i); return { text: '不该出现' }; } };
  const r = await runOnce({ cfg: baseCfg(), bridge, fetchImpl });

  assert.equal(r.handled, 0);
  assert.equal(delivered.length, 0);
  assert.equal(calls.some((c) => c.path === '/v1/messages'), false);
});

test('投递失败会向上抛，交给循环退避', async () => {
  const { fetchImpl } = fakeCampfire({
    updates: [
      {
        updateId: 'main:9',
        type: 'message.created',
        chatId: 'main',
        replyRequired: true,
        message: { id: 'm-9', text: '@ruyi 会失败', sender: { handle: 'user', display: '主人' } },
      },
    ],
  });
  const bridge = { deliver: async () => { throw new Error('acp down'); } };
  await assert.rejects(() => runOnce({ cfg: baseCfg(), bridge, fetchImpl }), /acp down/);
});
