#!/usr/bin/env node
/**
 * pull 驱动适配器：把 CodeBuddy / WorkBuddy 的 serve 网关接进围炉。
 *
 * 背景：独立 CLI 的 -p 模式存在静态加密缺陷（写读密钥不一致导致会话被清），
 * 但 `codebuddy --serve` 网关的登录态在进程内存里自续自洽，且提供完整 REST：
 *   POST /api/v1/runs            发消息给引擎（需要 id/type/text/sender）
 *   GET  /api/v1/runs/:id/stream SSE 拿结果（status=completed 时 content.markdown 即回复）
 *
 * 本进程是 pull 型成员（和 examples/beacon-agent.js 同款协议）：
 *   长轮询围炉收信 → 取围炉拼好的完整提示词（人设+记忆+上下文）→ 发给网关 →
 *   等 SSE 完成 → 回执进群。围炉管记忆，网关只当无状态的脑。
 *
 * 运行前：
 *   1. 引擎登录一次（TUI /login 或网关 POST /api/v1/auth/account/login 拿链接）；
 *   2. 启动网关：node <WorkBuddy>/resources/app.asar.unpacked/cli/bin/codebuddy --serve --port 54600
 *      （口令见启动输出，也会持久化到 ~/.codebuddy/settings.json 的 gateway.password）
 *
 * 环境变量：
 *   CAMPFIRE_URL      围炉地址（默认 http://192.168.31.252:8099）
 *   CAMPFIRE_MEMBER   成员 handle
 *   CAMPFIRE_KEY      成员密钥（必填）
 *   GATEWAY_URL       网关地址（默认 http://127.0.0.1:54600）
 *   GATEWAY_PASSWORD  网关口令（必填）
 *   RUN_TIMEOUT_MS    单次执行上限（默认 300000）
 */

const CAMPFIRE_URL = (process.env.CAMPFIRE_URL || 'http://192.168.31.252:8099').replace(/\/$/, '');
const MEMBER = process.env.CAMPFIRE_MEMBER || '';
const KEY = process.env.CAMPFIRE_KEY || '';
const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://127.0.0.1:54600').replace(/\/$/, '');
const GATEWAY_PASSWORD = process.env.GATEWAY_PASSWORD || '';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 300_000);

if (!MEMBER || !KEY) {
  console.error('缺少 CAMPFIRE_MEMBER / CAMPFIRE_KEY 环境变量');
  process.exit(1);
}
if (!GATEWAY_PASSWORD) {
  console.error('缺少 GATEWAY_PASSWORD 环境变量（网关启动时打印的 Password）');
  process.exit(1);
}

const H = { 'X-Campfire-Member': MEMBER, 'X-Campfire-Key': KEY };
const GH = {
  'x-codebuddy-request': '1',
  Authorization: `Bearer ${GATEWAY_PASSWORD}`,
};

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

async function campfire(method, path, body, timeoutMs = 40_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CAMPFIRE_URL}${path}`, {
      method,
      headers: body ? { ...H, 'Content-Type': 'application/json' } : H,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

async function reportState(state) {
  try {
    await campfire('POST', '/api/agent/state', { state, running: 1, limit: 2 }, 8000);
  } catch {}
}

/**
 * 发一个 run 给网关并等 SSE 完成，返回回复 markdown。
 * 单个 run 一个新会话（网关 runs API 不带 session 续接），
 * 会话记忆由围炉的提示词（人设+记忆+最近上下文）承担。
 */
async function runGateway(promptText) {
  const msgId = `cf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${GATEWAY_URL}/api/v1/runs`, {
    method: 'POST',
    headers: { ...GH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: msgId,
      type: 'message',
      text: promptText,
      sender: { id: MEMBER, name: MEMBER },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.data?.runId) {
    throw new Error(`runs 受理失败：HTTP ${res.status} ${JSON.stringify(data?.error || data || {}).slice(0, 200)}`);
  }
  const runId = data.data.runId;

  // 读 SSE：等 message 事件里 status=completed 的 content.markdown
  const sse = await fetch(`${GATEWAY_URL}/api/v1/runs/${runId}/stream`, {
    headers: { ...GH, Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  if (!sse.ok || !sse.body) throw new Error(`stream 打不开：HTTP ${sse.status}`);

  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = '';
  let reply = null;
  const deadline = Date.now() + RUN_TIMEOUT_MS;

  for (;;) {
    if (Date.now() > deadline) throw new Error(`执行超时（>${Math.round(RUN_TIMEOUT_MS / 1000)}s）`);
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (eventName === 'message' && payload) {
          try {
            const ev = JSON.parse(payload);
            if (ev.status === 'completed' && ev.content?.markdown != null) reply = ev.content.markdown;
            if (ev.status === 'failed' || ev.status === 'error') {
              throw new Error(`网关执行失败：${JSON.stringify(ev.content || ev).slice(0, 200)}`);
            }
          } catch (e) {
            if (e.message.startsWith('网关执行失败')) throw e;
          }
        } else if (eventName === 'done') {
          if (reply == null) throw new Error('run 结束但没有回复');
          return reply;
        }
        eventName = '';
      }
    }
  }
  if (reply == null) throw new Error('流关闭但没有拿到回复');
  return reply;
}

let busy = false;
log(`围炉成员 ${MEMBER} 已挂到网关 ${GATEWAY_URL}（pull 长轮询）`);
await reportState('hot');

for (;;) {
  try {
    const data = await campfire('GET', '/api/agent/inbox?wait=25');
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length || busy) continue;
    busy = true;
    try {
      const last = items[items.length - 1];
      const trigger = `刚才有 ${items.length} 条新消息，最后一条来自 ${last.senderName}。请回应。`;
      const { prompt } = await campfire(
        'GET',
        `/api/agent/prompt?chat=${encodeURIComponent(last.chatId)}&trigger=${encodeURIComponent(trigger)}`,
        undefined,
        10_000,
      );
      if (!prompt) throw new Error('拿不到提示词');

      log(`执行 ${items.length} 条（${last.chatName}）…`);
      const text = await runGateway(prompt);
      log('回复：', String(text).slice(0, 80).replace(/\n/g, ' '));

      await campfire('POST', '/api/agent/reply', { requestId: last.requestId, text }, 15_000);
      const rest = items.slice(0, -1).map((i) => i.requestId);
      if (rest.length) await campfire('POST', '/api/agent/ack', { requestIds: rest }, 10_000);
    } finally {
      busy = false;
    }
  } catch (e) {
    log('处理失败，5s 后重试：', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
