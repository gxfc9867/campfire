import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/js/markdown.js';

const members = [
  { handle: 'ruyi', display: '如意', aliases: ['小如'] },
  { handle: 'echo', display: '回声', aliases: [] },
];

const md = (t, ctx = { members }) => renderMarkdown(t, ctx);

describe('markdown · 安全', () => {
  test('HTML 标签被转义，不会变成真标签', () => {
    const out = md('<img src=x onerror=alert(1)>');
    assert.ok(!out.includes('<img'));
    assert.ok(out.includes('&lt;img'));
  });

  test('代码块里的尖括号也转义', () => {
    const out = md('```\n<script>alert(1)</script>\n```');
    assert.ok(out.includes('&lt;script&gt;'));
    assert.ok(!out.includes('<script>'));
  });

  test('链接属性不会被 @ 染色破坏', () => {
    const out = md('[看这个](https://example.com/@ruyi)');
    assert.ok(out.includes('href="https://example.com/@ruyi"'));
    assert.ok(!out.includes('href="https://example.com/<span'));
  });
});

describe('markdown · 块级', () => {
  test('围栏代码块保留原始换行与缩进', () => {
    const out = md('```js\nconst a = 1;\n  return a;\n```');
    assert.ok(out.includes('class="md-code"'));
    assert.ok(out.includes('data-lang="js"'));
    assert.ok(out.includes('const a = 1;\n  return a;'));
  });

  test('未闭合围栏原样输出，不吞掉后续内容', () => {
    const out = md('```\n没有结束\n后面还有一句');
    assert.ok(out.includes('没有结束'));
    assert.ok(out.includes('后面还有一句'));
  });

  test('无序列表', () => {
    const out = md('- 一\n- 二\n- 三');
    assert.equal((out.match(/<li>/g) || []).length, 3);
  });

  test('有序列表带起始序号', () => {
    const out = md('3. 三\n4. 四');
    assert.ok(out.includes('<ol class="md-list" start="3">'));
  });

  test('引用块', () => {
    const out = md('> 引一句\n> 再引一句');
    assert.ok(out.includes('class="md-quote"'));
    assert.ok(out.includes('引一句'));
  });

  test('标题降级成 div，不与页面 h 标签打架', () => {
    const out = md('## 小节');
    assert.ok(out.includes('md-h3'));
    assert.ok(!out.includes('<h2'));
  });

  test('表格按分隔行识别，列数不齐时补齐', () => {
    const out = md('| a | b |\n|---|---|\n| 1 |\n| 2 | 3 |');
    assert.ok(out.includes('<table class="md-table">'));
    assert.equal((out.match(/<tr>/g) || []).length, 3);
  });

  test('段落之间用 <br> 保留行内换行', () => {
    const out = md('第一行\n第二行');
    assert.ok(out.includes('第一行<br>第二行'));
  });

  test('空行分隔成两个段落', () => {
    const out = md('一段\n\n二段');
    assert.equal((out.match(/md-p/g) || []).length, 2);
  });
});

describe('markdown · 行内', () => {
  test('行内代码不被格式符影响', () => {
    const out = md('看 `a*b*c` 这段');
    assert.ok(out.includes('<code>a*b*c</code>'));
    assert.ok(!out.includes('<em>'));
  });

  test('粗体与斜体', () => {
    assert.ok(md('**重要**').includes('<strong>重要</strong>'));
    assert.ok(md('这是 *强调* 的').includes('<em>强调</em>'));
  });

  test('删除线', () => {
    assert.ok(md('~~划掉~~').includes('<del>划掉</del>'));
  });

  test('裸链接自动成链，尾部标点不吞进去', () => {
    const out = md('见 https://example.com/a，好的');
    assert.ok(out.includes('href="https://example.com/a"'));
    assert.ok(out.includes('>https://example.com/a</a>'));
  });
});

describe('markdown · @提及', () => {
  test('handle 与备注名都能命中，统一显示备注名', () => {
    assert.ok(md('@ruyi 你好').includes('@如意'));
    assert.ok(md('@如意 你好').includes('@如意'));
  });

  test('别名可用', () => {
    assert.ok(md('@小如 帮忙').includes('msg-mention'));
  });

  test('最长匹配：@如意 不会被 @如 抢先', () => {
    const out = md('@如意 在吗', { members: [{ handle: 'ru', display: '如' }, ...members] });
    assert.ok(out.includes('@如意'));
  });

  test('代码块里的 @ 不染色', () => {
    const out = md('```\n@ruyi\n```');
    assert.ok(!out.includes('msg-mention'));
  });

  test('不存在的名字保持原样', () => {
    const out = md('@nobody 你好');
    assert.ok(!out.includes('msg-mention'));
    assert.ok(out.includes('@nobody'));
  });
});
