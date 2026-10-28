import { api, ApiError } from './api.js';
import {
  $,
  $$,
  esc,
  avatarEl,
  avatarUrl,
  fmtTime,
  fmtRelative,
  dayLabel,
  toast,
  presenceLabel,
} from './ui.js';
import { initMembers } from './members.js';
import { renderMarkdown } from './markdown.js';

/**
 * 前端主逻辑。
 *
 * 状态刻意保持扁平：一个 state 对象 + 若干渲染函数，没有虚拟 DOM 也没有框架。
 * 消息增量靠 seq 游标，SSE 只负责「叫醒」，即使漏事件也能靠下一轮拉取补上。
 *
 * 视图分四栏：图标栏 / 会话栏 / 消息区 / 右侧栏。
 * 布局交给 CSS grid，脚本只管状态与内容。
 */

const state = {
  me: null,
  chats: [],
  chatId: 'main',
  messages: [],
  lastSeq: 0,
  members: [],
  query: '',
  tab: 'all', // all | mentions
  es: null,
  mentionIndex: 0,
  mentionItems: [],
  mentionQuery: '',
};

const BASE = api.base;

// ── 启动 ────────────────────────────────────────────────────────────

async function boot() {
  bindLogin();
  bindTheme();
  bindComposer();
  bindChrome();

  try {
    const me = await api.me();
    if (me.kind === 'owner') {
      await enterApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  setTimeout(() => $('#login-input')?.focus(), 50);
}

async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  // 窄屏默认收起右侧栏，宽屏直接展开
  if (window.innerWidth < 1180) $('#app').classList.add('aside-closed');
  await loadChats();
  // 默认进最近有动静的会话；全新空会话不抢默认位
  const latest =
    [...state.chats]
      .sort((a, b) => (b.last?.createdAt || b.updatedAt || 0) - (a.last?.createdAt || a.updatedAt || 0))
      .find((c) => c.last) || state.chats[0];
  await selectChat(latest?.id || 'main');
  initMembers({ onChanged: refreshMembers });
}

function bindLogin() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.login($('#login-input').value);
      $('#login-input').value = '';
      await enterApp();
    } catch (ex) {
      err.textContent = ex instanceof ApiError ? ex.message : '登录失败';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

function bindTheme() {
  const saved = localStorage.getItem('cf-theme') || 'auto';
  document.documentElement.dataset.theme = saved;

  $('#btn-theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = document.documentElement.dataset.theme || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cf-theme', next);
    toast({ auto: '跟随系统', light: '浅色', dark: '深色' }[next]);
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.reload();
  });
}

/** 顶栏、右侧栏、标签页这些「壳」上的交互，与业务数据无关。 */
function bindChrome() {
  // 右侧栏开合
  const toggleAside = () => {
    const closed = $('#app').classList.toggle('aside-closed');
    $('#app').classList.toggle('aside-open', !closed);
  };
  $('#btn-toggle-aside').addEventListener('click', toggleAside);
  $('#btn-close-aside').addEventListener('click', () => {
    $('#app').classList.add('aside-closed');
    $('#app').classList.remove('aside-open');
  });

  // 右侧栏分段：成员 / 投递
  $$('.aside-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.aside-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      const want = btn.dataset.panel;
      $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== want));
      if (want === 'jobs') loadJobs();
    });
  });

  // 消息视图标签
  $$('.tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      $$('.tab[data-tab]').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderMessages();
    });
  });

  // 会话搜索
  $('#chat-search').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderChats();
  });

  // 图标栏的成员入口与左栏底部按钮等价
  $('#btn-members-rail').addEventListener('click', () => $('#btn-members').click());

  $('#btn-new-chat').addEventListener('click', async () => {
    const name = prompt('新会话名称');
    if (!name?.trim()) return;
    try {
      const { chat } = await api.createChat(name.trim());
      await loadChats();
      await selectChat(chat.id);
    } catch (ex) {
      toast(ex.message);
    }
  });
}

// ── 会话 ────────────────────────────────────────────────────────────

async function loadChats() {
  const { chats } = await api.chats();
  state.chats = chats;
  renderChats();
}

function renderChats() {
  const list = $('#chat-list');
  list.textContent = '';
  const q = state.query;
  const shown = q ? state.chats.filter((c) => c.name.toLowerCase().includes(q)) : state.chats;
  $('#chat-count').textContent = q ? `${shown.length}/${state.chats.length}` : String(state.chats.length);

  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = q ? '没有匹配的会话' : '还没有会话';
    list.append(p);
    return;
  }

  for (const c of shown) {
    const btn = document.createElement('button');
    btn.className = `chat-item${c.id === state.chatId ? ' is-active' : ''}`;
    const preview = c.last
      ? `${c.last.sender === 'user' ? '你' : nameOf(c.last.sender)}：${c.last.text}`
      : '还没有消息';
    btn.innerHTML =
      `<span class="chat-avatar">${esc(c.name.slice(0, 1).toUpperCase())}</span>` +
      `<span class="chat-item-body">` +
      `<span class="chat-item-top">` +
      `<span class="chat-item-name">${esc(c.name)}</span>` +
      `<span class="chat-item-time">${c.last ? fmtTime(c.last.createdAt) : ''}</span>` +
      `</span>` +
      `<span class="chat-item-preview">${esc(preview)}</span>` +
      `</span>`;
    btn.addEventListener('click', () => selectChat(c.id));
    list.append(btn);
  }
}

async function selectChat(id) {
  if (!id) return;
  state.chatId = id;
  state.messages = [];
  state.lastSeq = 0;
  $('#chat-name').textContent = state.chats.find((c) => c.id === id)?.name || id;
  renderChats();
  await Promise.all([loadMessages(), refreshMembers(), loadJobs()]);
  connectEvents();
  $('#input')?.focus();
}

function connectEvents() {
  state.es?.close();
  state.es = api.events(
    state.chatId,
    (evt) => {
      if (evt.type === 'message' && (!evt.chatId || evt.chatId === state.chatId)) {
        loadMessages();
      } else if (evt.type === 'members' || evt.type === 'memory') {
        refreshMembers();
      } else if (evt.type === 'chat') {
        loadChats();
      }
    },
    () => {
      // 断线由 EventSource 自己重连；这里只需保证回来时补一次增量
      setTimeout(() => loadMessages(), 3000);
    },
  );
}

// ── 消息 ────────────────────────────────────────────────────────────

async function loadMessages() {
  const after = state.lastSeq;
  const data = await api.messages(state.chatId, after ? { after } : {});
  if (!after) {
    state.messages = data.messages;
    renderMessages();
  } else if (data.messages.length) {
    for (const m of data.messages) appendMessage(m);
    updateMentionCount();
  }
  if (state.messages.length) {
    state.lastSeq = state.messages[state.messages.length - 1].seq;
  }
  updateSub();
  updateMentionCount();
}

function updateSub() {
  const n = state.messages.length;
  const online = state.members.filter((m) => m.presence?.reachable).length;
  $('#chat-sub').textContent = `${n} 条消息 · ${state.members.length} 位成员（${online} 位可达）`;
}

function updateMentionCount() {
  const badge = $('#mention-count');
  const n = state.messages.filter((m) => m.sender !== 'user' && m.sender !== 'system' && mentionsMe(m.text)).length;
  badge.hidden = !n;
  badge.textContent = String(n);
}

function nameOf(sender) {
  if (sender === 'user') return '你';
  if (sender === 'system') return '系统';
  return state.members.find((m) => m.handle === sender)?.display || sender;
}

/** 成员消息里有没有点名主人。消息是纯文本，这里只做关键词判定。 */
function mentionsMe(text) {
  const body = String(text || '');
  return /@(我|me|你|主人|all|所有人|全体)/i.test(body);
}

function visibleMessages() {
  return state.tab === 'mentions'
    ? state.messages.filter((m) => m.sender !== 'user' && m.sender !== 'system' && mentionsMe(m.text))
    : state.messages;
}

function renderMessages() {
  const box = $('#messages');
  box.textContent = '';

  const list = visibleMessages();

  if (state.tab === 'all' && state.messages.length === 0) {
    box.append(
      emptyState(
        '这是一间新屋子',
        '说第一句话，或者用 <code>@成员名</code> 把它叫醒。成员离线时消息会排队等着，不会丢。',
      ),
    );
    return;
  }

  if (state.tab === 'mentions' && list.length === 0) {
    box.append(
      emptyState(
        '还没有 @ 你的消息',
        '成员的回复里出现 <code>@我</code>、<code>@me</code> 或 <code>@主人</code> 时会收进这里。',
      ),
    );
    return;
  }

  if (state.tab === 'all') box.append(buildPinned());

  let lastDay = '';
  for (const m of list) {
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      box.append(sep);
      lastDay = day;
    }
    box.append(buildMessage(m));
  }
  scrollToBottom(true);
}

function emptyState(title, text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML =
    `<div class="empty-icon"><svg viewBox="0 0 20 20" aria-hidden="true">` +
    `<path d="M4 4h12v9H8l-4 3V4Z" /></svg></div>` +
    `<div class="empty-title">${esc(title)}</div>` +
    `<div class="empty-text">${text}</div>`;
  return div;
}

/** 群简介：把「这个群是什么、怎么叫醒成员」讲清楚，同时露出在场的人。 */
function buildPinned() {
  const div = document.createElement('div');
  div.className = 'pinned';
  const faces = state.members
    .slice(0, 6)
    .map((m) => `<img src="${esc(avatarUrl(m, BASE))}" alt="${esc(m.display)}" title="${esc(m.display)}" />`)
    .join('');
  const names = state.members.map((m) => m.display).join('、');
  div.innerHTML =
    `<div class="pinned-top">` +
    `<span class="pinned-label">群简介</span>` +
    `<span class="pinned-title">${esc($('#chat-name').textContent)}</span>` +
    `<span class="pinned-faces">${faces}</span>` +
    `</div>` +
    `<div class="pinned-text">${
      state.members.length
        ? `${esc(names)} 在这个群里。用 <code>@名字</code> 叫醒成员，cli 型首次响应约 5 秒。`
        : '这个群还没有成员。到「成员管理」把 agent 拉进来，然后 <code>@它</code> 说话。'
    }</div>`;
  return div;
}

function appendMessage(m) {
  if (state.messages.some((x) => x.id === m.id)) return;
  state.messages.push(m);
  if (state.tab !== 'all') {
    renderMessages();
    return;
  }
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.append(buildMessage(m));
  if (nearBottom) scrollToBottom();
}

function buildMessage(m) {
  const wrap = document.createElement('div');
  const isMe = m.sender === 'user';
  const isSystem = m.sender === 'system';
  wrap.className = `msg${isMe ? ' is-me' : ''}${isSystem ? ' is-system' : ''}`;
  wrap.dataset.id = m.id;

  if (isSystem) {
    wrap.innerHTML = `<div class="msg-text">${esc(m.text)}</div>`;
    return wrap;
  }

  const member =
    state.members.find((x) => x.handle === m.sender) || {
      handle: m.sender,
      display: isMe ? '你' : m.sender,
      avatar: 'initial',
    };

  wrap.append(avatarEl(member, BASE));

  const block = document.createElement('div');
  block.className = 'msg-block';
  block.innerHTML =
    `<div class="msg-meta">` +
    `<span class="msg-name">${esc(isMe ? '你' : member.display)}</span>` +
    (isMe ? '' : `<span class="msg-handle">@${esc(m.sender)}</span>`) +
    `<span class="msg-time">${fmtTime(m.createdAt)}</span>` +
    `</div>` +
    `<div class="msg-text">${renderMarkdown(m.text, { members: state.members })}</div>`;

  // 悬浮操作：@ 它 / 复制原文
  const ops = document.createElement('div');
  ops.className = 'msg-ops';
  if (!isMe) {
    const at = document.createElement('button');
    at.type = 'button';
    at.className = 'msg-op';
    at.textContent = '@ 它';
    at.addEventListener('click', () => {
      const input = $('#input');
      input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}@${m.sender} `;
      input.focus();
      input.dispatchEvent(new Event('input'));
    });
    ops.append(at);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-op';
  copy.textContent = '复制';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      toast('已复制');
    } catch {
      toast('复制失败，浏览器不允许');
    }
  });
  ops.append(copy);
  wrap.append(block, ops);

  if (state.tab === 'mentions') wrap.classList.add('is-hit');
  return wrap;
}

/**
 * 把正文渲染成 HTML。
 * 转义、markdown、@ 染色全部在 markdown.js 里按「先转义后解析」的顺序完成，
 * 这里不再自己做一遍，避免两处规则漂移。
 */

function scrollToBottom(instant = false) {
  const box = $('#messages');
  box.style.scrollBehavior = instant ? 'auto' : 'smooth';
  box.scrollTop = box.scrollHeight;
  if (instant) setTimeout(() => (box.style.scrollBehavior = ''), 50);
}

// ── 发送 ────────────────────────────────────────────────────────────

function bindComposer() {
  const input = $('#input');
  const send = $('#btn-send');

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    send.disabled = !input.value.trim();
  };

  input.addEventListener('input', () => {
    autosize();
    updateMentionMenu();
  });

  input.addEventListener('keydown', (e) => {
    if (!state.mentionItems.length) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.mentionItems.length;
      state.mentionIndex = (state.mentionIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      paintMentionActive();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(state.mentionItems[state.mentionIndex]);
    } else if (e.key === 'Escape') {
      closeMentionMenu();
    }
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    const clientId = crypto.randomUUID();
    try {
      const res = await api.send(state.chatId, text, clientId);
      input.value = '';
      autosize();
      appendMessage(res.message);
      hintWaking(res.jobs);
      loadChats();
    } catch (ex) {
      toast(ex instanceof ApiError ? ex.message : '发送失败');
      send.disabled = false;
    }
  }
}

/** 投递给了「可唤醒」的成员时，明确告诉用户要等几秒，而不是让界面看起来没反应。 */
function hintWaking(jobs = []) {
  const wakening = jobs
    .map((j) => state.members.find((m) => m.handle === j.handle))
    .filter((m) => m && !m.presence?.ready);
  if (!wakening.length) return;
  const names = wakening.map((m) => m.display).join('、');
  toast(`正在唤醒 ${names}，首次响应约需 5 秒`);
}

// ── @ 菜单 ──────────────────────────────────────────────────────────

function updateMentionMenu() {
  const input = $('#input');
  const before = input.value.slice(0, input.selectionStart);
  const m = /(?:^|\s)@([^\s@]{0,20})$/.exec(before);
  if (!m) return closeMentionMenu();

  const q = m[1].toLowerCase();
  state.mentionQuery = q;
  state.mentionItems = state.members
    .filter((mm) => {
      if (!q) return true;
      return mm.handle.toLowerCase().includes(q) || mm.display.toLowerCase().includes(q);
    })
    .slice(0, 6);

  if (!state.mentionItems.length) return closeMentionMenu();
  state.mentionIndex = 0;
  paintMentionMenu();
}

function paintMentionMenu() {
  const menu = $('#mention-menu');
  menu.textContent = '';
  for (const [i, m] of state.mentionItems.entries()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `mention-item${i === state.mentionIndex ? ' is-active' : ''}`;
    item.append(avatarEl(m, BASE));
    const label = document.createElement('span');
    label.innerHTML = `<span>${esc(m.display)}</span><br><span class="mention-sub">@${esc(m.handle)}</span>`;
    item.append(label);
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickMention(m);
    });
    menu.append(item);
  }
  menu.hidden = false;
}

function paintMentionActive() {
  $$('.mention-item', $('#mention-menu')).forEach((el, i) =>
    el.classList.toggle('is-active', i === state.mentionIndex),
  );
}

function pickMention(member) {
  if (!member) return;
  const input = $('#input');
  const value = input.value;
  const pos = input.selectionStart;
  const before = value.slice(0, pos).replace(/(?:^|\s)@([^\s@]{0,20})$/, (full) => {
    const lead = full.startsWith('@') ? '' : full[0];
    return `${lead}@${member.handle} `;
  });
  input.value = before + value.slice(pos);
  input.selectionStart = input.selectionEnd = before.length;
  closeMentionMenu();
  input.focus();
  input.dispatchEvent(new Event('input'));
}

function closeMentionMenu() {
  state.mentionItems = [];
  $('#mention-menu').hidden = true;
}

// ── 右侧栏 ──────────────────────────────────────────────────────────

async function refreshMembers() {
  try {
    const { members } = await api.status(state.chatId);
    const had = state.members.length;
    state.members = members;
    renderMembersPanel();
    updateSub();
    // 消息里的 @ 高亮和群简介都依赖成员表；成员表首次到达时重画一次
    if (!had && members.length) renderMessages();
  } catch {
    // 面板刷新失败不打断主流程
  }
}

function renderMembersPanel() {
  const box = $('#panel-members');
  box.textContent = '';
  const title = document.createElement('p');
  title.className = 'panel-title';
  title.innerHTML = `<span>成员</span><span class="list-count">${state.members.length}</span>`;
  box.append(title);

  if (!state.members.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = '这个会话还没有成员。点左下角「成员管理」把 agent 拉进来。';
    box.append(p);
    return;
  }

  for (const m of state.members) {
    const row = document.createElement('div');
    row.className = 'member-row';
    row.append(avatarEl(m, BASE));

    const label = presenceLabel(m.presence, m.driverType);
    const main = document.createElement('div');
    main.className = 'member-main';
    main.innerHTML =
      `<div class="member-name"><span class="dot ${label.cls}"></span>${esc(m.display)}` +
      `<span class="msg-handle">@${esc(m.handle)}</span></div>` +
      `<div class="member-sub">${esc(
        m.presence?.ready
          ? m.driverType === 'cli'
            ? '就绪'
            : '在线'
          : m.presence?.reachable
            ? '可唤醒 · 约 5 秒响应'
            : '离线 · 消息会排队等待',
      )}</div>`;
    row.append(main);
    const badge = document.createElement('span');
    badge.className = `badge ${label.cls}`;
    badge.textContent = label.text;
    row.append(badge);
    box.append(row);
  }
}

async function loadJobs() {
  try {
    const { jobs } = await api.jobs(state.chatId);
    const box = $('#panel-jobs');
    box.textContent = '';
    const title = document.createElement('p');
    title.className = 'panel-title';
    title.innerHTML = `<span>最近投递</span><span class="list-count">${jobs.length}</span>`;
    box.append(title);

    if (!jobs.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = '还没有投递记录。发出带 @ 的消息后会出现在这里。';
      box.append(p);
      return;
    }

    const STATUS = {
      pending: ['排队中', 'is-wakeable'],
      processing: ['处理中', 'is-wakeable'],
      done: ['已回执', 'is-ready'],
      expired: ['已降级', 'is-offline'],
      failed: ['失败', 'is-offline'],
    };

    for (const j of jobs) {
      const [text, cls] = STATUS[j.status] || [j.status, ''];
      const row = document.createElement('div');
      row.className = 'job-row';
      row.innerHTML =
        `<div class="job-top"><span>@${esc(j.handle)}</span>` +
        `<span class="badge ${cls}">${text}</span></div>` +
        `<div class="job-text">${esc(j.text).slice(0, 60)}</div>` +
        `<div class="job-text">${fmtRelative(j.createdAt)}</div>`;
      box.append(row);
    }
  } catch {
    // 忽略：面板是辅助信息
  }
}

// 让成员视图能拿到当前会话列表刷新人选
export function chatOptions() {
  return state.chats.map((c) => ({ id: c.id, name: c.name }));
}

boot();
