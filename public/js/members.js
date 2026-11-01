import { api, ApiError } from './api.js';
import { $, $$, esc, avatarUrl, initialAvatar, fmtRelative, toast, presenceLabel } from './ui.js';

/**
 * 成员管理视图。
 *
 * 与群聊主界面解耦：只依赖 api 与 ui，不读 app.js 的内部状态。
 * 需要刷新的地方通过 onChanged 回调通知外面。
 */

let onChanged = () => {};
let onCompose = () => {};
let onOpenDm = async () => {};
let state = { members: [], etag: '', chats: [], presets: [], providers: null, editing: null, drafts: {} };

/** 接入向导的会话状态。key 加下划线前缀表示「只在此处流转，不进持久层」。 */
let connect = { handle: '', key: '', name: '', driverType: '', timer: null, shown: false };

export function initMembers({ onChanged: cb, onCompose: composeCb, onOpenDm: dmCb } = {}) {
  onChanged = cb || (() => {});
  onCompose = composeCb || (() => {});
  onOpenDm = dmCb || (async () => {});
  bind();
}

function bind() {
  $('#btn-members').addEventListener('click', open);
  $('#btn-close-members').addEventListener('click', close);
  $('#btn-add-member').addEventListener('click', () => openEditor(null));
  $('#btn-close-editor').addEventListener('click', closeEditor);
  $('#btn-cancel-edit').addEventListener('click', closeEditor);
  $('#btn-archive').addEventListener('click', archive);
  // 编辑已有成员时也要能回到接入设置：DSH 插件换令牌、换群都在这页
  $('#btn-connect-from-editor').addEventListener('click', () => {
    if (!state.editing) return;
    openConnect(state.editing);
  });
  $('#btn-purge').addEventListener('click', () => {
    const m = state.members.find((x) => x.handle === state.editing);
    if (m) confirmPurge(m);
  });
  $('#btn-roll-avatar').addEventListener('click', rollAvatar);
  $('#editor-form').addEventListener('submit', save);

  $('#btn-close-connect').addEventListener('click', () => closeConnect());
  $('#btn-reveal-key').addEventListener('click', toggleKey);
  $('#btn-rotate-key').addEventListener('click', rotateKey);
  $('#btn-probe').addEventListener('click', probeMember);
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', () => copyBlock(btn)));

  // 已归档成员：展开时才拉数据
  const archivedSection = document.getElementById('archived-members-section');
  archivedSection?.addEventListener('toggle', () => {
    if (archivedSection.open) refreshArchivedMembers();
  });

  $$('input[name="driverType"]').forEach((r) =>
    r.addEventListener('change', () => syncDriverFields()),
  );

  // 换服务商就把地址和模型名带过去，省得用户去翻文档抄 URL
  $('#llm-provider')?.addEventListener('change', onProviderChange);

  $('#btn-try-member')?.addEventListener('click', tryMember);

  // 备注名变化时实时更新预览头像上的字
  $('#editor-form').elements.display?.addEventListener('input', updateAvatarPreview);
}


async function open() {
  $('#members-view').hidden = false;
  await reload();
}

function close() {
  $('#members-view').hidden = true;
}

async function reload() {
  try {
    const [m, c, a] = await Promise.all([api.members(), api.chats(), api.avatars()]);
    state.members = m.members;
    state.etag = m.etag;
    state.chats = c.chats;
    state.presets = a.presets;
    renderGrid();
  } catch (ex) {
    toast(ex instanceof ApiError ? ex.message : '加载成员失败');
  }
}

/** 已归档成员：默认收起，展开时才拉数据。 */
async function refreshArchivedMembers() {
  const list = document.getElementById('archived-members-list');
  const countEl = document.getElementById('archived-members-count');
  if (!list) return;

  try {
    const res = await api.members({ archived: true });
    const items = res.members || [];
    if (countEl) countEl.textContent = items.length ? `(${items.length})` : '';
    list.textContent = '';

    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'archive-empty';
      p.textContent = '没有归档的成员';
      list.append(p);
      return;
    }

    for (const m of items) {
      const row = document.createElement('div');
      row.className = 'archive-row';

      const name = document.createElement('span');
      name.className = 'archive-row-name';
      name.textContent = `${m.display} @${m.handle}`;

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'text-btn';
      restore.textContent = '恢复';
      restore.addEventListener('click', async () => {
        try {
          await api.restoreMember(m.handle);
          toast(`已恢复「${m.display}」`);
          await reload();
          refreshArchivedMembers();
          onChanged();
        } catch (e) {
          toast(e.message);
        }
      });

      const purge = document.createElement('button');
      purge.type = 'button';
      purge.className = 'text-btn danger';
      purge.textContent = '彻底删除';
      purge.addEventListener('click', () => confirmPurge(m));

      row.append(name, restore, purge);
      list.append(row);
    }
  } catch (e) {
    list.textContent = '';
    const p = document.createElement('p');
    p.className = 'archive-empty';
    p.textContent = `读取失败：${e.message}`;
    list.append(p);
  }
}

function renderGrid() {
  const grid = $('#member-grid');
  grid.textContent = '';

  if (!state.members.length) {
    const p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent =
      '还没有成员。点右上角「新建成员」，给一个 agent 起个名字、选个头像，再告诉桥该怎么唤起它。';
    grid.append(p);
    return;
  }

  for (const m of state.members) {
    // 卡片主体和「接入信息」是两个独立按钮，所以外层必须是 div 而不是 button——
    // HTML 不允许按钮嵌套按钮，否则点击内层会同时触发外层。
    const card = document.createElement('div');
    card.className = 'member-card';

    const img = document.createElement('img');
    img.src = avatarUrl(m, api.base);
    img.alt = '';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.append(img);

    const label = presenceLabel(m.presence, m.driverType);
    // 大模型成员把模型名显示出来比显示 "llm" 有用：一眼知道它是哪个脑子
    const driverText = m.driverType === 'llm' ? m.driver?.model || '大模型' : m.driverType;
    const main = document.createElement('div');
    main.className = 'member-card-main';
    main.innerHTML =
      `<div class="member-card-name">${esc(m.display)}` +
      `<span class="dot ${label.cls}"></span>` +
      `<span class="badge ${label.cls}">${label.text}</span></div>` +
      `<div class="member-card-handle">@${esc(m.handle)}</div>` +
      `<div class="member-card-foot">` +
      `<span>${esc(driverText)}</span>` +
      `<span>${m.chats.length} 个会话</span>` +
      `<span>记忆 ${m.memory?.chars ? `${m.memory.chars} 字` : '空'}</span>` +
      `</div>`;

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'member-card-hit';
    hit.append(av, main);
    hit.addEventListener('click', () => openEditor(m.handle));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn-sm';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openEditor(m.handle));

    const wire = document.createElement('button');
    wire.type = 'button';
    wire.className = 'btn-sm';
    wire.textContent = '接入';
    wire.addEventListener('click', () => openConnect(m.handle));

    // 单聊入口：卡片上直接给，不用先回大厅再找它
    const dm = document.createElement('button');
    dm.type = 'button';
    dm.className = 'btn-sm';
    dm.textContent = '私聊';
    dm.addEventListener('click', async () => {
      close();
      try {
        await onOpenDm(m.handle);
      } catch (ex) {
        toast(ex.message);
      }
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-sm danger';
    del.textContent = '删除';
    del.addEventListener('click', () => confirmPurge(m));

    const actions = document.createElement('div');
    actions.className = 'member-card-actions';
    actions.append(edit, dm, wire, del);

    card.append(hit, actions);
    grid.append(card);
  }
}

// ── 测试连接 ─────────────────────────────────────────────────────────

/**
 * 桥侧自检：这个成员的通道到底通不通。
 * 只查服务端掌握的事实（sidecar 在不在、上次活跃时间、唤醒决策），
 * 不真的拉起进程——真跑一次命令是「深度测试」，交给 doctor。
 */
/**
 * 页面内信息弹窗。
 *
 * 不用 alert()：原生弹窗位置由浏览器决定，在小窗口里会顶出可视区，
 * 而且样式完全不可控。这里自己画一个居中的卡片，内容再多也能滚动。
 */
function showInfoDialog(title, rows) {
  document.getElementById('cf-info-dialog')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cf-info-dialog';
  overlay.className = 'cf-dialog-overlay';

  const card = document.createElement('div');
  card.className = 'cf-dialog';

  const h = document.createElement('h3');
  h.textContent = title;
  card.append(h);

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'cf-dialog-row';
    const l = document.createElement('span');
    l.className = 'cf-dialog-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'cf-dialog-value';
    v.textContent = value;
    row.append(l, v);
    card.append(row);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary-btn';
  btn.textContent = '知道了';
  btn.addEventListener('click', () => overlay.remove());
  card.append(btn);

  overlay.append(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

async function probeMember() {
  const handle = state.editing;
  if (!handle) return;
  const btn = $('#btn-probe');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    const r = await api.probeMember(handle);

    // llm 型是真的打了一次模型接口，结果直接说人话
    if (r.driverType === 'llm') {
      showInfoDialog(`成员 ${handle} · 大模型直连`, [
        ['结果', r.ok ? '通了' : '没通'],
        ['模型', r.ok ? r.model : '—'],
        ['耗时', `${(r.latencyMs / 1000).toFixed(1)} 秒`],
        [r.ok ? '它说' : '原因', r.ok ? r.reply : r.hint],
      ]);
      return;
    }

    const seen = r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '从未';
    const stateText =
      { hot: '长轮询挂起中', warm: '低频轮询', cold: '离线', wake: '唤醒中' }[r.state] || r.state;
    showInfoDialog(`成员 ${handle} · ${r.driverType}`, [
      ['通道', r.reachable ? '已连接' : '未连接'],
      ['状态', stateText],
      ['可立即响应', r.ready ? '是' : '否'],
      ['最近活跃', seen],
      ['全局连接', `长轮询 ${r.polls} 条`],
      ['说明', r.hint],
    ]);
  } catch (ex) {
    toast(ex instanceof ApiError ? ex.message : '测试失败');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}


// ── 接入向导 ─────────────────────────────────────────────────────────

/**
 * 建成员和「让它跑起来」是两件事，之前只有前者。这个弹层负责后者：
 * 给出可直接复制的配置与命令，并且实时盯着成员有没有连上来。
 */
async function openConnect(handle, key) {
  const member = state.members.find((m) => m.handle === handle);
  const driverType = member?.driverType || member?.driver?.type || 'pull';
  connect = {
    handle,
    key: key || '',
    name: member?.display || handle,
    driverType,
    timer: null,
    shown: false,
  };

  $('#connect-name').textContent = connect.name;
  $('#member-connect').hidden = false;
  const waitingText =
    driverType === 'pull'
      ? '插件还没连上来 · 在 DSH 里填好三项并重启后，这里会自动变绿'
      : '等待 sidecar 连上来…';
  setConnectState('waiting', member?.presence?.reachable ? '正在确认状态…' : waitingText);

  // 密钥可能没随列表下发明文，单独取一次；失败就留空让用户点「显示」重试
  if (!connect.key) {
    try {
      const res = await api.member(handle);
      connect.key = res.key || '';
      if (res.member) state.etag = res.etag || state.etag;
    } catch {
      // 取不到不影响展示配置骨架
    }
  }

  renderConnect();
  // 大模型成员不需要等任何人连上来，省掉那套 2.5 秒轮询
  if (driverType !== 'llm') pollConnect();
}

/** 接入页对「桥内直连」的成员换一套说法：它已经能说话了，不需要任何外部进程。 */
function renderConnectForLlm() {
  $('#connect-manual').hidden = true;
  $('#connect-ready').hidden = false;
  $('#connect-dsh').hidden = true;
  $('#connect-lead').hidden = true;
  setConnectState('online', '已就绪 · 回群里 @ 它试试');
}

/* ── pull 驱动（DSH 插件 / WorkBuddy 桥）：走渠道令牌 ─────────────── */

/** 刚生成的渠道令牌明文：只活在本次弹层里，服务端之后不会再回传。 */
let freshChannelToken = '';

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

async function renderConnectForDsh() {
  $('#connect-manual').hidden = true;
  $('#connect-ready').hidden = true;
  $('#connect-dsh').hidden = false;
  $('#connect-lead').hidden = true;
  // 成员密钥是给 sidecar 用的，pull 路线用不上，藏掉免得误导
  $('.connect-key').hidden = true;

  await renderChannelArea();
  renderDshParams();
}

/** 第 1 步：渠道令牌的生成 / 列表 / 吊销。 */
async function renderChannelArea() {
  const area = $('#connect-channel-area');
  if (!area) return;
  area.textContent = '';

  let channels = [];
  try {
    const res = await api.channels(connect.handle);
    channels = (res.channels || []).filter((c) => !c.revokedAt);
  } catch (error) {
    area.append(el('p', { class: 'field-error', text: `读取渠道令牌失败：${error.message}` }));
    return;
  }

  // 刚生成的明文：最显眼的位置，带复制
  if (freshChannelToken) {
    const copyBtn = el('button', { type: 'button', class: 'text-btn' }, '复制');
    copyBtn.addEventListener('click', () => copyText(freshChannelToken, copyBtn));
    area.append(
      el(
        'div',
        { class: 'code-box' },
        el(
          'div',
          { class: 'code-head' },
          el('span', { text: '刚生成的令牌（只显示这一次）' }),
          copyBtn,
        ),
        el('pre', { text: freshChannelToken }),
      ),
      el('p', { class: 'field-hint', text: '关掉这个窗口就再也看不到明文了。没记下就删掉重新生成一把。' }),
    );
  }

  if (channels.length) {
    const list = el('div', { class: 'channel-list' });
    for (const ch of channels) {
      const row = el(
        'div',
        { class: 'channel-row' },
        el('span', { class: 'channel-name', text: ch.name || ch.id }),
        el('span', { class: 'channel-meta', text: `创建于 ${fmtRelative(ch.createdAt)}` }),
      );
      const revoke = el('button', { type: 'button', class: 'text-btn danger' }, '吊销');
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`吊销令牌「${ch.name || ch.id}」？用它接入的客户端会立刻 401。`)) return;
        try {
          await api.revokeChannel(ch.id);
          toast('已吊销');
          freshChannelToken = '';
          await renderChannelArea();
          renderDshParams();
        } catch (error) {
          toast(error.message);
        }
      });
      row.append(revoke);
      list.append(row);
    }
    area.append(list);
  }

  // 首次生成用主按钮：这是整个接入流程的起点，藏成文字链会让人找不到
  const btn = el(
    'button',
    { type: 'button', class: channels.length ? 'ghost-btn' : 'primary-btn' },
    channels.length ? '再生成一把' : '生成渠道令牌',
  );
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await api.createChannel(connect.handle, `${connect.name}-dsh`);
      freshChannelToken = res.token || '';
      toast('令牌已生成，明文只显示这一次');
      await renderChannelArea();
      renderDshParams();
    } catch (error) {
      toast(error.message);
      btn.disabled = false;
    }
  });
  area.append(el('div', { class: 'channel-actions' }, btn));
}

/** 第 2 步：把要填进 DSH 的三项摆出来。 */
function renderDshParams() {
  const pre = $('#connect-dsh-params');
  if (!pre) return;
  const base = publicBase();
  const tokenLine = freshChannelToken || '（第 1 步生成的那把，复制过来）';
  pre.textContent =
    `围炉地址      ${base}\n` +
    `渠道令牌      ${tokenLine}\n` +
    `成员特征名    ${connect.handle}`;
}

/** 去主界面，把一句现成的开场白填进输入框——让「测一下」变成一次回车。 */
function tryMember() {
  const name = connect.name;
  closeConnect();
  onCompose({ display: name });
}

function closeConnect() {
  if (connect.timer) clearTimeout(connect.timer);
  connect = { handle: '', key: '', name: '', driverType: '', timer: null, shown: false };
  freshChannelToken = '';
  $('#member-connect').hidden = true;
  // 从「新建」流程进来的，关掉接入页才算真正结束，此时回到列表
  if (!$('#member-editor').hidden) closeEditor();
  reload();
  onChanged();
}

function renderConnect() {
  const base = publicBase();
  const key = connect.key || 'YOUR_KEY';
  const cfg = { url: base, members: [{ handle: connect.handle, key }] };

  if (connect.driverType === 'llm') {
    renderConnectForLlm();
    // 成员密钥是「外部进程来认领身份」用的，桥内直连的成员根本用不上，藏掉免得误导
    $('.connect-key').hidden = true;
    return;
  }
  // pull 驱动走的是渠道令牌 + /v1 接口（DSH 插件、WorkBuddy 桥），和 sidecar 完全两套
  if (connect.driverType === 'pull') {
    renderConnectForDsh();
    return;
  }
  $('#connect-manual').hidden = false;
  $('#connect-ready').hidden = true;
  $('#connect-dsh').hidden = true;
  $('#connect-lead').hidden = false;
  $('.connect-key').hidden = false;

  $('#connect-config').textContent = JSON.stringify(cfg, null, 2);
  $('#connect-cmd').textContent = 'node sidecar/sidecar.js';
  $('#connect-curl').textContent =
    `curl -s -H "X-Campfire-Member: ${connect.handle}" ` +
    `-H "X-Campfire-Key: ${key}" ` +
    `"${base}/api/agent/profile"`;
  $('#connect-key').textContent = connect.shown ? key : mask(connect.key);
  $('#btn-reveal-key').textContent = connect.shown ? '隐藏' : '显示';
  $('#connect-key-note').textContent = connect.shown
    ? '密钥等同这个成员的身份，别贴进公开仓库。'
    : '密钥默认打码，展开后可复制。换机器或重装时用得上。';
}

function publicBase() {
  return `${location.origin}${api.base || ''}`;
}

function mask(key) {
  if (!key) return '••••••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(Math.max(6, key.length - 6))}${key.slice(-2)}`;
}

function setConnectState(stateName, text) {
  $('#connect-status').dataset.state = stateName;
  $('#connect-status-text').textContent = text;
}

/** 每 2.5 秒问一次这个成员在不在，连上就停。最多盯 5 分钟，避免弹层开着一直打请求。 */
function pollConnect() {
  const handle = connect.handle;
  let tries = 0;

  const tick = async () => {
    if (connect.handle !== handle) return;
    tries += 1;
    try {
      const { member } = await api.member(handle);
      if (connect.handle !== handle) return;
      if (member.presence?.reachable) {
        const ready = member.presence?.ready;
        setConnectState('online', ready ? '已接入 · 正在待命' : '已接入 · 可唤醒');
        return;
      }
    } catch {
      // 轮询失败不打扰用户，下一轮继续
    }
    if (tries >= 120) {
      setConnectState('waiting', '还没检测到连接。检查 sidecar 日志里的地址与密钥，或点「显示」核对一遍');
      return;
    }
    connect.timer = setTimeout(tick, 2500);
  };

  connect.timer = setTimeout(tick, 800);
}

async function toggleKey() {
  if (!connect.key) {
    try {
      const res = await api.member(connect.handle);
      connect.key = res.key || '';
    } catch (ex) {
      return toast(ex instanceof ApiError ? ex.message : '取不到密钥');
    }
  }
  connect.shown = !connect.shown;
  renderConnect();
}

async function rotateKey() {
  const ok = confirm(
    `重新生成后，旧密钥立刻失效。\n\n` +
      `已经在跑的 sidecar 会断开连接，必须把新密钥写进配置再重启。\n\n确定继续吗？`,
  );
  if (!ok) return;
  try {
    const res = await api.rotateKey(connect.handle);
    connect.key = res.key;
    connect.shown = true;
    renderConnect();
    setConnectState('waiting', '密钥已更换，等待用新密钥的 sidecar 连上来…');
    pollConnect();
    toast('新密钥已生成，配置里的 key 需要更新');
  } catch (ex) {
    toast(ex instanceof ApiError ? ex.message : '重新生成失败');
  }
}

/**
 * 复制到剪贴板。
 *
 * navigator.clipboard 只在 secure context（HTTPS / localhost）里可用，而围炉
 * 通常是局域网 http 部署（http://192.168.x.x:8099），那种情况下 API 直接不可用，
 * 必须退回 execCommand('copy')——否则「复制」按钮就是个摆设。
 */
async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走下面的兜底
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // 用「移出屏幕」而不是 opacity:0 —— 后者在部分浏览器里选不中文本，
    // execCommand('copy') 会拿到空串，表现为「点了复制但剪贴板没变」。
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.fontSize = '12pt';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyBlock(btn) {
  const target = document.getElementById(btn.dataset.copy);
  const text = target?.textContent || '';
  const ok = await copyToClipboard(text);
  if (!ok) {
    toast('浏览器不允许自动复制，请手动选中');
    return;
  }
  const old = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => (btn.textContent = old), 1400);
}

/** 动态生成的按钮用不了 [data-copy] 的一次性绑定，所以单独给一个直接复制文本的入口。 */
async function copyText(text, btn) {
  const ok = await copyToClipboard(text);
  if (!ok) {
    toast('浏览器不允许自动复制，请手动选中');
    return;
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = old), 1400);
  }
}

// ── 编辑 ────────────────────────────────────────────────────────────


async function openEditor(handle) {
  const form = $('#editor-form');
  form.reset();
  $('#editor-error').hidden = true;
  $('#editor-title').textContent = handle ? '编辑成员' : '新建成员';
  $('#btn-archive').hidden = !handle;
  $('#btn-probe').hidden = !handle;
  $('#btn-connect-from-editor').hidden = !handle;
  $('#btn-purge').hidden = !handle;
  state.editing = handle;
  state.drafts = {};

  let detail = null;
  if (handle) {
    try {
      const res = await api.member(handle);
      detail = res.member;
      state.etag = res.etag;
      state.drafts.key = res.key;
    } catch (ex) {
      return toast(ex.message);
    }
  }

  form.elements.display.value = detail?.display || '';
  form.elements.handle.value = detail?.handle || '';
  form.elements.handle.readOnly = Boolean(handle);
  form.elements.digest.value = detail?.digest || '';

  const driver = detail?.driver || { type: 'pull' };
  const radio = $$('input[name="driverType"]').find((r) => r.value === driver.type);
  if (radio) radio.checked = true;
  // llm / cli 已从表单下架：老成员打开编辑时说明一下，保存会迁移成 pull
  const deprecatedHint = $('#driver-deprecated-hint');
  if (deprecatedHint) {
    const gone = driver.type === 'llm' || driver.type === 'cli';
    deprecatedHint.hidden = !gone;
    deprecatedHint.textContent = gone
      ? `该成员原本使用已下架的 ${driver.type} 驱动，保存后会改成 pull。`
      : '';
  }
  form.elements.cmd.value = driver.cmd || '';
  form.elements.args.value = Array.isArray(driver.args) ? driver.args.join(' ') : '';
  form.elements.cwd.value = driver.cwd || '';
  form.elements.url.value = driver.url || '';

  await ensureProviders();
  fillProviderOptions(driver.provider);
  form.elements.model.value = driver.model || '';
  form.elements.baseUrl.value = driver.baseUrl || '';
  form.elements.temperature.value = driver.temperature ?? '';
  form.elements.maxTokens.value = driver.maxTokens ?? '';
  // 密钥从不回传明文：编辑时留空即可保持不变
  form.elements.apiKey.value = '';
  form.elements.apiKey.placeholder = driver.hasKey ? '已保存，留空表示不修改' : 'sk-…';
  $('#llm-key-hint').hidden = !driver.hasKey;

  state.drafts.avatar = detail?.avatar || 'preset:01';
  state.drafts.avatarSalt = detail?.avatarSalt || 0;

  renderChatChecks(detail?.chats || []);
  renderAvatarGrid();
  updateAvatarPreview();
  syncDriverFields();

  // 特征名实时校验：格式不对立刻说明原因，不用等到点保存才报错
  const handleInput = form.elements.handle;
  const handleErr = $('#handle-error');
  const checkHandle = () => {
    if (handleInput.readOnly) {
      handleErr.hidden = true;
      handleInput.classList.remove('invalid');
      return;
    }
    const v = handleInput.value.trim();
    let msg = '';
    if (v) {
      if (/[A-Z]/.test(v)) msg = '不能有大写字母，请改成小写（例：dsh-pc）';
      else if (!/^[a-z]/.test(v)) msg = '必须以小写字母开头';
      else if (!/^[a-z][a-z0-9_-]*$/.test(v)) msg = '只能包含小写字母、数字、- 和 _';
      else if (v.length > 32) msg = '最长 32 位';
    }
    handleErr.hidden = !msg;
    handleErr.textContent = msg;
    handleInput.classList.toggle('invalid', Boolean(msg));
  };
  handleInput.oninput = checkHandle;
  checkHandle();

  $('#member-editor').hidden = false;
  setTimeout(() => form.elements.display.focus(), 60);
}

function closeEditor() {
  $('#member-editor').hidden = true;
  state.editing = null;
}

/**
 * 彻底删除（不可恢复）。
 *
 * 和「移出并归档」的区别要讲清楚，否则用户会把两者搞混：
 * 归档保留记录、可恢复；彻底删除会把成员从配置里抹掉，并吊销它的渠道令牌。
 */
async function confirmPurge(m) {
  const ok = window.confirm(
    `彻底删除成员「${m.display}」？\n\n` +
      `· 从成员列表里移除，不可恢复\n` +
      `· 吊销它的全部渠道令牌（接入的客户端会立刻 401）\n` +
      `· 历史消息保留，但以后不再解析这个名字\n\n` +
      `只想暂时停用的话，用「移出并归档」——那个可以恢复。`,
  );
  if (!ok) return;
  try {
    const res = await api.purgeMember(m.handle, state.etag);
    toast(
      res?.revokedChannels
        ? `已彻底删除，吊销了 ${res.revokedChannels} 把渠道令牌`
        : '已彻底删除',
    );
    if (state.editing === m.handle) closeEditor();
    await reload();
    onChanged();
    refreshArchivedMembers();
  } catch (error) {
    toast(error.message);
  }
}

function renderChatChecks(selected) {
  const box = $('#chat-checks');
  box.textContent = '';
  // 单聊不进「成员归属」的可选项：私聊是按成员自动建的，不该在群列表里勾
  const groups = state.chats.filter((c) => c.kind !== 'dm');
  if (!groups.length) {
    box.innerHTML = '<p class="empty-note">还没有会话</p>';
    return;
  }
  // 新建时默认勾上大厅：一个群都不属于的成员收不到任何消息，
  // 而且从界面上完全看不出来——这是最容易被忽略的坑。
  const isNew = !state.editing;
  for (const c of groups) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.checked = selected.includes(c.id) || (isNew && c.id === 'main');
    label.append(cb, document.createTextNode(c.name));
    box.append(label);
  }
}

function renderAvatarGrid() {
  const grid = $('#avatar-grid');
  grid.textContent = '';

  const make = (id, url) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `avatar-opt${state.drafts.avatar === id ? ' is-active' : ''}`;
    btn.title = id;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    btn.append(img);
    btn.addEventListener('click', () => {
      state.drafts.avatar = id;
      renderAvatarGrid();
      updateAvatarPreview();
    });
    return btn;
  };

  const display = $('#editor-form').elements.display.value || '新';
  const handle = $('#editor-form').elements.handle.value || 'new';
  grid.append(make('initial', initialAvatar(display, handle, state.drafts.avatarSalt)));
  for (const p of state.presets) grid.append(make(p.id, p.url));
}

function updateAvatarPreview() {
  const form = $('#editor-form');
  const display = form.elements.display.value || '新';
  const handle = form.elements.handle.value || 'new';
  const url =
    state.drafts.avatar === 'initial'
      ? initialAvatar(display, handle, state.drafts.avatarSalt)
      : avatarUrl({ avatar: state.drafts.avatar, display, handle, avatarSalt: state.drafts.avatarSalt }, api.base);
  $('#avatar-preview').innerHTML = `<img src="${url}" alt="">`;
}

/** 「换一组配色」：只对首字头像有意义，重掷哈希盐。 */
function rollAvatar() {
  state.drafts.avatarSalt = Math.floor(Math.random() * 1e6);
  state.drafts.avatar = 'initial';
  renderAvatarGrid();
  updateAvatarPreview();
}

function syncDriverFields() {
  const type = $$('input[name="driverType"]').find((r) => r.checked)?.value || 'pull';
  $('#cli-fields').hidden = type !== 'cli';
  $('#webhook-fields').hidden = type !== 'webhook';
  $('#llm-fields').hidden = type !== 'llm';
  // llm 型点一下是真的打一次模型接口，比「通道检查」有用得多，所以按钮文案跟着换
  const probe = $('#btn-probe');
  if (probe) probe.textContent = type === 'llm' ? '测一下模型' : '测试连接';
}

// ── 大模型直连 ───────────────────────────────────────────────────────

/** 服务商列表只取一次：它基本不变，没必要每次开编辑器都请求。 */
async function ensureProviders() {
  if (state.providers) return state.providers;
  try {
    const r = await api.llmProviders();
    state.providers = r.providers || {};
  } catch {
    state.providers = { custom: { label: '自定义 / 自建网关', baseUrl: '', model: '' } };
  }
  return state.providers;
}

function fillProviderOptions(selected) {
  const sel = $('#llm-provider');
  if (!sel) return;
  const list = state.providers || {};
  sel.innerHTML = Object.entries(list)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`)
    .join('');
  sel.value = list[selected] ? selected : 'custom';
}

/** 换服务商把地址与模型名一起带过去——用户不该为了填地址去翻文档。 */
function onProviderChange() {
  const p = (state.providers || {})[$('#llm-provider')?.value];
  if (!p) return;
  const form = $('#editor-form');
  if (p.baseUrl) form.elements.baseUrl.value = p.baseUrl;
  if (p.model) {
    form.elements.model.value = p.model;
    form.elements.model.placeholder = p.model;
  }
}

async function save(e) {
  e.preventDefault();
  const form = $('#editor-form');
  const err = $('#editor-error');
  err.hidden = true;

  const display = form.elements.display.value.trim();
  if (!display) return fail('备注名不能为空');

  const handle = form.elements.handle.value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(handle)) {
    return fail('特征名需小写字母开头，只含小写字母、数字、- 和 _，最长 32 位');
  }

  const type = $$('input[name="driverType"]').find((r) => r.checked)?.value || 'pull';
  const driver = { type };
  if (type === 'cli') {
    if (!form.elements.cmd.value.trim()) return fail('cli 驱动需要填命令');
    driver.cmd = form.elements.cmd.value.trim();
    // 参数按空格切分，带空格的参数用引号包起来
    driver.args = splitArgs(form.elements.args.value);
    driver.cwd = form.elements.cwd.value.trim();
  }
  if (type === 'webhook') {
    if (!/^https?:\/\//.test(form.elements.url.value.trim())) return fail('回调地址需以 http(s):// 开头');
    driver.url = form.elements.url.value.trim();
  }
  if (type === 'llm') {
    driver.provider = form.elements.provider.value || 'custom';
    driver.baseUrl = form.elements.baseUrl.value.trim();
    driver.model = form.elements.model.value.trim();
    // 留空 = 不修改（编辑时不该被逼着重敲一遍密钥）
    driver.apiKey = form.elements.apiKey.value.trim();
    const t = Number(form.elements.temperature.value);
    if (form.elements.temperature.value !== '' && Number.isFinite(t)) driver.temperature = t;
    const mt = Number(form.elements.maxTokens.value);
    if (form.elements.maxTokens.value !== '' && Number.isFinite(mt)) driver.maxTokens = mt;
    if (!/^https?:\/\//.test(driver.baseUrl)) return fail('请填写模型接口地址（http/https 开头）');
    if (!driver.model) return fail('请填写模型名，例如 deepseek-chat');
  }

  const chats = $$('#chat-checks input:checked').map((cb) => cb.value);
  // 不属于任何群的成员收不到任何消息，而且界面看不出原因——直接拦在保存这一步
  if (!chats.length) return fail('至少要加入一个群：不属于任何群的成员收不到任何消息');

  const payload = {
    handle,
    display,
    avatar: state.drafts.avatar,
    avatarSalt: state.drafts.avatarSalt,
    driver,
    chats,
  };

  const btn = $('#btn-save-member');
  btn.disabled = true;
  try {
    let saved;
    let freshKey = '';
    if (state.editing) {
      saved = await api.updateMember(handle, payload, state.etag);
    } else {
      saved = await api.createMember(payload);
      freshKey = saved.key || '';
    }

    // 记忆摘要单独写，避免和配置写入互相覆盖。
    // 这里必须无条件写：留空代表「清空记忆」，写成 if (digest) 会导致记忆永远删不掉。
    await api.saveMemory(handle, form.elements.digest.value.trim());

    await reload();
    onChanged();

    if (state.editing) {
      toast('已保存');
      closeEditor();
    } else {
      // 新建成功不在这里收尾：密钥和「接下来怎么接」都在接入向导里，
      // 用 confirm 弹一次密钥、点取消就永久丢失，是之前最大的一个坑。
      closeEditor();
      openConnect(handle, freshKey);
    }
  } catch (ex) {
    fail(ex instanceof ApiError ? ex.message : '保存失败');
  } finally {
    btn.disabled = false;
  }


  function fail(msg) {
    err.textContent = msg;
    err.hidden = false;
    return undefined;
  }
}

/** 简易参数切分：支持单双引号包住带空格的参数。 */
function splitArgs(raw) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(raw || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

async function archive() {
  const handle = state.editing;
  if (!handle) return;
  if (!confirm(`确定把 @${handle} 移出并归档？历史消息会保留，成员可以之后恢复。`)) return;
  try {
    await api.archiveMember(handle, state.etag);
    toast('已归档');
    await reload();
    onChanged();
    closeEditor();
    refreshArchivedMembers();
  } catch (ex) {
    toast(ex.message);
  }
}
