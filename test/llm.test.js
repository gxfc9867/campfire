import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeApp, ownerClient, sleep } from './helpers.js';
import { buildChatMessages, callChat } from '../src/drivers/llm.js';

/**
 * 一个假的 OpenAI 兼容服务。
 * 不联网、不花钱、不依赖 key——驱动层的逻辑（拼消息、解析、报错、落库）
 * 都该能在没有真模型的情况下被完整验证。
 */
function mockLlm(handler) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    handler(req, res, body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const okReply = (res, text) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      model: 'mock-model',
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
};

describe('大模型驱动的配置校验', () => {
  test('缺地址或模型名要报错；默认值补齐；密钥留空不改', async () => {
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();

      const noUrl = await owner.post('/api/members', {
        handle: 'a1',
        display: 'A1',
        driver: { type: 'llm', model: 'm' },
      });
      assert.equal(noUrl.status, 400);

      const noModel = await owner.post('/api/members', {
        handle: 'a2',
        display: 'A2',
        driver: { type: 'llm', baseUrl: 'http://127.0.0.1:1/v1' },
      });
      assert.equal(noModel.status, 400);

      // 预设：只给 provider，地址与模型名自动补
      const created = await owner.post('/api/members', {
        handle: 'a3',
        display: 'A3',
        driver: { type: 'llm', provider: 'deepseek', apiKey: 'sk-secret-value' },
        chats: ['main'],
      });
      assert.equal(created.status, 200);
      const d = created.data.member.driver;
      assert.equal(d.baseUrl, 'https://api.deepseek.com/v1');
      assert.equal(d.model, 'deepseek-chat');
      assert.equal(d.temperature, 0.8);
      assert.equal(d.maxTokens, 800);
      // 列表视图不能把密钥带出去，只留一个「配过没」的信号
      assert.equal(d.apiKey, '****');
      assert.equal(d.hasKey, true);
      assert.ok(!JSON.stringify(created.data.member).includes('sk-secret-value'));

      // 编辑时密钥留空 → 沿用旧密钥（否则每次改人设都要重敲 key）
      const updated = await owner.post('/api/members', {
        handle: 'a3',
        display: 'A3 改',
        driver: { type: 'llm', provider: 'deepseek', apiKey: '' },
        chats: ['main'],
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.data.member.driver.hasKey, true);

      // 密钥传回打码值也不能把它改成 "****"
      const masked = await owner.post('/api/members', {
        handle: 'a3',
        display: 'A3 再改',
        driver: { type: 'llm', provider: 'deepseek', apiKey: '****' },
        chats: ['main'],
      });
      assert.equal(masked.data.member.driver.hasKey, true);
    } finally {
      await app.close();
    }
  });
});

describe('提示词拼装', () => {
  test('人设、记忆、规则进 system；自己的话是 assistant，别人的话带名字', () => {
    const member = { handle: 'echo', display: '回声', persona: '你说话很短' };
    const members = {
      get: (h) => (h === 'echo' ? member : h === 'beacon' ? { handle: 'beacon', display: '灯塔' } : null),
    };
    const history = [
      { sender: 'user', text: '大家好' },
      { sender: 'beacon', text: '在' },
      { sender: 'echo', text: '我也在' },
      { sender: 'user', text: '在吗' },
    ];
    const out = buildChatMessages({
      member,
      digest: '上次聊到 NAS',
      history,
      chatName: '大厅',
      trigger: '主人：回声你说说',
      allowMentions: false,
      members,
    });

    assert.equal(out[0].role, 'system');
    assert.match(out[0].content, /你说话很短/);
    assert.match(out[0].content, /上次聊到 NAS/);
    assert.match(out[0].content, /大厅/);
    assert.match(out[0].content, /不要 @ 任何人/);

    // 自己那条是 assistant，其余是 user 且带发言人名字
    const assistant = out.filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].content, '我也在');

    const users = out.filter((m) => m.role === 'user');
    assert.ok(users.some((m) => m.content.includes('主人：大家好')));
    assert.ok(users.some((m) => m.content.includes('灯塔：在')));
    // 触发是最后一条 user
    assert.equal(out[out.length - 1].content, '主人：回声你说说');
  });
});

describe('模型调用', () => {
  let mock;
  let lastBody = null;
  before(async () => {
    mock = await mockLlm((req, res, body) => {
      lastBody = body;
      if (req.headers.authorization !== 'Bearer good-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      }
      okReply(res, '在的，什么事');
    });
  });
  after(async () => {
    await mock.close();
  });

  test('正常返回文本、模型名与耗时', async () => {
    const out = await callChat(
      { baseUrl: mock.url, model: 'mock-model', apiKey: 'good-key', temperature: 0.5, maxTokens: 100 },
      [{ role: 'user', content: '在吗' }],
    );
    assert.equal(out.text, '在的，什么事');
    assert.equal(out.model, 'mock-model');
    assert.ok(out.latencyMs >= 0);
    // 请求体要按 OpenAI 形状发出去
    assert.equal(lastBody.model, 'mock-model');
    assert.equal(lastBody.stream, false);
    assert.equal(lastBody.temperature, 0.5);
  });

  test('401 报错要能指向密钥问题，而不是一句 HTTP 401', async () => {
    await assert.rejects(
      () => callChat({ baseUrl: mock.url, model: 'm', apiKey: 'bad-key' }, [{ role: 'user', content: 'x' }]),
      /密钥无效/,
    );
  });

  test('返回 HTML 错误页时给出可读提示', async () => {
    const bad = await mockLlm((req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>Bad Gateway</html>');
    });
    try {
      await assert.rejects(
        () => callChat({ baseUrl: bad.url, model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'x' }]),
        /非 JSON/,
      );
    } finally {
      await bad.close();
    }
  });
});

describe('llm 成员在群里真的会回话', () => {
  test('@ 它 → 桥调模型 → 回复落库并带 replyTo', async () => {
    const mock = await mockLlm((req, res) => okReply(res, '我在，刚看完你说的那段。'));
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      const created = await owner.post('/api/members', {
        handle: 'thinker',
        display: '思考者',
        persona: '你是群里最爱较真的那个人',
        driver: { type: 'llm', baseUrl: mock.url, model: 'mock-model', apiKey: 'good-key' },
        chats: ['main'],
      });
      assert.equal(created.status, 200);

      const sent = await owner.post('/api/messages', { chat: 'main', text: '@思考者 你怎么看？' });
      assert.equal(sent.status, 200);

      // 投递是异步的：轮询等回复出现
      let reply = null;
      for (let i = 0; i < 40 && !reply; i++) {
        await sleep(50);
        const list = (await owner.get('/api/messages?chat=main')).data.messages;
        reply = list.find((m) => m.sender === 'thinker');
      }
      assert.ok(reply, '模型回复应以成员身份落库');
      assert.equal(reply.text, '我在，刚看完你说的那段。');
      assert.equal(reply.replyTo, sent.data.message.id);
      // 回应的是主人发起的消息，应被标记为「@我」
      assert.equal(reply.meta.mentionsOwner, true);

      // 投递任务收尾为 done
      const jobs = (await owner.get('/api/jobs?chat=main')).data.jobs;
      const job = jobs.find((j) => j.id === reply.jobId);
      assert.equal(job.status, 'done');

      // llm 型没有外部连接，但状态必须显示为可用，不能是「离线」
      const members = (await owner.get('/api/members')).data.members;
      const thinker = members.find((m) => m.handle === 'thinker');
      assert.equal(thinker.presence.reachable, true);
      assert.equal(thinker.presence.ready, true);
    } finally {
      await app.close();
      await mock.close();
    }
  });

  test('模型调用失败时任务标 failed，消息不丢', async () => {
    const mock = await mockLlm((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    });
    const app = await makeApp();
    const owner = ownerClient(app.base);
    try {
      await owner.login();
      await owner.post('/api/members', {
        handle: 'broken',
        display: '坏掉的',
        driver: { type: 'llm', baseUrl: mock.url, model: 'm', apiKey: 'k' },
        chats: ['main'],
      });
      const sent = await owner.post('/api/messages', { chat: 'main', text: '@坏掉的 在吗' });
      assert.equal(sent.status, 200);

      let job = null;
      for (let i = 0; i < 40 && !job; i++) {
        await sleep(50);
        const jobs = (await owner.get('/api/jobs?chat=main')).data.jobs;
        job = jobs.find((j) => j.handle === 'broken' && j.status === 'failed');
      }
      assert.ok(job, '失败要落到 failed，而不是永远挂着');
      assert.match(job.error, /HTTP 500/);

      // 原消息还在，主人能看见自己说了什么
      const list = (await owner.get('/api/messages?chat=main')).data.messages;
      assert.ok(list.some((m) => m.text.includes('在吗')));
    } finally {
      await app.close();
      await mock.close();
    }
  });
});
