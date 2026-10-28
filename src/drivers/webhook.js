import { JOB_STATUS, MENTION_OWNER_RE } from '../constants.js';

/**
 * webhook 驱动的投递器。
 *
 * 语义（尽量简单，但闭环）：
 * - 桥 POST 到成员地址，带 requestId、来源与正文；
 * - 成员可以同步返回 { text } —— 桥立刻替它回执；
 * - 也可以先返回 200 空体，稍后拿 requestId 调 /api/agent/reply；
 * - 非 2xx 或超时按 failed 处理，主人在投递面板里能重试。
 *
 * 密钥放 X-Campfire-Secret 头：成员据此确认请求真的来自桥。
 */

export async function postWebhook({ url, secret, timeoutMs }, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Campfire-Secret': secret } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  return data && typeof data.text === 'string' ? data.text : null;
}

/** 推一条投递给 webhook 成员。成功回执与否都在这里收尾，调用方 fire-and-forget。 */
export async function deliverWebhook({ store, hub, log }, job, member, { chatName, senderName }) {
  const driver = member.driver || {};
  try {
    const text = await postWebhook(driver, {
      requestId: job.requestId,
      jobId: job.id,
      chatId: job.chatId,
      chatName,
      from: senderName,
      text: job.text,
    });

    if (text) {
      // 同步回执：成员在响应体里直接给了话
      const message = store.insertMessage({
        chatId: job.chatId,
        sender: job.handle,
        text,
        jobId: job.id,
        replyTo: job.messageId,
        meta: { mentionsOwner: MENTION_OWNER_RE.test(text) || false },
      });
      store.finishJob(job.id, JOB_STATUS.done);
      store.touchChat(job.chatId);
      hub.emit('change', { type: 'message', chatId: job.chatId, seq: message.seq });
      log.debug(`webhook ${job.handle} 同步回执`);
      return;
    }

    // 200 但没带正文：job 留在 pending，等成员稍后用 requestId 调 /api/agent/reply
    hub.emit('change', { type: 'job', chatId: job.chatId });
    log.debug(`webhook ${job.handle} 已受理，等待异步回执`);
  } catch (e) {
    store.finishJob(job.id, JOB_STATUS.failed, e.message);
    hub.emit('change', { type: 'job', chatId: job.chatId });
    log.warn(`webhook ${job.handle} 投递失败：${e.message}`);
  }
}
