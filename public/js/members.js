import { api, ApiError } from './api.js';
import { $, $$, esc, avatarUrl, initialAvatar, fmtRelative, toast, presenceLabel } from './ui.js';

/**
 * 成员管理视图。
 *
 * 与群聊主界面解耦：只依赖 api 与 ui，不读 app.js 的内部状态。
 * 需要刷新的地方通过 onChanged 回调通知外面。
 */

let onChanged = () => {};
let state = { members: [], etag: '', chats: [], presets: [], editing: null, drafts: {} };

/** 接入向导的会话状态。key 加下划线前缀表示「只在此处流转，不进持久层」。 */
let connect = { handle: '', key: '', name: '', timer: null, shown: false };

export function initMembers({ onChanged: cb } = {}) {
  onChanged = cb || (() => {});
  bind();
}

function bind() {
  $('#btn-members').addEventListener('click', open);
  $('#btn-close-members').addEventListener('click', close);
  $('#btn-add-member').addEventListener('click', () => openEditor(null));
  $('#btn-close-editor').addEventListener('click', closeEditor);
  $('#btn-cancel-edit').addEventListener('click', closeEditor);
  $('#btn-archive').addEventListener('click', archive);
  $('#btn-roll-avatar').addEventListener('click', rollAvatar);
  $('#editor-form').addEventListener('submit', save);

  $('#btn-close-connect').addEventListener('click', () => closeConnect());
  $('#btn-reveal-key').addEventListener('click', toggleKey);
  $('#btn-rotate-key').addEventListener('click', rotateKey);
  $('#btn-probe').addEventListener('click', probeMember);
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', () => copyBlock(btn)));

  $$('input[name="driverType"]').forEach((r) =>
    r.addEventListener('change', () => syncDriverFields()),
  );

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
    const main = document.createElement('div');
    main.className = 'member-card-main';
    main.innerHTML =
      `<div class="member-card-name">${esc(m.display)}` +
      `<span class="dot ${label.cls}"></span>` +
      `<span class="badge ${label.cls}">${label.text}</span></div>` +
      `<div class="member-card-handle">@${esc(m.handle)}</div>` +
      `<div class="member-card-persona">${esc(m.persona || '还没有人设')}</div>` +
      `<div class="member-card-foot">` +
      `<span>${esc(m.driverType)}</span>` +
      `<span>${m.chats.length} 个会话</span>` +
      `<span>记忆 ${m.memory?.chars ? `${m.memory.chars} 字` : '空'}</span>` +
      `</div>`;

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'member-card-hit';
    hit.append(av, main);
    hit.addEventListener('click', () => openEditor(m.handle));

    const wire = document.createElement('button');
    wire.type = 'button';
    wire.className = 'text-btn member-card-wire';
    wire.textContent = label.cls === 'ok' ? '接入信息' : '接入引导';
    wire.addEventListener('click', () => openConnect(m.handle));

    card.append(hit, wire);
    grid.append(card);
  }
}

// ── 测试连接 ─────────────────────────────────────────────────────────

/**
 * 桥侧自检：这个成员的通道到底通不通。
 * 只查服务端掌握的事实（sidecar 在不在、上次活跃时间、唤醒决策），
 * 不真的拉起进程——真跑一次命令是「深度测试」，交给 doctor。
 */
async function probeMember() {
  const handle = state.editing;
  if (!handle) return;
  const btn = $('#btn-probe');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    const r = await api.probeMember(handle);
    const seen = r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleTimeString() : '从未';
    const stateText = { hot: '长轮询挂起中', warm: '低频轮询', cold: '离线', wake: '唤醒中' }[r.state] || r.state;
    alert(
      `成员 ${handle}（${r.driverType}）\n\n` +
        `通道：${r.reachable ? '已连接' : '未连接'}\n` +
        `状态：${stateText}\n` +
        `可立即响应：${r.ready ? '是' : '否'}\n` +
        `最近活跃：${seen}\n` +
        `全局连接：长轮询 ${r.polls} 条\n\n` +
        `${r.hint}`,
    );
  } catch (ex) {
    toast(ex instanceof ApiError ? ex.message : '测试失败');
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}


// ── 接入向导 ─────────────────────────────────────────────────────────

/**
 * 建成员和「让它跑起来」是两件事，之前只有前者。这个弹层负责后者：
 * 给出可直接复制的配置与命令，并且实时盯着成员有没有连上来。
 */
async function openConnect(handle, key) {
  const member = state.members.find((m) => m.handle === handle);
  connect = { handle, key: key || '', name: member?.display || handle, timer: null, shown: false };

  $('#connect-name').textContent = connect.name;
  $('#member-connect').hidden = false;
  setConnectState('waiting', member?.presence?.reachable ? '正在确认状态…' : '等待 sidecar 连上来…');

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
  pollConnect();
}

function closeConnect() {
  if (connect.timer) clearTimeout(connect.timer);
  connect = { handle: '', key: '', name: '', timer: null, shown: false };
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

async function copyBlock(btn) {
  const target = document.getElementById(btn.dataset.copy);
  const text = target?.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = old), 1400);
  } catch {
    toast('浏览器不允许自动复制，请手动选中');
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
  form.elements.persona.value = detail?.persona || '';
  form.elements.digest.value = detail?.digest || '';

  const driver = detail?.driver || { type: 'pull' };
  const radio = $$('input[name="driverType"]').find((r) => r.value === driver.type);
  if (radio) radio.checked = true;
  form.elements.cmd.value = driver.cmd || '';
  form.elements.args.value = Array.isArray(driver.args) ? driver.args.join(' ') : '';
  form.elements.cwd.value = driver.cwd || '';
  form.elements.url.value = driver.url || '';

  state.drafts.avatar = detail?.avatar || 'preset:01';
  state.drafts.avatarSalt = detail?.avatarSalt || 0;

  renderChatChecks(detail?.chats || []);
  renderAvatarGrid();
  updateAvatarPreview();
  syncDriverFields();

  $('#member-editor').hidden = false;
  setTimeout(() => form.elements.display.focus(), 60);
}

function closeEditor() {
  $('#member-editor').hidden = true;
  state.editing = null;
}

function renderChatChecks(selected) {
  const box = $('#chat-checks');
  box.textContent = '';
  if (!state.chats.length) {
    box.innerHTML = '<p class="empty-note">还没有会话</p>';
    return;
  }
  for (const c of state.chats) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.checked = selected.includes(c.id);
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

  const chats = $$('#chat-checks input:checked').map((cb) => cb.value);

  const payload = {
    handle,
    display,
    avatar: state.drafts.avatar,
    avatarSalt: state.drafts.avatarSalt,
    persona: form.elements.persona.value.trim(),
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
  } catch (ex) {
    toast(ex.message);
  }
}
