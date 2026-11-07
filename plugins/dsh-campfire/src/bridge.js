/**
 * 桥的核心逻辑：拉 update → 定会话 → 投递/唤醒 → 收回复 → 发回围炉 → ack。
 *
 * 这里刻意不碰任何 DSH API：会话能力全部从注入的 `host` 拿
 * （`{ mintSessionId, openSession, createSession, ask, inject }`），
 * 所以单测可以用假 host + mock 围炉把整条链路跑完。
 */

import { normalizeOutboundText, renderInboundMessage } from './format.js';

// 去重表已移到 state 存储（跨重启有效），上限见 bindings.js 的 PROCESSED_LIMIT

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
  const stats = { updates: 0, replies: 0, injected: 0, skipped: 0, failures: 0, acks: 0 };
  let controller = null;
  let pollers = [];
  let started = false;
  let stopped = false;

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
        `围炉群 ${chatId} 绑定的会话打不开（${binding.sessionId}，原因 ${reason}）：${opened?.message ?? ''}`.trim(),
      );

      /**
       * 会话没了（多半是用户在 DSH 里主动删的）。
       *
       * 以前这里是「同 id 重建」——等于把用户的删除动作悄悄撤销，用户完全不知道
       * 发生过什么，只觉得「删了也没反应」。现在改成：不再同 id 重建，落回下面的
       * 「新建一个」分支，并回写一条说明，让删除这件事在群里可见。
       */
      if (reason === 'not_found' || reason === 'registered') {
        log('warn', `围炉群 ${chatId} 的会话 ${binding.sessionId} 已不存在，将新建会话并告知用户`);
        try {
          await client.sendMessage({
            chatId,
            text:
              `@主人 ⚠️ 我之前用的 DSH 会话 \`${binding.sessionId}\` 已经不在了（可能被删除了）。\n` +
              `我已经新建一个会话继续接消息；如果这不是你想要的，请到围炉的「接入设置」里重新指定。`,
            clientMsgId: `campfire-session-gone:${binding.sessionId}:${Date.now()}`,
          });
        } catch (error) {
          log('warn', `回写「会话已不存在」说明失败：${error?.message ?? error}`);
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

  /**
   * 等回复期间盯着「停止」指令。
   *
   * 长轮询这时候是阻塞的，普通消息进不来，所以单独开一条短轮询：围炉那边
   * 一旦记下停止请求，这里下个周期就能取走并中断这一轮。
   */
  function watchStop(chatId, sessionId) {
    let stopped = false;
    let triggered = false;
    const loop = async () => {
      while (!stopped) {
        try {
          const res = await client.control({ chat: chatId, signal: controller?.signal });
          const actions = Array.isArray(res?.actions) ? res.actions : [];
          if (actions.some((a) => a?.type === 'stop')) {
            triggered = true;
            const ok = host.cancel?.(sessionId);
            log('info', `收到停止指令，会话 ${sessionId}：${ok ? '已中断这一轮' : '当前没有在跑的一轮'}`);
            return;
          }
        } catch (error) {
          if (error?.name === 'AbortError') return;
        }
        await sleep(1500);
      }
    };
    loop();
    return {
      stop() {
        stopped = true;
      },
      /** 这一轮是不是被用户主动停掉的（用来区分「停止」和「真没产出」）。 */
      wasTriggered: () => triggered,
    };
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
      // 附件的相对路径要靠基地址拼成完整 URL，agent 才取得到
      baseUrl: config.baseUrl,
    });

    const target = await ensureSession(chatId);
    const patch = { lastWakeAt: wakeup === 'reply' ? now() : undefined };
    if (patch.lastWakeAt === undefined) delete patch.lastWakeAt;
    await store.touchBinding(target.key, patch);

    if (wakeup === 'reply') {
      // 等这一轮跑完期间盯着停止指令，跑完就撤
      const stopWatch = watchStop(chatId, target.sessionId);
      let reply;
      try {
        reply = await host.ask({
          agent: target.agent,
          sessionId: target.sessionId,
          text,
          timeoutMs: config.replyTimeoutMs,
          update,
        });
      } finally {
        stopWatch.stop();
      }
      const outbound = normalizeOutboundText(reply, { maxChars: config.maxReplyChars });
      const wasStopped = stopWatch.wasTriggered();
      if (!outbound) {
        log('warn', `会话 ${target.sessionId} 这一轮没有产出可发送的文本（群 ${chatId}）`);
        /**
         * 不能静默。
         *
         * 之前这里是「只 ack 不回帖」，用户在群里只看到「等待中」，分不清
         * 「消息没送到」还是「agent 不想说话」——尤其会话被删后 DSH 内存里
         * 还认为它在，注入成功但 agent 空转，就会一直卡在这个状态。
         * 用 clientMsgId 去重，同一条消息只提示一次，挂在原消息下面。
         */
        try {
          await client.sendMessage({
            chatId,
            text: wasStopped
              ? '（已按你的要求停止这一轮。）'
              : '（这一轮没有产出内容。可能是原会话已被删除、或模型没有给出可发送的回复。）',
            replyTo: message.id,
            clientMsgId: `campfire-empty:${message.id}`,
            signal: controller?.signal,
          });
        } catch (error) {
          log('warn', `回写「无产出」说明失败：${error?.message ?? error}`);
        }
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

      if (store.hasProcessed(updateId)) {
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
        // 失败必须可见：否则用户只看到「一直没回复」，分不清是没送到还是 agent 没答。
        // 用成员自己的身份回一句，说明原因，别让消息静默消失。
        try {
          await client.sendMessage({
            chatId,
            text: `@主人 ⚠️ 这条消息我处理失败了：${error?.message ?? error}\n（常见原因：DSH 里的会话被删除或停用，请检查「围炉渠道」的会话是否还在）`,
            clientMsgId: `campfire-error:${updateId}`,
          });
          log('info', `已把失败原因回写到围炉群 ${chatId}`);
        } catch (sendErr) {
          log('warn', `回写失败说明也失败了：${sendErr?.message ?? sendErr}`);
        }
      }

      // 处理过的 updateId 落盘：回复成功但 ack 失败时，重启后不会重复回复
      await store.markProcessed(updateId);
      // 群聊不因单个成员处理失败而阻塞（§6.2）：失败也推进游标，靠上面那条回写暴露问题。
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
