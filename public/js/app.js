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
  oldestSeq: 0, // 已加载的最旧一条，历史翻页的游标
  hasOlder: false,
  loadingOlder: false,
  members: [],
  query: '',
  tab: 'all', // all | mentions
  es: null,
  mentionIndex: 0,
  mentionItems: [],
  mentionQuery: '',
  awayCount: 0, // 窗口不在前台期间攒下的新消息数，回到前台清零
  quoting: null, // 正在引用回复的消息
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
  // 桌面通知不弹窗打扰：只在用户主动问时才说明，这里静默探测一次
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    setTimeout(() => Notification.requestPermission().catch(() => {}), 4000);
  }
  await loadChats();
  // 默认进最近有动静的会话；全新空会话不抢默认位
  const latest =
    [...state.chats]
      .sort((a, b) => (b.last?.createdAt || b.updatedAt || 0) - (a.last?.createdAt || a.updatedAt || 0))
      .find((c) => c.last) || state.chats[0];
  await selectChat(latest?.id || 'main');
  initMembers({ onChanged: refreshMembers, onCompose: composeForMember, onOpenDm: openDm });
}

/**
 * 打开与某个成员的单聊：没有就建一条，已有就复用。
 * 成员管理里点「私聊」最后落到这里。
 */
export async function openDm(handle) {
  const { chat } = await api.createDm(handle);
  await loadChats();
  if (state.chatId === chat.id) renderChats();
  else await selectChat(chat.id);
  return chat;
}

/**
 * 接入页的「去群里跟它说句话」落到这里：切到主会话，把一句现成的开场白填好。
 * 刻意不代替用户按发送——发什么、发不发，主动权在人手里。
 */
async function composeForMember({ display }) {
  const target = state.chats.find((c) => c.id === 'main') || state.chats[0];
  if (target && target.id !== state.chatId) await selectChat(target.id);
  const input = $('#input');
  if (!input) return;
  input.value = `@${display} 用一句话介绍你自己`;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
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

  // 往上滚到顶附近就开始拉更早的历史；节流交给 loadingOlder 标志
  $('#messages').addEventListener(
    'scroll',
    () => {
      const box = $('#messages');
      if (box.scrollTop < 120) loadOlder();
    },
    { passive: true },
  );

  // 会话设置：右键会话，或点标题栏的「⋯」。主会话只允许改备注
  $('#chat-list').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    e.preventDefault();
    const chat = state.chats.find((c) => c.id === item.dataset.chat);
    if (chat) openChatMenu(chat, e.clientX, e.clientY);
  });

  $('#btn-chat-menu').addEventListener('click', (e) => {
    const chat = currentChat();
    if (!chat) return;
    const r = e.currentTarget.getBoundingClientRect();
    openChatMenu(chat, r.right - 168, r.bottom + 6);
  });

  $('#btn-clear-quote').addEventListener('click', clearQuote);
}

/** 群聊/单聊的设置菜单。入口有两个（右键、标题栏「⋯」），行为完全一致。 */
async function openChatMenu(chat, x, y) {
  const isDm = chat.kind === 'dm';
  const options =
    chat.id === 'main'
      ? ['改备注']
      : [isDm ? '给单聊改备注' : '给群改备注', isDm ? '删除单聊' : '解散群聊'];
  const act = await menuChoice(x, y, options);
  if (!act) return;
  if (act.includes('改备注')) return renameChatFlow(chat);
  if (act === '解散群聊') return dissolveChat(chat);
  if (act === '删除单聊') return removeDm(chat);
}

async function renameChatFlow(chat) {
  const isDm = chat.kind === 'dm';
  const name = prompt(
    isDm ? '给这个单聊起个备注（只改你这边的显示）' : '给这个群起个备注（只改你这边的显示）',
    chat.name,
  );
  if (!name?.trim() || name.trim() === chat.name) return;
  try {
    await api.renameChat(chat.id, name.trim());
    await loadChats();
    if (state.chatId === chat.id) {
      $('#chat-name').textContent = name.trim();
      renderMessages();
    }
  } catch (ex) {
    toast(ex.message);
  }
}

async function dissolveChat(chat) {
  const n = chat.members?.length || 0;
  const ok = confirm(
    `解散「${chat.name}」？\n\n` +
      `· 会话从列表里消失，${n} 位成员的归属一并解除\n` +
      `· 历史消息不再展示，无法恢复\n\n` +
      `只想换个名字的话，选「给群改备注」。`,
  );
  if (!ok) return;
  try {
    await api.deleteChat(chat.id);
    if (state.chatId === chat.id) await selectChat('main');
    await loadChats();
    toast(`已解散「${chat.name}」`);
  } catch (ex) {
    toast(ex.message);
  }
}

async function removeDm(chat) {
  const ok = confirm(
    `删除与「${chat.name}」的单聊？\n\n` +
      `消息会从列表隐藏，但不会丢——之后在成员那边点「私聊」，历史还在。`,
  );
  if (!ok) return;
  try {
    await api.deleteChat(chat.id);
    if (state.chatId === chat.id) await selectChat('main');
    await loadChats();
  } catch (ex) {
    toast(ex.message);
  }
}

/** 极简右键菜单：一个临时浮层，点别处就消失。 */
function menuChoice(x, y, options) {
  return new Promise((resolve) => {
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    // 贴着右边缘或底部时不越界：菜单宽约 150、高按项数估
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 170))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 40 - options.length * 34))}px`;
    for (const opt of options) {
      if (!opt) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt;
      b.addEventListener('click', () => {
        done(opt);
      });
      menu.append(b);
    }
    document.body.append(menu);
    const close = () => done(null);
    function done(v) {
      menu.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
      resolve(v);
    }
    setTimeout(() => document.addEventListener('click', close, { once: false }), 0);
    document.addEventListener('contextmenu', close);
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
    const isDm = c.kind === 'dm';
    // 外层是 div 不是 button：里面有「会话设置」按钮，button 不能嵌套 button
    const item = document.createElement('div');
    item.className = `chat-item${c.id === state.chatId ? ' is-active' : ''}${isDm ? ' is-dm' : ''}`;
    item.dataset.chat = c.id; // 右键菜单靠这个定位，别用名字匹配（名字会转义）
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const preview = c.last
      ? `${c.last.sender === 'user' ? '你' : nameOf(c.last.sender)}：${c.last.text}`
      : isDm
        ? '还没聊过，说第一句吧'
        : '还没有消息';
    const avatar = isDm
      ? `<span class="chat-avatar chat-avatar-dm"><img src="${esc(
          avatarUrl(c.peerInfo || { display: c.name }, BASE),
        )}" alt="" loading="lazy" /></span>`
      : `<span class="chat-avatar">${esc(c.name.slice(0, 1).toUpperCase())}</span>`;
    item.innerHTML =
      avatar +
      `<span class="chat-item-body">` +
      `<span class="chat-item-top">` +
      `<span class="chat-item-name">${esc(c.name)}${isDm ? '<i class="chat-kind">私聊</i>' : ''}</span>` +
      `<span class="chat-item-time">${c.last ? fmtTime(c.last.createdAt) : ''}</span>` +
      `</span>` +
      `<span class="chat-item-preview">${esc(preview)}</span>` +
      `</span>` +
      (c.unread ? `<span class="chat-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : '');

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chat-more';
    more.title = isDm ? '单聊设置' : '群聊设置';
    more.setAttribute('aria-label', more.title);
    more.textContent = '⋯';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openChatMenu(c, r.left - 120, r.bottom + 4);
    });
    item.append(more);

    item.addEventListener('click', () => selectChat(c.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectChat(c.id);
      }
    });
    list.append(item);
  }
}

/** 当前会话对象。单聊要拿 peerInfo，所以统一从这里取，不去翻 DOM 文本。 */
function currentChat() {
  return state.chats.find((c) => c.id === state.chatId) || null;
}

async function selectChat(id) {
  if (!id) return;
  state.chatId = id;
  state.messages = [];
  state.lastSeq = 0;
  state.oldestSeq = 0;
  state.hasOlder = false;
  state.awayCount = 0;
  updateTitleBadge();
  const chat = state.chats.find((c) => c.id === id) || null;
  const isDm = chat?.kind === 'dm';
  $('#chat-name').textContent = chat?.name || id;
  // 私聊里没有「叫醒谁」的问题：说给谁就发给谁，提示语也要跟着换
  $('#input').placeholder = isDm ? '直接说，消息只发给它' : '说点什么，@ 可以叫醒成员';
  $('#composer-hint').textContent = isDm ? '私聊不用 @ · Enter 发送' : 'Enter 发送 · Shift+Enter 换行';
  renderChats();
  await Promise.all([loadMessages(), refreshMembers(), loadJobs()]);
  connectEvents();
  // 告诉服务端读到哪了；顺手把侧栏的未读徽标清掉
  api.markRead(id, state.lastSeq).then(loadChats).catch(() => {});
  $('#input')?.focus();
}

function connectEvents() {
  state.es?.close();
  state.es = api.events(
    state.chatId,
    (evt) => {
      if (evt.type === 'message') {
        // 别的群来了消息：刷侧栏未读 + 视情况提醒，当前群照常拉增量
        if (evt.chatId && evt.chatId !== state.chatId) {
          loadChats();
          notifyIfHidden(evt.chatId);
          return;
        }
        loadMessages();
        if (document.hidden) {
          state.awayCount += 1;
          updateTitleBadge();
        } else {
          api.markRead(state.chatId, state.lastSeq).catch(() => {});
        }
      } else if (evt.type === 'members' || evt.type === 'memory') {
        refreshMembers();
      } else if (evt.type === 'chat' || evt.type === 'job') {
        loadChats();
        loadJobs();
      }
    },
    () => {
      // 断线由 EventSource 自己重连；这里只需保证回来时补一次增量
      setTimeout(() => loadMessages(), 3000);
    },
  );
}

// ── 未读提醒 ─────────────────────────────────────────────────────────

/** 窗口不在前台时收到新消息就 +1，回到前台清零。标题与通知都基于这个数。 */
function updateTitleBadge() {
  document.title = state.awayCount ? `(${state.awayCount}) 围炉` : '围炉 · campfire';
}

async function notifyIfHidden(chatId) {
  if (!document.hidden) return;
  const chat = state.chats.find((c) => c.id === chatId);
  const name = chat?.name || '新消息';
  updateTitleBadge();
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    // 只提示有消息的会话名，内容等用户点进来再看——通知里放正文容易在共享屏幕时泄露
    new Notification('围炉', { body: `「${name}」有新消息`, tag: `cf-${chatId}` });
  } catch {
    // 通知失败无所谓，标题还在
  }
}

window.addEventListener('focus', () => {
  state.awayCount = 0;
  updateTitleBadge();
  api.markRead(state.chatId, state.lastSeq).then(loadChats).catch(() => {});
});

// ── 消息 ────────────────────────────────────────────────────────────

async function loadMessages() {
  const after = state.lastSeq;
  const data = await api.messages(state.chatId, after ? { after } : {});
  if (!after) {
    state.messages = data.messages;
    state.hasOlder = data.hasMore;
    state.oldestSeq = state.messages[0]?.seq || 0;
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

/** 往上翻历史：以已加载的最旧一条为游标继续往前拉。 */
async function loadOlder() {
  if (!state.hasOlder || state.loadingOlder || !state.oldestSeq) return;
  state.loadingOlder = true;
  try {
    const data = await api.messages(state.chatId, { before: state.oldestSeq, limit: 50 });
    if (data.messages.length) {
      state.messages.unshift(...data.messages);
      state.oldestSeq = data.messages[0].seq;
      // 先记住视口位置，重绘后恢复——prepend 会让内容整体下移
      const box = $('#messages');
      const keep = box.scrollHeight - box.scrollTop;
      renderMessages({ restoreOffset: keep });
    }
    state.hasOlder = data.hasMore;
    renderOlderSentinel();
  } catch {
    // 拉不动就算了，下次滚动再试
  } finally {
    state.loadingOlder = false;
  }
}

/** 顶部那条「还有更早的」提示，有更多历史时才显示。 */
function renderOlderSentinel() {
  const el = $('#older-sentinel');
  if (!el) return;
  el.hidden = !state.hasOlder;
  el.textContent = state.loadingOlder ? '正在加载…' : '往上滚动加载更早的消息';
}

function updateSub() {
  const n = state.messages.length;
  const chat = currentChat();
  if (chat?.kind === 'dm') {
    const m = state.members[0];
    const label = m ? presenceLabel(m.presence, m.driverType) : null;
    $('#chat-sub').textContent = `${n} 条消息 · 单聊${label ? ` · 对方${label.text}` : ''}`;
    return;
  }
  const online = state.members.filter((m) => m.presence?.reachable).length;
  $('#chat-sub').textContent = `${n} 条消息 · ${state.members.length} 位成员（${online} 位可达）`;
}

function updateMentionCount() {
  const badge = $('#mention-count');
  const n = state.messages.filter(isMentionToOwner).length;
  badge.hidden = !n;
  badge.textContent = String(n);
}

function nameOf(sender) {
  if (sender === 'user') return '你';
  if (sender === 'system') return '系统';
  return state.members.find((m) => m.handle === sender)?.display || sender;
}

/**
 * 这条成员消息算不算「点名主人」。
 * 判定在服务端回复落库时就做好了（meta.mentionsOwner）：
 * 显式写了 @主人/@me，或者它本来就是在回应主人发起的那条消息。
 * 前端不再用关键词猜——之前那套正则会把成员说的「你可以试试」也算进去。
 */
function isMentionToOwner(m) {
  return m.sender !== 'user' && m.sender !== 'system' && Boolean(m.meta?.mentionsOwner);
}

function visibleMessages() {
  return state.tab === 'mentions' ? state.messages.filter(isMentionToOwner) : state.messages;
}

function renderMessages({ restoreOffset = 0 } = {}) {
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
        '成员回复里点名 <code>@主人</code>，或是在回应你发起的那条消息，就会收进这里。',
      ),
    );
    return;
  }

  // 历史翻页的提示条；放最顶上，有更早的消息时才露出来
  const sentinel = document.createElement('div');
  sentinel.className = 'older-sentinel';
  sentinel.id = 'older-sentinel';
  sentinel.hidden = !state.hasOlder;
  sentinel.textContent = state.loadingOlder ? '正在加载…' : '往上滚动加载更早的消息';
  if (state.tab === 'all') box.append(sentinel);

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

  if (restoreOffset) {
    // 翻历史时保持视口里的内容不动，而不是跳回底部
    box.scrollTop = box.scrollHeight - restoreOffset;
  } else {
    scrollToBottom(true);
  }
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
  const chat = currentChat();
  if (chat?.kind === 'dm') return buildDmPinned(chat);

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

/** 单聊的置顶块：对方是谁、现在什么状态，比群简介更该说的是这两件事。 */
function buildDmPinned(chat) {
  const div = document.createElement('div');
  div.className = 'pinned pinned-dm';
  const m = state.members[0];
  const label = m ? presenceLabel(m.presence, m.driverType) : null;
  const name = m?.display || chat.peerInfo?.display || chat.name;
  div.innerHTML =
    `<div class="pinned-top">` +
    `<span class="pinned-label">单聊</span>` +
    `<span class="pinned-title">${esc(name)}</span>` +
    `<span class="pinned-faces">${m ? `<img src="${esc(avatarUrl(m, BASE))}" alt="" />` : ''}</span>` +
    (label ? `<span class="badge ${label.cls}">${label.text}</span>` : '') +
    `</div>` +
    `<div class="pinned-text">${
      m?.persona
        ? esc(m.persona.slice(0, 140))
        : '这是你和它的单聊。消息直接发给它，不用 <code>@</code>；它说什么也只有你能看到。'
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

  // 被引用的原消息：在本会话已加载的消息里找，找不到就退化为一条摘要
  const quoted = m.replyTo ? state.messages.find((x) => x.id === m.replyTo) : null;

  block.innerHTML =
    `<div class="msg-meta">` +
    `<span class="msg-name">${esc(isMe ? '你' : member.display)}</span>` +
    (isMe ? '' : `<span class="msg-handle">@${esc(m.sender)}</span>`) +
    `<span class="msg-time">${fmtTime(m.createdAt)}</span>` +
    (m.meta?.edited ? '<span class="msg-edited">已编辑</span>' : '') +
    `</div>` +
    (quoted
      ? `<button type="button" class="msg-quote" data-jump="${esc(quoted.id)}">` +
        `<b>${esc(nameOf(quoted.sender))}</b>${esc(String(quoted.text).slice(0, 80))}` +
        `</button>`
      : '') +
    (m.meta?.deleted
      ? '<div class="msg-text msg-deleted">消息已删除</div>'
      : `<div class="msg-text">${renderMarkdown(m.text, { members: state.members })}</div>`);

  if (quoted) {
    block.querySelector('.msg-quote')?.addEventListener('click', () => {
      const el = $(`#messages .msg[data-id="${quoted.id}"]`);
      if (!el) return toast('原消息不在当前视图里');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('is-flash');
      setTimeout(() => el.classList.remove('is-flash'), 1500);
    });
  }

  // 悬浮操作：@ 它 / 引用 / 编辑或删除 / 复制
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

  ops.append(opButton('引用', () => startQuote(m)));

  if (isMe && !m.meta?.deleted) {
    ops.append(
      opButton('编辑', async () => {
        const next = prompt('修改这条消息', m.text);
        if (next === null || !next.trim() || next === m.text) return;
        try {
          await api.editMessage(m.id, next.trim());
          loadMessages();
        } catch (ex) {
          toast(ex instanceof ApiError ? ex.message : '修改失败');
        }
      }),
    );
  }

  ops.append(
    opButton('删除', async () => {
      if (!confirm('删除这条消息？正文会清空，位置保留。')) return;
      try {
        await api.deleteMessage(m.id);
        loadMessages();
      } catch (ex) {
        toast(ex instanceof ApiError ? ex.message : '删除失败');
      }
    }),
  );

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

function opButton(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'msg-op';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

// ── 引用回复 ─────────────────────────────────────────────────────────

function startQuote(m) {
  state.quoting = m;
  const bar = $('#quote-bar');
  bar.hidden = false;
  $('#quote-who').textContent = nameOf(m.sender);
  $('#quote-text').textContent = String(m.text).replace(/\s+/g, ' ').slice(0, 80);
  $('#input').focus();
}

function clearQuote() {
  state.quoting = null;
  $('#quote-bar').hidden = true;
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
      if (state.quoting) clearQuote();
      else closeMentionMenu();
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
    const quote = state.quoting?.id || null;
    try {
      const res = await api.send(state.chatId, text, clientId, quote);
      input.value = '';
      clearQuote();
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
  // 单聊里没有「叫醒谁」的问题，@ 菜单只会在自己脑子里造成歧义
  if (currentChat()?.kind === 'dm') return closeMentionMenu();
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
    const [{ jobs }, st] = await Promise.all([
      api.jobs(state.chatId),
      api.status(state.chatId).catch(() => null),
    ]);
    const box = $('#panel-jobs');
    box.textContent = '';
    const title = document.createElement('p');
    title.className = 'panel-title';
    // 连接数读数：成员多了以后，用户需要知道当前挂着几条长轮询
    title.innerHTML =
      `<span>最近投递</span>` +
      `<span class="list-count">${jobs.length} 条 · 长轮询 ${st?.counts?.polls ?? '—'}</span>`;
    box.append(title);

    if (!jobs.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = '还没有投递记录。发出带 @ 的消息后会出现在这里。';
      box.append(p);
      return;
    }

    const STATUS = {
      pending: ['排队中', 'is-wakeable', ['cancel', '取消']],
      processing: ['处理中', 'is-wakeable', []],
      done: ['已回执', 'is-ready', []],
      expired: ['已降级', 'is-offline', ['retry', '重试']],
      failed: ['失败', 'is-offline', ['retry', '重试']],
      cancelled: ['已取消', 'is-offline', ['retry', '重试']],
    };

    for (const j of jobs) {
      const [text, cls, actions] = STATUS[j.status] || [j.status, '', []];
      const row = document.createElement('div');
      row.className = 'job-row';
      row.innerHTML =
        `<div class="job-top"><span>@${esc(j.handle)}</span>` +
        `<span class="badge ${cls}">${text}</span></div>` +
        `<div class="job-text">${esc(j.text).slice(0, 60)}</div>` +
        `<div class="job-text">${fmtRelative(j.createdAt)}</div>`;

      // 挂着不动的投递要给出口：能重试、能取消，而不是只能看着它降级
      if (actions.length) {
        const ops = document.createElement('div');
        ops.className = 'job-ops';
        for (const [act, label] of actions) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `text-btn sm${act === 'cancel' ? ' danger' : ''}`;
          b.textContent = label;
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              if (act === 'retry') await api.retryJob(j.id);
              else await api.cancelJob(j.id);
              loadJobs();
            } catch (ex) {
              toast(ex instanceof ApiError ? ex.message : '操作失败');
              b.disabled = false;
            }
          });
          ops.append(b);
        }
        row.append(ops);
      }
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
