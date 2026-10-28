/**
 * 极简 markdown 渲染，零依赖。
 *
 * 只支持对话里真正会用到的语法：围栏代码块、行内代码、粗体、斜体、删除线、
 * 有序/无序列表、引用、标题、分割线、链接（markdown 语法与裸 URL）。
 * 不做表格、任务列表、脚注——那些在聊天窗口里的收益远低于复杂度。
 *
 * 安全前提：**所有内容先整体转义，再解析**。渲染器只认自己生成的标签，
 * 用户输入里不可能出现真实 HTML。顺序反过来（先解析后过滤）就是 XSS 的老路。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** 占位符用 \u0000 包起来：它不可能出现在正常聊天内容里，不会与用户文本冲突。 */
const FENCE = '\u0000F';
const HOLD = '\u0000H';

/** 把已渲染好的片段先寄存起来，避免后续规则改写它的内部（尤其是链接里的 @）。 */
function hold(ctx, html) {
  ctx.hold.push(html);
  return `${HOLD}${ctx.hold.length - 1}\u0000`;
}

/**
 * 先把围栏代码块整段抽走。
 * 抽走而不是就地渲染，是因为代码块里的内容不能被后续的 @、链接、粗体规则碰到。
 */
function extractFences(text, store) {
  const lines = text.split('\n');
  const out = [];
  let open = null;
  let buf = [];

  for (const line of lines) {
    const m = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (m) {
      if (open === null) {
        open = m[1] || '';
        buf = [];
      } else {
        store.push({ lang: open, code: buf.join('\n') });
        out.push(`${FENCE}${store.length - 1}\u0000`);
        open = null;
        buf = [];
      }
      continue;
    }
    if (open !== null) buf.push(line);
    else out.push(line);
  }

  // 没有闭合的围栏：原样吐回去，别把后面所有内容都当代码
  if (open !== null) {
    out.push(`\`\`\`${open}`);
    out.push(...buf);
  }
  return out.join('\n');
}

/**
 * 行内规则。
 *
 * 顺序是这里的全部难点：凡是会生成 HTML 的规则（代码、链接），都必须立刻把结果
 * 抽成占位符，否则后面的 @ 染色会改写 href 里的 `@ruyi`，直接破坏链接。
 * 所以在所有规则跑完之后才统一还原，是整个模块唯一正确的顺序。
 */
function inline(text, ctx) {
  let s = text;

  // 行内代码：里面的 `*` `_` `@` 都不该被解释
  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(ctx, `<code>${code}</code>`));

  // markdown 链接 [文字](地址)
  s = s.replace(/\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const text = highlightMentions(label, ctx);
    return hold(ctx, `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  });

  // 裸地址：前面必须是行首或空白，避免把已经生成的 href="..." 也吞进去。
  // 中文标点要排除，否则「见 https://x/a，好的」会把逗号和后面的话一起吞进链接。
  s = s.replace(/(^|[\s（(])(https?:\/\/[^\s<>"'）)，。；：！？、」』]+)/g, (whole, lead, url) => {
    const trimmed = url.replace(/[.,;:!?]+$/, '');
    const tail = url.slice(trimmed.length);
    const a = `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${trimmed}</a>`;
    return `${lead}${hold(ctx, a)}${tail}`;
  });

  s = highlightMentions(s, ctx);

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return s;
}

/**
 * @ 提及染色。
 * 在已经转义过的文本上做，所以只需要关心「不要把生成的标签再拆开」——
 * 这一步发生得最早，文本里还没有任何标签，天然安全。
 */
function highlightMentions(text, ctx) {
  if (!ctx.members?.length) return text;
  const dict = [];
  for (const m of ctx.members) {
    for (const k of [m.handle, m.display, ...(m.aliases || [])]) {
      if (k) dict.push({ key: k, display: m.display || k });
    }
  }
  if (!dict.length) return text;
  // 长的排前面，保证 @如意 不会被 @如 抢先吃掉
  dict.sort((a, b) => b.key.length - a.key.length);
  const pattern = dict.map((d) => esc(d.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  let re;
  try {
    re = new RegExp(`@(${pattern})`, 'gi');
  } catch {
    return text;
  }
  // 命中后统一显示备注名：有人习惯写 @ruyi，有人写 @如意，群里看到的应该是一样的
  return text.replace(re, (whole, name) => {
    const hit = dict.find((d) => d.key.toLowerCase() === name.toLowerCase());
    return `<span class="msg-mention">@${esc(hit?.display || name)}</span>`;
  });
}

const isTableRule = (t) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(t) && t.includes('-');

/** 这一行是否开启一个块级元素（用于段落的终止判定）。 */
function startsBlock(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith(FENCE)) return true;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (/^&gt;\s?/.test(t)) return true;
  if (/^[-*+]\s+/.test(t)) return true;
  if (/^\d{1,3}[.)]\s+/.test(t)) return true;
  return false;
}

/** 表格：把连续的 | a | b | 行转成 table。列数不齐时按行补齐，不让布局炸掉。 */
function parseTable(lines, start, ctx) {
  const rows = [];
  let i = start;
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    rows.push(lines[i].trim());
    i++;
  }
  if (rows.length < 2) return null;

  const cells = (row) =>
    row
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => inline(c.trim(), ctx));

  // 第二行是分隔行（|---|---|），跳过，但它决定了对齐方式——对齐先不做，值不大
  const head = cells(rows[0]);
  const body = rows.slice(rows.some((r, idx) => idx === 1 && isTableRule(r)) ? 2 : 1).map(cells);
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const pad = (r) => {
    const copy = [...r];
    while (copy.length < width) copy.push('');
    return copy;
  };

  const thead = `<thead><tr>${pad(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((r) => `<tr>${pad(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`
    : '';
  return { html: `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`, next: i };
}

/**
 * 把文本渲染成安全的 HTML 片段。
 * @param {string} text 原始文本
 * @param {{members?: Array}} ctx 成员表，用于 @ 染色
 */
export function renderMarkdown(text, ctx = {}) {
  const fences = [];
  const state = { hold: [], members: ctx.members || [] };

  let body = extractFences(esc(text), fences);
  const lines = body.split('\n');
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = new RegExp(`^${FENCE}(\\d+)\u0000$`).exec(t);
    if (fence) {
      const block = fences[Number(fence[1])];
      const lang = block.lang ? ` data-lang="${esc(block.lang)}"` : '';
      html += `<div class="md-code"${lang}><pre><code>${block.code}</code></pre></div>`;
      i++;
      continue;
    }

    // 标题：降两级用 div，避免和页面自身的 h1/h2 样式打架
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      const lv = Math.min(h[1].length + 1, 5);
      html += `<div class="md-h md-h${lv}">${inline(h[2], state)}</div>`;
      i++;
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      html += '<hr class="md-hr">';
      i++;
      continue;
    }

    // 引用
    if (/^&gt;\s?/.test(t)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      html += `<blockquote class="md-quote">${inline(buf.join(' '), state)}</blockquote>`;
      continue;
    }

    // 表格
    if (t.startsWith('|')) {
      const table = parseTable(lines, i, state);
      if (table) {
        html += table.html;
        i = table.next;
        continue;
      }
    }

    // 无序列表
    if (/^[-*+]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*+]\s+/, ''), state));
        i++;
      }
      html += `<ul class="md-list">${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;
      continue;
    }

    // 有序列表
    if (/^\d{1,3}[.)]\s+/.test(t)) {
      const items = [];
      const start = Number(/^(\d{1,3})/.exec(t)[1]);
      while (i < lines.length && /^\s*\d{1,3}[.)]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d{1,3}[.)]\s+/, ''), state));
        i++;
      }
      const attr = start !== 1 ? ` start="${start}"` : '';
      html += `<ol class="md-list"${attr}>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`;
      continue;
    }

    // 段落：连续的非块起始行合并，行内换行保留成 <br>
    const buf = [];
    while (i < lines.length && !startsBlock(lines[i])) {
      buf.push(inline(lines[i].trim(), state));
      i++;
    }
    if (buf.length) html += `<p class="md-p">${buf.join('<br>')}</p>`;
    else i++; // 理论上到不了，兜底防死循环
  }

  // 还原行内代码与链接
  return html.replace(new RegExp(`${HOLD}(\\d+)\u0000`, 'g'), (_, n) => state.hold[Number(n)] ?? '');
}
