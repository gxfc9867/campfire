/**
 * 桥的核心逻辑：拉 update → 定会话 → 投递/唤醒 → 收回复 → 发回围炉 → ack。
 *
 * 这里刻意不碰任何 DSH API：会话能力全部从注入的 `host` 拿
 * （`{ mintSessionId, openSession, createSession, ask, inject }`），
 * 所以单测可以用假 host + mock 围炉把整条链路跑完。
 */

import { normalizeOutboundText, renderInboundMessage } from './format.js';

const DEDUPE_LIMIT = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeWakeup(value) {
  return value === 'reply' || value === 'none' ? value : 'notify';
}

/**
 * @param {{
 *   client: ReturnType<typeof import('./campfire-client.js').createCampfireClient>,
 *   store: ReturnType<typeof import('./bindings.js').createStateStore>,
 *   host: object,
 *   config: Record<string, any>,
 *   log?: (level: string, message: string, extra?: unknown) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function createBridge({ client, store, host, config, log = () => {}, sleep = defaultSleep, now = Date.now }) {
  const processed = new Set();
  const stats = { updates: 0, replies: 0, injected: 0, skipped: 0, failures: 0, acks: 0 };
  let controller = null;
  let pollers = [];
  let started = false;
  let stopped = false;

  function remember(updateId) {
    processed.add(updateId);
    if (processed.size > DEDUPE_LIMIT) {
      const oldest = processed.values().next().value;
      processed.delete(oldest);
    }
  }

  /** 成员:会话 = 1:1 时所有群共用一个绑定键；per-chat 时一个群一个。 */
  function scopeKey(chatId) {
    return config.sessionScope === 'per-chat' ? String(chatId) : '*';
  }

  function allowedChat(chatId) {
    return Array.isArray(config.chatIds) && config.chatIds.includes(String(chatId));
  }

  function isSelf(message) {
    const sender = message?.sender;
    return sender?.kind === 'member' && String(sender.handle) === config.memberHandle;
  }

  /** 拿（或建）这个群对应的会话。绑定失效时重建并覆盖绑定，对应 §6.5 binding_invalid。 */
  async function ensureSession(chatId) {
    const key = scopeKey(chatId);
    const binding = store.getBinding(key);

    if (binding?.sessionId) {
      const opened = await host.openSession({ sessionId: binding.sessionId, chatId });
      if (opened?.agent) return { key, sessionId: binding.sessionId, agent: opened.agent, reused: true };

      const reason = opened?.error ?? 'failed';
      log(
        'warn',
        `围炉群 ${chatId} 绑定的会话打不开（${binding.sessionId}，原因 ${reason}）：${opened?.message ?? ''} —— 按 §6.5 重建`.trim(),
      );

      // 盘上没有记录 / 刚被注册：同 id 重建，绑定不漂移，历史还能续上
      if (reason === 'not_found' || reason === 'registered') {
        try {
          const agent = await host.createSession({ sessionId: binding.sessionId, chatId });
          return { key, sessionId: binding.sessionId, agent, reused: false, recreated: true };
        } catch (error) {
          log('warn', `同 id 重建会话 ${binding.sessionId} 失败：${error?.message ?? error}`);
        }
      }
    }

    const sessionId = host.mintSessionId(chatId);
    const agent = await host.createSession({ sessionId, chatId });
    await store.setBinding(key, { sessionId, chatId });
    log('info', `为围炉群 ${chatId} 新建会话 ${sessionId}（绑定键 ${key}）`);
    return { key, sessionId, agent, reused: false };
  }

  async function ackAndAdvance(chatId, seq) {
    await client.ack({ chat: chatId, cursor: seq, signal: controller?.signal });
    await store.setCursor(chatId, seq);
    stats.acks += 1;
  }

  /** 处理一条 update。抛错表示「没处理成」，由调用方决定是否推进游标。 */
  async function handleUpdate(update) {
    const type = update?.type ?? 'message.created';
    if (type !== 'message.created') {
      log('debug', `忽略 update 类型 ${type}`);
      return { handled: false, reason: 'type' };
    }
    const message = update.message;
    if (!message || typeof message !== 'object') return { handled: false, reason: 'empty' };

    const chatId = String(update.chatId ?? message.chatId ?? '');
    if (!allowedChat(chatId)) {
      log('debug', `群 ${chatId} 不在 chatIds 里，跳过`);
      return { handled: false, reason: 'chat_not_allowed' };
    }
    if (isSelf(message)) {
      log('debug', `跳过自己发的消息 ${message.id ?? ''}`);
      return { handled: false, reason: 'self' };
    }

    const wakeup = normalizeWakeup(update.wakeup);
    if (wakeup === 'none') {
      stats.skipped += 1;
      return { handled: false, reason: 'wakeup_none' };
    }

    const text = renderInboundMessage({
      message,
      chatId,
      chatTitle: update.chatTitle,
      markerTemplate: config.sourceMarker,
    });

    const target = await ensureSession(chatId);
    const patch = { lastWakeAt: wakeup === 'reply' ? now() : undefined };
    if (patch.lastWakeAt === undefined) delete patch.lastWakeAt;
    await store.touchBinding(target.key, patch);

    if (wakeup === 'reply') {
      const reply = await host.ask({
        agent: target.agent,
        sessionId: target.sessionId,
        text,
        timeoutMs: config.replyTimeoutMs,
        update,
      });
      const outbound = normalizeOutboundText(reply, { maxChars: config.maxReplyChars });
      if (!outbound) {
        log('warn', `会话 ${target.sessionId} 这一轮没有产出可发送的文本，只 ack 不回帖（群 ${chatId}）`);
        return { handled: true, replied: false };
      }
      await client.sendMessage({
        chatId,
        text: outbound,
        replyTo: message.id,
        clientMsgId: `campfire-reply:${message.id}`,
        signal: controller?.signal,
      });
      stats.replies += 1;
      log('info', `已回复围炉群 ${chatId} 的消息 ${message.id ?? ''}（会话 ${target.sessionId}）`);
      return { handled: true, replied: true, sessionId: target.sessionId };
    }

    await host.inject({ agent: target.agent, sessionId: target.sessionId, text, update });
    stats.injected += 1;
    log('debug', `已注入围炉群 ${chatId} 的 notify 消息（会话 ${target.sessionId}，不唤醒）`);
    return { handled: true, injected: true, sessionId: target.sessionId };
  }

  /** 拉一轮，返回本轮处理的条数。 */
  async function pollChat(chatId) {
    const cursor = store.getCursor(chatId);
    const response = await client.updates({
      chat: chatId,
      cursor,
      wait: config.wait,
      limit: config.limit,
      signal: controller?.signal,
    });
    const updates = Array.isArray(response?.updates) ? response.updates : [];
    let count = 0;

    for (const update of updates) {
      const updateId = String(update?.updateId ?? `${chatId}:${update?.seq ?? 0}`);
      stats.updates += 1;

      if (processed.has(updateId)) {
        log('debug', `重复投递 ${updateId}，直接 ack`);
        if (Number.isFinite(Number(update?.seq))) await ackAndAdvance(chatId, Number(update.seq));
        continue;
      }

      let failure = null;
      try {
        await handleUpdate(update);
      } catch (error) {
        failure = error;
        stats.failures += 1;
        log('error', `处理 ${updateId} 失败：${error?.message ?? error}`);
      }

      remember(updateId);
      // 群聊不因单个成员处理失败而阻塞（§6.2）：失败也推进游标，靠日志暴露问题。
      if (Number.isFinite(Number(update?.seq))) await ackAndAdvance(chatId, Number(update.seq));
      count += 1;
      if (failure) continue;
    }

    return count;
  }

  async function runPoller(chatId) {
    let backoff = 1_000;
    while (!stopped && !controller?.signal.aborted) {
      try {
        const count = await pollChat(chatId);
        backoff = 1_000;
        if (count === 0 && config.wait <= 0) await sleep(500);
      } catch (error) {
        if (stopped || controller?.signal.aborted) break;
        if (error?.code === 'cursor_expired') {
          log('warn', `群 ${chatId} 游标过期，按 §4.2 退回从头拉（摘要补齐属 M5，未实现）`);
          await store.setCursor(chatId, 0);
          continue;
        }
        log('warn', `群 ${chatId} 拉流失败，${backoff}ms 后重试：${error?.message ?? error}`);
        await sleep(backoff);
        backoff = Math.min(config.maxBackoffMs ?? 30_000, backoff * 2);
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    controller = new AbortController();
    pollers = config.chatIds.map((chatId) => runPoller(chatId));
    log('info', `围炉插件开始拉流：群 ${config.chatIds.join(', ') || '(空)'}，wait=${config.wait}s`);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    controller?.abort();
    client.close?.('bridge stop');
    await Promise.allSettled(pollers);
    await store.flush?.();
    log('info', `围炉插件已停止（累计 update ${stats.updates}，回复 ${stats.replies}，失败 ${stats.failures}）`);
  }

  return { start, stop, pollChat, handleUpdate, ensureSession, stats, scopeKey };
}
