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
    const card = document.createElement('button');
    card.className = 'member-card';
    card.type = 'button';

    const img = document.createElement('img');
    img.src = avatarUrl(m, api.base);
    img.alt = '';
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    av.append(img);
    card.append(av);

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
    card.append(main);
    card.addEventListener('click', () => openEditor(m.handle));
    grid.append(card);
  }
}

// ── 编辑 ────────────────────────────────────────────────────────────

async function openEditor(handle) {
  const form = $('#editor-form');
  form.reset();
  $('#editor-error').hidden = true;
  $('#editor-title').textContent = handle ? '编辑成员' : '新建成员';
  $('#btn-archive').hidden = !handle;
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
    if (state.editing) {
      saved = await api.updateMember(handle, payload, state.etag);
    } else {
      saved = await api.createMember(payload);
      if (saved.key) {
        // 密钥只在这里出现一次，给用户一个复制入口
        const copy = confirm(
          `成员已创建。\n\n密钥（只显示这一次，请立刻保存到 sidecar 配置里）：\n${saved.key}\n\n要复制到剪贴板吗？`,
        );
        if (copy) navigator.clipboard?.writeText(saved.key).then(() => toast('密钥已复制'));
      }
    }
    // 记忆摘要单独写，避免和配置写入互相覆盖
    const digest = form.elements.digest.value.trim();
    if (digest) {
      await fetch(`${api.base}/api/members/${handle}/memory`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest }),
      });
    }
    toast(state.editing ? '已保存' : `已加入 ${saved.member?.display || display}`);
    await reload();
    onChanged();
    closeEditor();
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
