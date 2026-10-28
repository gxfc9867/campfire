import { api, ApiError } from './api.js';
import {
  $,
  $$,
  esc,
  avatarEl,
  fmtTime,
  fmtRelative,
  dayLabel,
  toast,
  presenceLabel,
} from './ui.js';
import { initMembers } from './members.js';

/**
 * 前端主逻辑。
 *
 * 状态刻意保持扁平：一个 state 对象 + 若干渲染函数，没有虚拟 DOM 也没有框架。
 * 消息增量靠 seq 游标，SSE 只负责「叫醒」，即使漏事件也能靠下一轮拉取补上。
 */

const state = {
  me: null,
  chats: [],
  chatId: 'main',
  messages: [],
  lastSeq: 0,
  members: [],
  filterMentions: false,
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
  bindPanels();

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
  await loadChats();
  await selectChat(state.chats[0]?.id || 'main');
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

// ── 会话 ────────────────────────────────────────────────────────────

async function loadChats() {
  const { chats } = await api.chats();
  state.chats = chats;
  renderChats();
}

function renderChats() {
  const list = $('#chat-list');
  list.textContent = '';
  for (const c of state.chats) {
    const btn = document.createElement('button');
    btn.className = `chat-item${c.id === state.chatId ? ' is-active' : ''}`;
    const preview = c.last
      ? `${c.last.sender === 'user' ? '你' : nameOf(c.last.sender)}：${c.last.text}`
      : '还没有消息';
    btn.innerHTML =
      `<div class="chat-item-top">` +
      `<span class="chat-item-name">${esc(c.name)}</span>` +
      `<span class="chat-item-time">${c.last ? fmtTime(c.last.createdAt) : ''}</span>` +
      `</div>` +
      `<div class="chat-item-preview">${esc(preview)}</div>`;
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
  }
  if (state.messages.length) {
    state.lastSeq = state.messages[state.messages.length - 1].seq;
  }
  updateSub();
}

function updateSub() {
  const n = state.messages.length;
  const online = state.members.filter((m) => m.presence?.reachable).length;
  $('#chat-sub').textContent = `${n} 条消息 · ${state.members.length} 位成员（${online} 位可达）`;
}

function nameOf(sender) {
  if (sender === 'user') return '你';
  if (sender === 'system') return '系统';
  return state.members.find((m) => m.handle === sender)?.display || sender;
}

function renderMessages() {
  const box = $('#messages');
  box.textContent = '';
  let lastDay = '';
  for (const m of state.messages) {
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

function appendMessage(m) {
  if (state.messages.some((x) => x.id === m.id)) return;
  state.messages.push(m);
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

  const body = document.createElement('div');
  body.className = 'msg-body';
  const hit = state.filterMentions && !isMe && mentionsMe(m.text);
  if (hit) wrap.classList.add('is-hit');

  body.innerHTML =
    `<div class="msg-meta">` +
    `<span class="msg-name">${esc(isMe ? '你' : member.display)}</span>` +
    (isMe ? '' : `<span class="msg-handle">@${esc(m.sender)}</span>`) +
    `<span class="msg-time">${fmtTime(m.createdAt)}</span>` +
    `</div>` +
    `<div class="msg-text">${esc(m.text)}</div>`;
  wrap.append(body);
  return wrap;
}

function mentionsMe(text) {
  const body = String(text || '');
  return ['@我', '@me', '@你'].some((k) => body.includes(k)) || /(^|\s)@(all|所有人)/.test(body);
}

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
      return (
        mm.handle.toLowerCase().includes(q) ||
        mm.display.toLowerCase().includes(q)
      );
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

// ── 右侧面板 ────────────────────────────────────────────────────────

function bindPanels() {
  $$('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      const want = btn.dataset.panel;
      $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== want));
      $('#app').classList.add('drawer-open');
      if (want === 'jobs') loadJobs();
    });
  });

  $('#btn-mentions').addEventListener('click', () => {
    state.filterMentions = !state.filterMentions;
    $('#btn-mentions').dataset.on = String(state.filterMentions);
    renderMessages();
  });

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

async function refreshMembers() {
  try {
    const { members } = await api.status(state.chatId);
    state.members = members;
    renderMembersPanel();
    updateSub();
  } catch {
    // 面板刷新失败不打断主流程
  }
}

function renderMembersPanel() {
  const box = $('#panel-members');
  box.textContent = '';
  const title = document.createElement('p');
  title.className = 'panel-title';
  title.textContent = `成员 · ${state.members.length}`;
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
    title.textContent = `最近投递 · ${jobs.length}`;
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
        `<div class="job-text" style="margin-top:4px;color:var(--faint)">${fmtRelative(j.createdAt)}</div>`;
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
