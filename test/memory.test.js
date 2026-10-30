import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Summarizer, renderMessages } from '../src/memory/summarizer.js';
import { Embedder, cosine } from '../src/memory/embedder.js';
import { createMemoryService, makeChatComplete } from '../src/memory/index.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-mem-'));
  const store = new Store(dir);
  store.ensureChat('main', '大厅');
  return { store, dir };
}

function say(store, sender, text) {
  return store.insertMessage({ chatId: 'main', sender, text });
}

describe('记忆：摘要', () => {
  let store;
  let dir;

  beforeEach(() => {
    ({ store, dir } = tempStore());
  });

  test('达到条数门槛后生成摘要，并记录覆盖到的 seq', async () => {
    for (let i = 1; i <= 5; i += 1) say(store, 'user', `第 ${i} 条`);

    let seenPrompt = '';
    const s = new Summarizer({
      store,
      minMessages: 3,
      complete: async (prompt) => {
        seenPrompt = prompt;
        return '- 讨论了 1 到 5 条';
      },
    });
    const r = await s.run('main');
    assert.equal(r.count, 5);
    assert.equal(r.covers, 5);
    assert.match(seenPrompt, /第 5 条/);

    const saved = store.getChatSummary('main');
    assert.equal(saved.summary, '- 讨论了 1 到 5 条');
    assert.equal(saved.coversUpToSeq, 5);
  });

  test('没有新消息时跳过', async () => {
    say(store, 'user', 'hi');
    const s = new Summarizer({ store, minMessages: 1, complete: async () => '摘要' });
    await s.run('main');
    const again = await s.run('main');
    assert.equal(again.skipped, 'no_new');
  });

  test('未达门槛时不动，force 可强制执行', async () => {
    say(store, 'user', '一');
    say(store, 'user', '二');
    const s = new Summarizer({ store, minMessages: 10, complete: async () => '摘要' });
    const skipped = await s.run('main');
    assert.equal(skipped.skipped, 'too_few');
    assert.equal(skipped.pending, 2);

    const forced = await s.run('main', { force: true });
    assert.equal(forced.covers, 2);
  });

  test('超长对话只保留最近部分', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ sender: 'u', text: 'x'.repeat(500) }));
    const out = renderMessages(items, 1000);
    assert.ok(out.startsWith('…（更早的消息已省略）'));
    assert.ok(out.length <= 1010 + 20, `实际长度 ${out.length}`);
  });
});

describe('记忆：向量', () => {
  let store;

  beforeEach(() => {
    ({ store } = tempStore());
  });

  const fakeEmbed = async (texts) => texts.map((t) => [t.includes('猫') ? 1 : 0, t.includes('狗') ? 1 : 0, 0.1]);

  test('索引未向量化的消息，并可按相似度检索', async () => {
    say(store, 'user', '我家猫今天很乖');
    say(store, 'user', '狗子在院子里跑');
    say(store, 'user', '猫和狗都饿了');

    const e = new Embedder({ store, embed: fakeEmbed });
    const r = await e.indexChat('main');
    assert.equal(r.indexed, 3);

    const hits = await e.search({ chatId: 'main', query: '猫', k: 2 });
    assert.equal(hits.length, 2);
    assert.ok(Math.abs(hits[0].score - 1) < 1e-9);
    assert.ok(hits[1].score > 0.6 && hits[1].score < 1);
    assert.equal(store.listEmbeddings('main').length, 3);
  });

  test('重复索引不会重复写', async () => {
    say(store, 'user', '只此一条');
    const e = new Embedder({ store, embed: fakeEmbed });
    await e.indexChat('main');
    const again = await e.indexChat('main');
    assert.equal(again.indexed, 0);
  });

  test('余弦相似度基本正确', () => {
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
    assert.ok(cosine([1, 1], [1, 1]) > 0.99);
  });
});

describe('记忆：装配', () => {
  test('没有配置时整体关闭，不报错', () => {
    const { store } = tempStore();
    const svc = createMemoryService({ store, env: {} });
    assert.equal(svc.enabled, false);
    assert.equal(svc.summarizer, null);
    assert.equal(svc.embedder, null);
  });

  test('配置齐全时按 OpenAI 兼容格式发请求', async () => {
    const { store } = tempStore();
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      if (url.endsWith('/chat/completions')) {
        return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '摘要' } }] }) };
      }
      return { ok: true, text: async () => JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }) };
    };

    const complete = makeChatComplete({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', fetchImpl: fakeFetch });
    assert.equal(await complete('你好'), '摘要');
    assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, 'Bearer k');
    assert.equal(calls[0].body.model, 'm');

    const svc = createMemoryService({
      store,
      env: {
        MEMORY_SUMMARY_BASE_URL: 'https://api.example.com/v1',
        MEMORY_SUMMARY_MODEL: 'm',
        MEMORY_EMBED_BASE_URL: 'https://api.example.com/v1',
        MEMORY_EMBED_MODEL: 'e',
      },
      fetchImpl: fakeFetch,
    });
    assert.equal(svc.enabled, true);
    assert.ok(svc.summarizer);
    assert.ok(svc.embedder);
  });
});
