import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MARKER_TEMPLATE,
  fillTemplate,
  normalizeOutboundText,
  renderInboundMessage,
  sourceMarker,
} from '../src/format.js';

test('sourceMarker 用群名与显示名填充模板', () => {
  const marker = sourceMarker({ chatId: 'main', senderDisplay: '恭喜', senderHandle: 'gongxi' });
  assert.equal(marker, '[来自围炉/群 main/成员 恭喜]');
});

test('sourceMarker 缺字段时逐级兜底，不产生 undefined', () => {
  assert.equal(sourceMarker({ chatId: 'main', senderHandle: 'gongxi' }), '[来自围炉/群 main/成员 gongxi]');
  assert.equal(sourceMarker({}), '[来自围炉/群 未知群/成员 未知成员]');
  assert.equal(sourceMarker({ chatId: 'x', chatTitle: '主群', senderDisplay: '卿' }), '[来自围炉/群 主群/成员 卿]');
});

test('fillTemplate 只替换认识的占位符', () => {
  assert.equal(fillTemplate('a{chat}b{sender}c{unknown}', { chat: '1', sender: '2' }), 'a1b2c{unknown}');
});

test('renderInboundMessage 首行带来源标记，正文原样保留换行', () => {
  const text = renderInboundMessage({
    message: {
      id: 'msg_1',
      chatId: 'main',
      text: '第一行\n第二行',
      sender: { kind: 'user', handle: 'gongxi', display: '恭喜' },
    },
    chatId: 'main',
  });
  assert.equal(text, '[来自围炉/群 main/成员 恭喜] 第一行\n第二行');
});

test('renderInboundMessage 把附件元数据补成独立行', () => {
  const text = renderInboundMessage({
    message: {
      text: '看图',
      sender: { handle: 'gongxi', display: '恭喜' },
      attachments: [
        { id: 'att_1', name: 'a.png', mime: 'image/png', size: 18342, url: '/v1/files/att_1', width: 800, height: 600 },
        { id: 'att_2' },
      ],
    },
    chatId: 'main',
    baseUrl: 'https://x',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '[来自围炉/群 main/成员 恭喜] 看图');
  // 相对路径要靠 baseUrl 拼成完整地址，agent 才取得到；顺带带上宽高
  assert.match(lines[1], /^\[附件\] a\.png \(image\/png, 17\.9KB 800×600\) https:\/\/x\/v1\/files\/att_1$/);
  assert.match(lines[2], /^\[附件\] att_2 \(application\/octet-stream, 未知大小\) https:\/\/x\/v1\/files\/att_2$/);
});

test('renderInboundMessage 没给 baseUrl 时附件只留相对路径', () => {
  const text = renderInboundMessage({
    message: {
      text: '看图',
      sender: { handle: 'gongxi', display: '恭喜' },
      attachments: [{ id: 'att_9', name: 'b.png', mime: 'image/png', size: 100 }],
    },
    chatId: 'main',
  });
  assert.match(text, /https?:|\[附件\] b\.png .* \/v1\/files\/att_9/);
});

test('renderInboundMessage 支持自定义标记模板', () => {
  const text = renderInboundMessage({
    message: { text: 'hi', sender: { handle: 'a', display: 'A' } },
    chatId: 'main',
    markerTemplate: '<<{chat}|{sender}>>',
  });
  assert.equal(text, '<<main|A>> hi');
});

test('renderInboundMessage 超长正文截断并标注', () => {
  const text = renderInboundMessage({
    message: { text: 'x'.repeat(20_050), sender: { handle: 'a', display: 'A' } },
    chatId: 'main',
  });
  assert.match(text, /\[已截断\] 原文超过 20000 字/);
  assert.ok(text.length < 20_200);
});

test('renderInboundMessage 空文本也不报错', () => {
  assert.equal(renderInboundMessage({ message: { sender: { display: 'A' } }, chatId: 'main' }), '[来自围炉/群 main/成员 A]');
});

test('normalizeOutboundText 去掉空内容', () => {
  assert.equal(normalizeOutboundText(''), null);
  assert.equal(normalizeOutboundText('   \n  '), null);
  assert.equal(normalizeOutboundText(null), null);
  assert.equal(normalizeOutboundText(123), null);
});

test('normalizeOutboundText 剥掉整体代码围栏', () => {
  assert.equal(normalizeOutboundText('```text\n收到，我这就看\n```'), '收到，我这就看');
});

test('normalizeOutboundText 截断超长回复并标注', () => {
  const out = normalizeOutboundText('y'.repeat(30), { maxChars: 10 });
  assert.equal(out, 'yyyyyyyyyy\n…（回复过长已截断）');
});

test('DEFAULT_MARKER_TEMPLATE 与设计文档 §6.4 一致', () => {
  assert.equal(DEFAULT_MARKER_TEMPLATE, '[来自围炉/群 {chat}/成员 {sender}]');
});
