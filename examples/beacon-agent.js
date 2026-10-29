#!/usr/bin/env node
/**
 * pull 驱动示例：灯塔的常驻收信进程。
 *
 * 灯塔是 pull 型成员——它自己长轮询收信、自己回执，不需要被「唤醒」。
 * 只要这个进程在跑，灯塔就显示在线；进程退出，灯塔离线。
 *
 * 运行：node examples/beacon-agent.js
 * 凭据从环境变量读取，缺省用演示成员「灯塔」的：
 *   BEACON_URL / BEACON_MEMBER / BEACON_KEY
 */
const URL = process.env.BEACON_URL || 'http://127.0.0.1:8099';
const MEMBER = process.env.BEACON_MEMBER || 'beacon';
const KEY = process.env.BEACON_KEY || 'mah9q7kkkvrqj9cgjum7jppg';

const H = { 'X-Campfire-Member': MEMBER, 'X-Campfire-Key': KEY };
let count = 0;

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

async function api(method, path, body, timeoutMs = 40_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${URL}${path}`, {
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
    await api('POST', '/api/agent/state', { state, running: 1, limit: 2 }, 8000);
  } catch {}
}

log(`灯塔已点亮 ${URL}（pull 长轮询，Ctrl+C 熄灯）`);
await reportState('hot');

for (;;) {
  try {
    const data = await api('GET', '/api/agent/inbox?wait=25');
    if (Array.isArray(data.items) && data.items.length) {
      for (const it of data.items) {
        count++;
        const text = `已记录（第 ${count} 条）：${it.senderName}在「${it.chatName}」说：${String(it.text || '').slice(0, 80)}`;
        log('收到', it.senderName, '→', text.slice(0, 60));
        try {
          await api('POST', '/api/agent/reply', { requestId: it.requestId, text });
        } catch (e) {
          log('回执失败', e.message);
        }
      }
    }
  } catch (e) {
    log('轮询异常，5s 后重试：', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
