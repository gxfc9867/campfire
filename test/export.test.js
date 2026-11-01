import test from 'node:test';
import assert from 'node:assert/strict';

import { toMarkdown, toJson, exportBaseName } from '../src/export.js';
import { SENDER } from '../src/constants.js';

const members = new Map([
  ['dsh-nas', { handle: 'dsh-nas', display: '恭喜', driverType: 'pull' }],
  ['dsh-pc', { handle: 'dsh-pc', display: '发财', driverType: 'pull' }],
]);

function msg(over) {
  return {
    seq: 1,
    id: 'm_1',
    chatId: 'main',
    sender: SENDER.user,
    text: '你好',
    createdAt: new Date('2026-11-01T22:43:42').getTime(),
    replyTo: null,
    meta: null,
    ...over,
  };
}

test('Markdown：包含标题、时间、发送者、正文', () => {
  const messages = [
    msg({ seq: 1, id: 'a', sender: SENDER.user, text: '@dsh-nas 测试' }),
    msg({ seq: 2, id: 'b', sender: 'dsh-nas', text: '小鹦鹉', replyTo: 'a' }),
  ];
  const md = toMarkdown({ chat: { id: 'main', name: '大厅' }, messages, members });

  assert.match(md, /^# 围炉 · 大厅/m);
  assert.match(md, /消息数：2/);
  assert.match(md, /22:43:42 · 你/);
  assert.match(md, /22:43:42 · 恭喜 `@dsh-nas`/);
  assert.match(md, /小鹦鹉/);
  // 引用要写出被引用的是谁
  assert.match(md, /引用 22:43:42 · 你/);
});

test('Markdown：按天分组', () => {
  const messages = [
    msg({ seq: 1, id: 'a', createdAt: new Date('2026-11-01T23:00:00').getTime() }),
    msg({ seq: 2, id: 'b', createdAt: new Date('2026-11-02T01:00:00').getTime() }),
  ];
  const md = toMarkdown({ chat: { id: 'main', name: '大厅' }, messages, members });
  assert.ok(md.includes('## 2026-11-01'));
  assert.ok(md.includes('## 2026-11-02'));
});

test('Markdown：已删除的消息不泄露原文', () => {
  const messages = [msg({ id: 'a', text: '不该出现的原文', meta: { deleted: true } })];
  const md = toMarkdown({ chat: { id: 'main', name: '大厅' }, messages, members });
  assert.ok(!md.includes('不该出现的原文'));
  assert.match(md, /已被删除/);
});

test('JSON：结构完整、sender 带 kind/handle/display', () => {
  const messages = [
    msg({ seq: 1, id: 'a', sender: SENDER.user, text: '@dsh-nas 测试' }),
    msg({ seq: 2, id: 'b', sender: 'dsh-nas', text: '小鹦鹉', replyTo: 'a' }),
    msg({ seq: 3, id: 'c', sender: SENDER.system, text: '系统提示' }),
  ];
  const data = toJson({ chat: { id: 'main', name: '大厅', kind: 'group' }, messages, members });

  assert.equal(data.format, 'campfire.chat.v1');
  assert.equal(data.chat.name, '大厅');
  assert.equal(data.messageCount, 3);
  assert.equal(data.messages.length, 3);
  assert.deepEqual(data.messages[0].sender, { kind: 'user', handle: 'user', display: '你' });
  assert.equal(data.messages[1].sender.kind, 'member');
  assert.equal(data.messages[1].sender.display, '恭喜');
  assert.equal(data.messages[2].sender.kind, 'system');
  // 引用摘要要带上被引用消息
  assert.equal(data.messages[1].replyPreview.text, '@dsh-nas 测试');
  assert.equal(data.messages[1].replyPreview.sender, '你');
});

test('JSON：原样保留正文里的 markdown 与换行', () => {
  const body = '**粗体**\n\n- 列表\n- 第二项';
  const messages = [msg({ id: 'a', text: body })];
  const data = toJson({ chat: { id: 'main', name: '大厅' }, messages, members });
  assert.equal(data.messages[0].text, body);
});

test('文件名：特殊字符会被替换，且带时间戳', () => {
  const base = exportBaseName({ id: 'main', name: '大厅/测试 群' }, new Date('2026-11-01T23:15:00').getTime());
  assert.ok(!base.includes('/'));
  assert.match(base, /20261101-2315$/);
});

test('空会话也能导出，不抛错', () => {
  const md = toMarkdown({ chat: { id: 'empty', name: '空群' }, messages: [], members });
  const data = toJson({ chat: { id: 'empty', name: '空群' }, messages: [], members });
  assert.match(md, /消息数：0/);
  assert.equal(data.messages.length, 0);
});
