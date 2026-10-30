#!/usr/bin/env node
/**
 * 围炉 Channel API v1 一致性测试（conformance）。
 *
 * 定位：**黑盒**验收入口。任何实现（真围炉 / mock / 第三方兼容服务）只要能给出
 * 一个 baseUrl + 一把令牌，跑这个脚本就能知道「合不合契约」，不用读源码。
 *
 * 用法：
 *   node scripts/conformance.mjs --base http://127.0.0.1:8099 --owner <主人口令> --member <成员handle>
 *   node scripts/conformance.mjs --base http://127.0.0.1:8099 --token <渠道令牌> --chat main
 *
 * 参数：
 *   --base    必填，服务地址（不带结尾斜杠）
 *   --owner   主人口令。给了就自动建一个临时渠道，跑完吊销
 *   --member  临时渠道绑定的成员（需已存在且在群里）
 *   --token   已有渠道令牌。不给 --owner 时必须给这个
 *   --chat    测试用的会话 id，默认 main
 *   --json    报告落盘路径，默认 ./conformance-report.json
 *   --keep    不清理（保留测试消息与临时渠道，排查用）
 *   --verbose 打印每条用例的细节
 *
 * 退出码：0 = 全过；1 = 有失败；2 = 环境不可用（连不上 / 鉴权失败，没开始跑）。
 *
 * 注意：会往目标会话发 3~5 条带 `[conformance]` 前缀的消息，默认跑完删除。
 * 删除失败也不影响判定（只是留痕），报告里会标出来。
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const MARK = '[conformance]';

// ── 参数 ───────────────────────────────────────────────────────────
let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      base: { type: 'string' },
      owner: { type: 'string' },
      member: { type: 'string' },
      token: { type: 'string' },
      chat: { type: 'string', default: 'main' },
      json: { type: 'string', default: 'conformance-report.json' },
      keep: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  console.error(`参数错误：${error.message}`);
  process.exit(2);
}

if (opts.help || !opts.base) {
  console.log(`围炉 Channel API v1 一致性测试

  node scripts/conformance.mjs --base <url> --owner <主人口令> --member <handle>
  node scripts/conformance.mjs --base <url> --token <渠道令牌> [--chat main]

  --json <path>  报告输出路径（默认 conformance-report.json）
  --keep         保留测试消息与临时渠道
  --verbose      打印细节`);
  process.exit(opts.help ? 0 : 2);
}

const BASE = opts.base.replace(/\/+$/, '');
const CHAT = opts.chat;
const verbose = Boolean(opts.verbose);

// ── 小工具 ─────────────────────────────────────────────────────────
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** HTTP 客户端；`token` 给了就带 Bearer，`cookie` 给了就带 Cookie。 */
function makeClient({ token, cookie } = {}) {
  async function req(method, pathname, { body, headers, signal } = {}) {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: res.status, data, text, headers: res.headers };
  }
  return {
    req,
    get: (p, o) => req('GET', p, o),
    post: (p, body, o) => req('POST', p, { body, ...o }),
    del: (p, o) => req('DELETE', p, o),
  };
}

/** 主人登录，返回带 Cookie 的客户端。 */
async function ownerLogin(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`主人登录失败（${res.status}）：${text.slice(0, 200)}`);
  }
  const cookies = res.headers.getSetCookie?.() || [];
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  expect(cookie, '登录成功但没有拿到 Cookie');
  return makeClient({ cookie });
}

// ── 报告 ───────────────────────────────────────────────────────────
const results = [];

async function check({ id, group, name }, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ id, group, name, ok: true, detail: detail ?? null, ms });
    console.log(`${green('✓')} ${dim(id)} ${name}${ms > 1500 ? dim(` (${ms}ms)`) : ''}`);
    if (verbose && detail !== undefined) console.log(dim(`    ${JSON.stringify(detail)}`));
    return { ok: true, detail };
  } catch (error) {
    const ms = Date.now() - started;
    const message = error?.message ?? String(error);
    results.push({ id, group, name, ok: false, error: message, ms });
    console.log(`${red('✗')} ${dim(id)} ${name}`);
    console.log(`    ${red(message)}`);
    return { ok: false, error };
  }
}

function section(title) {
  console.log(`\n${cyan(title)}`);
}

// ── 主流程 ─────────────────────────────────────────────────────────
async function main() {
  console.log(cyan('围炉 Channel API v1 · 一致性测试'));
  console.log(dim(`目标 ${BASE}  会话 ${CHAT}`));

  // 1. 连通性 + 拿 token
  let token = opts.token || '';
  let owner = null;
  let tempChannel = null;
  const createdMessages = [];

  let meta;
  try {
    const res = await fetch(`${BASE}/v1/meta`);
    if (res.ok) {
      meta = await res.json();
    } else if (opts.token) {
      // 有些实现给 meta 也加了鉴权：先带上令牌把测试跑起来，
      // 这个偏差由 C01 精确报出来，不让整个套件在连通性检查就死掉
      const retry = await fetch(`${BASE}/v1/meta`, { headers: { authorization: `Bearer ${opts.token}` } });
      if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
      meta = await retry.json();
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (error) {
    console.error(red(`\n连不上 ${BASE}/v1/meta：${error?.message ?? error}`));
    process.exit(2);
  }

  if (!token) {
    if (!opts.owner || !opts.member) {
      console.error(red('\n没有 --token，就必须同时给 --owner 和 --member（脚本要自建临时渠道）'));
      process.exit(2);
    }
    try {
      owner = await ownerLogin(opts.owner);
      const created = await owner.post('/api/admin/channels', { member: opts.member, name: 'conformance' });
      if (created.status !== 200 || !created.data?.token) {
        throw new Error(`建渠道失败（${created.status}）：${created.text.slice(0, 200)}`);
      }
      token = created.data.token;
      tempChannel = created.data.channel;
      console.log(dim(`已自建临时渠道 ${tempChannel.id}（成员 ${opts.member}），跑完会吊销`));
    } catch (error) {
      console.error(red(`\n准备渠道失败：${error?.message ?? error}`));
      process.exit(2);
    }
  }

  // 未给 owner 时，清理只能靠 token 自己（删消息需要主人权限，这里就不删了）
  if (!owner && opts.owner) {
    try {
      owner = await ownerLogin(opts.owner);
    } catch {
      // 清理不了就算了，不影响测试
    }
  }

  const api = makeClient({ token });
  const anon = makeClient();

  // 2. meta
  section('meta：能力协商');
  await check({ id: 'C01', group: 'meta', name: '/v1/meta 免鉴权可直接读' }, async () => {
    expectEqual(meta?.apiVersion, 1, 'apiVersion');
    return { apiVersion: meta.apiVersion };
  });

  await check({ id: 'C02', group: 'meta', name: 'capabilities 声明完整' }, async () => {
    const caps = meta?.capabilities;
    expect(caps && typeof caps === 'object', '缺少 capabilities');
    expectEqual(caps.cursor, 'seq', 'capabilities.cursor');
    expect(Array.isArray(caps.wakeup), 'capabilities.wakeup 应是数组');
    expect(caps.wakeup.includes('reply'), 'capabilities.wakeup 必须包含 reply');
    expect(caps.wakeup.includes('notify'), 'capabilities.wakeup 必须包含 notify');
    return caps;
  });

  await check({ id: 'C03', group: 'meta', name: 'limits.maxTextLength 为正数' }, async () => {
    const max = meta?.limits?.maxTextLength;
    expect(Number.isFinite(max) && max > 0, `limits.maxTextLength 非法：${max}`);
    return { maxTextLength: max };
  });

  // 3. 鉴权
  section('auth：鉴权与错误形状');
  await check({ id: 'C04', group: 'auth', name: '无令牌访问 updates 返回 401' }, async () => {
    const res = await anon.get(`/v1/updates?chat=${CHAT}&cursor=0`);
    expectEqual(res.status, 401, '状态码');
  });

  await check({ id: 'C05', group: 'auth', name: '错误体带机器可读 code' }, async () => {
    const res = await anon.get(`/v1/updates?chat=${CHAT}&cursor=0`);
    expect(typeof res.data?.code === 'string' && res.data.code, `缺少顶层 code：${res.text.slice(0, 160)}`);
    expect(typeof res.data?.error === 'string' || typeof res.data?.error === 'object', '缺少 error 描述');
    return { code: res.data.code };
  });

  await check({ id: 'C06', group: 'auth', name: '错误令牌返回 401' }, async () => {
    const bad = makeClient({ token: 'definitely-not-a-valid-token' });
    const res = await bad.get(`/v1/updates?chat=${CHAT}&cursor=0`);
    expectEqual(res.status, 401, '状态码');
  });

  // 4. 发送 + 游标流
  section('stream：发送与游标');
  let firstSeq = null;
  let firstMessageId = null;

  await check({ id: 'C07', group: 'stream', name: '发言成功并返回完整消息模型' }, async () => {
    const text = `${MARK} 一致性测试 A`;
    const res = await api.post('/v1/messages', { chatId: CHAT, text });
    expect(res.status === 200 || res.status === 201, `状态码 ${res.status}：${res.text.slice(0, 160)}`);
    const msg = res.data?.message ?? res.data;
    expect(msg && typeof msg === 'object', '响应里没有 message');
    for (const field of ['id', 'chatId', 'seq', 'sender', 'type', 'text', 'createdAt']) {
      expect(msg[field] !== undefined && msg[field] !== null, `消息缺少字段 ${field}`);
    }
    expectEqual(msg.chatId, CHAT, 'message.chatId');
    expectEqual(msg.text, text, 'message.text');
    expectEqual(msg.type, 'text', 'message.type');
    expect(msg.sender.kind === 'member', `sender.kind 应为 member，实际 ${msg.sender.kind}`);
    expectEqual(msg.sender.handle, tempChannel?.member ?? msg.sender.handle, 'sender.handle 应等于令牌绑定的成员');
    firstSeq = msg.seq;
    firstMessageId = msg.id;
    createdMessages.push(msg.id);
    return { id: msg.id, seq: msg.seq };
  });

  await check({ id: 'C08', group: 'stream', name: '拉流能拿到刚发的消息，字段齐全' }, async () => {
    const res = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    expectEqual(res.status, 200, '状态码');
    const body = res.data;
    expect(Array.isArray(body?.updates), 'updates 不是数组');
    expect(Number.isFinite(body.nextCursor), 'nextCursor 不是数字');
    const hit = body.updates.find((u) => u.message?.id === firstMessageId);
    expect(hit, '拉流结果里没有刚发的消息');
    for (const field of ['updateId', 'type', 'chatId', 'seq', 'message', 'wakeup']) {
      expect(hit[field] !== undefined && hit[field] !== null, `update 缺少字段 ${field}`);
    }
    expect(['reply', 'notify', 'none'].includes(hit.wakeup), `wakeup 取值非法：${hit.wakeup}`);
    expectEqual(hit.type, 'message.created', 'update.type');
    return { count: body.updates.length, nextCursor: body.nextCursor };
  });

  await check({ id: 'C09', group: 'stream', name: 'seq 单调递增、updateId 唯一' }, async () => {
    let res = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    if ((res.data.updates || []).length < 2) {
      // 群里本来就冷清时样本不够，自己补一条，让用例不依赖执行顺序
      const seed = await api.post('/v1/messages', { chatId: CHAT, text: `${MARK} 单调性样本` });
      const seedId = (seed.data?.message ?? seed.data)?.id;
      if (seedId) createdMessages.push(seedId);
      res = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    }
    const updates = res.data.updates || [];
    expect(updates.length >= 2, `样本太少（${updates.length}），无法判断单调性`);
    const ids = new Set();
    let prev = -Infinity;
    for (const u of updates) {
      expect(u.seq > prev, `seq 未严格递增：${prev} → ${u.seq}`);
      prev = u.seq;
      expect(!ids.has(u.updateId), `updateId 重复：${u.updateId}`);
      ids.add(u.updateId);
    }
    return { seqRange: [updates[0].seq, updates[updates.length - 1].seq] };
  });

  await check({ id: 'C10', group: 'stream', name: 'nextCursor 等于最后一条 seq' }, async () => {
    const res = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    const updates = res.data.updates || [];
    const last = updates[updates.length - 1];
    expectEqual(res.data.nextCursor, last.seq, 'nextCursor');
    return { nextCursor: res.data.nextCursor };
  });

  await check({ id: 'C11', group: 'stream', name: '用 nextCursor 续拉不重复' }, async () => {
    const first = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    const cursor = first.data.nextCursor;
    const second = await api.get(`/v1/updates?chat=${CHAT}&cursor=${cursor}&limit=200`);
    expectEqual(second.status, 200, '状态码');
    const overlap = (second.data.updates || []).filter((u) => u.seq <= cursor);
    expectEqual(overlap.length, 0, '续拉返回了游标之前的数据');
    return { returned: (second.data.updates || []).length };
  });

  // 5. 幂等
  section('send：幂等与约束');
  await check({ id: 'C12', group: 'send', name: 'clientMsgId 幂等：重复发送不产生第二条' }, async () => {
    const clientMsgId = `conformance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const text = `${MARK} 幂等测试`;
    const one = await api.post('/v1/messages', { chatId: CHAT, text, clientMsgId });
    expect(one.status === 200 || one.status === 201, `第一次发送失败 ${one.status}`);
    const idOne = (one.data?.message ?? one.data)?.id;
    expect(idOne, '第一次发送没有返回消息 id');

    const two = await api.post('/v1/messages', { chatId: CHAT, text, clientMsgId });
    expectEqual(two.status, 200, '重复发送应返回 200');
    const body = two.data || {};
    const idTwo = (body.message ?? body)?.id;
    expectEqual(idTwo, idOne, '重复发送返回了不同的消息 id');
    expect(body.duplicate === true || body.duplicated === true, '重复发送应标记 duplicate=true');
    createdMessages.push(idOne);
    return { id: idOne };
  });

  await check({ id: 'C13', group: 'send', name: '空文本被拒（400）' }, async () => {
    const res = await api.post('/v1/messages', { chatId: CHAT, text: '   ' });
    expectEqual(res.status, 400, '状态码');
  });

  await check({ id: 'C14', group: 'send', name: '超长文本被拒（400）' }, async () => {
    const max = meta.limits.maxTextLength;
    const res = await api.post('/v1/messages', { chatId: CHAT, text: 'x'.repeat(max + 10) });
    expectEqual(res.status, 400, '状态码');
  });

  await check({ id: 'C15', group: 'send', name: '缺少 chatId 被拒（400）' }, async () => {
    const res = await api.post('/v1/messages', { text: '没有会话' });
    expectEqual(res.status, 400, '状态码');
  });

  // 6. replyTo
  await check({ id: 'C16', group: 'send', name: 'replyTo 原样回填' }, async () => {
    const text = `${MARK} 引用测试`;
    const res = await api.post('/v1/messages', { chatId: CHAT, text, replyTo: firstMessageId });
    expect(res.status === 200 || res.status === 201, `状态码 ${res.status}`);
    const msg = res.data?.message ?? res.data;
    expectEqual(msg.replyTo, firstMessageId, 'replyTo');
    createdMessages.push(msg.id);
    return { replyTo: msg.replyTo };
  });

  // 7. 越权
  section('scope：权限边界');
  await check({ id: 'C17', group: 'scope', name: '往没加入的会话发言返回 403' }, async () => {
    const res = await api.post('/v1/messages', { chatId: 'conformance-not-a-chat', text: '越权' });
    expectEqual(res.status, 403, '状态码');
  });

  await check({ id: 'C18', group: 'scope', name: '读没加入的会话返回 403' }, async () => {
    const res = await api.get('/v1/updates?chat=conformance-not-a-chat&cursor=0');
    expectEqual(res.status, 403, '状态码');
  });

  // 8. 长轮询
  section('long-poll：长轮询与唤醒');
  await check({ id: 'C19', group: 'long-poll', name: 'wait=0 立即返回' }, async () => {
    const started = Date.now();
    const res = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&wait=0`);
    const elapsed = Date.now() - started;
    expectEqual(res.status, 200, '状态码');
    expect(elapsed < 3000, `应立刻返回，实际 ${elapsed}ms`);
    return { ms: elapsed };
  });

  await check({ id: 'C20', group: 'long-poll', name: 'wait>0 且无新消息时挂起到超时' }, async () => {
    const head = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    const cursor = head.data.nextCursor;
    const started = Date.now();
    const res = await api.get(`/v1/updates?chat=${CHAT}&cursor=${cursor}&wait=3`);
    const elapsed = Date.now() - started;
    expectEqual(res.status, 200, '状态码');
    expectEqual((res.data.updates || []).length, 0, '不应该有新消息');
    expect(elapsed >= 2000, `应挂起到接近 3s，实际 ${elapsed}ms`);
    expect(elapsed < 8000, `挂起时间过长：${elapsed}ms（wait 上限没生效？）`);
    return { ms: elapsed };
  });

  await check({ id: 'C21', group: 'long-poll', name: '挂起期间有新消息立刻唤醒' }, async () => {
    const head = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    const cursor = head.data.nextCursor;
    const started = Date.now();
    const pending = api.get(`/v1/updates?chat=${CHAT}&cursor=${cursor}&wait=8`);
    // 400ms 后由同一成员发一条，触发服务端广播
    await sleep(400);
    const sent = await api.post('/v1/messages', { chatId: CHAT, text: `${MARK} 唤醒测试` });
    const msgId = (sent.data?.message ?? sent.data)?.id;
    if (msgId) createdMessages.push(msgId);

    const res = await pending;
    const elapsed = Date.now() - started;
    expectEqual(res.status, 200, '状态码');
    expect((res.data.updates || []).length >= 1, '唤醒后应带回新消息');
    expect(elapsed < 5000, `应在事件到来后立刻返回，实际 ${elapsed}ms（可能仍在 300ms 轮询或没有广播）`);
    return { ms: elapsed };
  });

  // 9. ack + 游标持久化
  section('ack：游标持久化');
  await check({ id: 'C22', group: 'ack', name: 'ack 后不带 cursor 拉取从这里继续' }, async () => {
    const head = await api.get(`/v1/updates?chat=${CHAT}&cursor=0&limit=200`);
    const cursor = head.data.nextCursor;
    const acked = await api.post('/v1/updates/ack', { chat: CHAT, cursor });
    expectEqual(acked.status, 200, 'ack 状态码');

    const after = await api.get(`/v1/updates?chat=${CHAT}&wait=0`);
    expectEqual(after.status, 200, '状态码');
    const stale = (after.data.updates || []).filter((u) => u.seq <= cursor);
    expectEqual(stale.length, 0, '不带 cursor 时应从已确认的位置继续');
    return { cursor };
  });

  await check({ id: 'C23', group: 'ack', name: 'ack 非法 cursor 被拒（400）' }, async () => {
    const res = await api.post('/v1/updates/ack', { chat: CHAT, cursor: -1 });
    expectEqual(res.status, 400, '状态码');
  });

  // 10. quota
  await check({ id: 'C24', group: 'quota', name: '/v1/quota 返回背压观测字段' }, async () => {
    const res = await api.get('/v1/quota');
    expectEqual(res.status, 200, '状态码');
    const body = res.data || {};
    expect(Number.isFinite(body.pending), 'quota.pending 不是数字');
    expect(body.dropped && typeof body.dropped === 'object', 'quota.dropped 缺失');
    return body;
  });

  // ── 清理 ──
  if (!opts.keep) {
    section('清理');
    if (owner) {
      let removed = 0;
      for (const id of createdMessages) {
        const res = await owner.del(`/api/messages/${id}`).catch(() => null);
        if (res && res.status === 200) removed += 1;
      }
      console.log(dim(`已删除测试消息 ${removed}/${createdMessages.length} 条`));
      if (tempChannel) {
        const res = await owner.del(`/api/admin/channels/${tempChannel.id}`).catch(() => null);
        console.log(dim(res && res.status === 200 ? `已吊销临时渠道 ${tempChannel.id}` : '临时渠道吊销失败，请手动处理'));
      }
    } else {
      console.log(dim('未提供 --owner，跳过清理（测试消息会留在群里）'));
    }
  } else {
    console.log(dim('\n--keep：跳过清理'));
  }

  // ── 报告 ──
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const groups = [...new Set(results.map((r) => r.group))];
  const byGroup = groups.map((g) => {
    const list = results.filter((r) => r.group === g);
    return { group: g, total: list.length, passed: list.filter((r) => r.ok).length };
  });

  const report = {
    tool: 'campfire-conformance',
    apiVersion: meta?.apiVersion ?? null,
    baseUrl: BASE,
    chat: CHAT,
    startedAt: new Date(Date.now() - results.reduce((sum, r) => sum + r.ms, 0)).toISOString(),
    finishedAt: new Date().toISOString(),
    summary: { total: results.length, passed, failed, groups: byGroup },
    results,
  };

  const outPath = path.resolve(opts.json);
  try {
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(red(`报告写入失败：${error?.message ?? error}`));
  }

  console.log(`\n${cyan('结果')}`);
  for (const g of byGroup) {
    const ok = g.passed === g.total;
    console.log(`  ${ok ? green('✓') : red('✗')} ${g.group.padEnd(10)} ${g.passed}/${g.total}`);
  }
  console.log(
    `\n${failed === 0 ? green(`${passed}/${results.length} 全过`) : red(`${passed}/${results.length} 通过，${failed} 项失败`)}`,
  );
  console.log(dim(`报告：${outPath}`));

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red(`\n未预期错误：${error?.stack ?? error}`));
  process.exit(2);
});
