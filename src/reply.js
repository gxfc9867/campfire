import { SENDER, JOB_STATUS, MENTION_OWNER_RE } from './constants.js';

/**
 * 成员把一条投递回执落库。
 *
 * 抽出来的原因：现在有两条路会产生成员发言——成员自己调 /api/agent/reply，
 * 以及桥内直连大模型的 llm 驱动。如果各写一份，「@我」判定、幂等、接力触发
 * 这三件事迟早会分叉（之前 webhook 同步回执就漏了接力）。
 * 所以这里是唯一的入口。
 *
 * @returns {{message: object, duplicate: boolean}}
 */
export function recordMemberReply(ctx, { handle, job, text, clientId = null }) {
  const { store, hub, members, log } = ctx;

  // 幂等：同一个 requestId 重复提交只认第一次，唤醒两次不会冒出两条回复
  if (job.status === JOB_STATUS.done) {
    const existing = store.getMessageByJobId(job.id);
    if (existing) return { message: existing, duplicate: true };
  }

  const message = store.insertMessage({
    chatId: job.chatId,
    sender: handle,
    text,
    jobId: job.id,
    replyTo: job.messageId,
    clientId,
    // 「@我」的判定在服务端做完，前端只看标记：
    // ① 回复里显式写了 @主人/@me；② 这条回复本来就是回应主人发的消息
    meta: {
      mentionsOwner:
        MENTION_OWNER_RE.test(text) || store.getMessage(job.messageId)?.sender === SENDER.user,
    },
  });

  store.finishJob(job.id, JOB_STATUS.done);
  store.touchChat(job.chatId);
  hub.emit('change', { type: 'message', chatId: job.chatId, seq: message.seq });

  // 成员回复里 @ 了别的成员：允许接力，深度限制由 fanout 把关（3 跳封顶）
  if (text.includes('@') && typeof ctx.fanout === 'function') {
    try {
      ctx.fanout({ chatId: job.chatId, messageId: message.id, text, sender: handle });
    } catch (e) {
      log.warn(`接力投递失败：${e.message}`);
    }
  }

  return { message, duplicate: false };
}

/** 名字解析：主人、系统、成员各显示什么。多处用到，集中一处。 */
export function displayNameOf(ctx, sender) {
  if (!sender) return '';
  if (sender === SENDER.user) return '主人';
  if (sender === SENDER.system) return '系统';
  return ctx.members.get(sender)?.display || sender;
}
