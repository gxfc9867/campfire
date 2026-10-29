import { MEMBER_STATE, DRIVER, SENDER, JOB_STATUS } from '../constants.js';
import { recordMemberReply } from '../reply.js';
import { badRequest, forbidden, notFound, tooMany } from '../errors.js';
import { readJson, sendJson } from '../http/util.js';

/**
 * 成员对外接口（Member API）。
 *
 * 这是整个项目唯一的「接入契约」：只要能发 HTTP，就能当成员。
 * CLI 只是一种驱动方式，不进入协议——否则会把门槛抬回「为每个工具写适配器」。
 */
export function registerMemberRoutes(router, ctx) {
  const { cfg, store, members, memory, presence, waiters, hub, planner } = ctx;
  const log = ctx.log;

  /** 把 job 转成成员可读的待办项。 */
  function toItem(job) {
    const chat = store.getChat(job.chatId);
    const msg = store.getMessage(job.messageId);
    const senderName =
      msg?.sender === SENDER.user
        ? '主人'
        : msg?.sender === SENDER.system
          ? '系统'
          : members.get(msg?.sender)?.display || msg?.sender || '';
    return {
      jobId: job.id,
      requestId: job.requestId,
      chatId: job.chatId,
      chatName: chat?.name || job.chatId,
      messageId: job.messageId,
      sender: msg?.sender || '',
      senderName,
      text: msg?.text ?? job.text,
      createdAt: job.createdAt,
      attempts: job.attempts,
    };
  }

  /**
   * 取该成员当前可认领的待办，并就地认领。
   * 认领（pending → processing）是防止「两条挂起连接各处理一遍」的关键，
   * 也让「进程崩在中间」的投递最终能被超时巡检回收。
   */
  function collectAndClaim(handle, limit = 10) {
    const pending = store.listJobs({ handle, status: JOB_STATUS.pending, limit });
    const claimed = [];
    for (const job of pending) {
      if (store.claimJob(job.id, handle)) {
        claimed.push({ ...job, status: JOB_STATUS.processing });
      }
    }
    return claimed;
  }

  // ── 收信（长轮询）────────────────────────────────────────────────────
  router.get(
    '/api/agent/inbox',
    async (req, res, url, identity) => {
      const handle = identity.member;
      // 任何一次拉取都算「还活着」，sidecar 因此不需要额外的独立心跳
      presence.touch(handle);

      const rawWait = url.searchParams.get('wait');
      const waitSec =
        rawWait === null ? 0 : Math.min(Math.max(Number(rawWait) || 0, 0), cfg.inboxWaitMax);

      let items = collectAndClaim(handle);

      if (!items.length && waitSec > 0) {
        const why = await waiters.wait(handle, res, waitSec * 1000);
        if (why === 'rejected') throw tooMany('挂起连接数已达上限');
        if (why === 'signal') items = collectAndClaim(handle);
        // timeout / closed 都是「这次没有」，返回空数组即可——客户端据此立刻重连
      }

      if (res.writableEnded) return;

      sendJson(res, 200, {
        ok: true,
        items: items.map(toItem),
        // 有活就顺带告诉 sidecar「你需要一个进程」；没有就是普通的空轮询
        wake: items.length > 0,
        serverTime: Date.now(),
        nextWait: waitSec,
      });
    },
    { auth: 'member' },
  );

  // ── 回执 ────────────────────────────────────────────────────────────
  router.post(
    '/api/agent/reply',
    async (req, res, url, identity) => {
      const handle = identity.member;
      presence.touch(handle);

      const body = await readJson(req, 256 * 1024);
      const requestId = String(body.requestId || '').trim();
      const text = String(body.text || '').trim();
      if (!requestId) throw badRequest('缺少 requestId');
      if (!text) throw badRequest('回执内容为空');
      if (text.length > cfg.maxTextLength) throw badRequest('回执过长');

      const job = store.getJobByRequestId(requestId);
      if (!job) throw notFound('请求不存在或已过期');
      if (job.handle !== handle) throw forbidden('这条请求不属于你');

      const result = recordMemberReply(ctx, { handle, job, text, clientId: body.clientId || null });
      if (result.duplicate) {
        return sendJson(res, 200, { ok: true, duplicate: true, message: result.message });
      }

      log.debug(`${handle} 回执 ${requestId}`);
      sendJson(res, 200, { ok: true, message: result.message });
    },
    { auth: 'member' },
  );

  /**
   * 批量确认：把几条投递标记为已完成但不产出消息。
   * 用于 sidecar 把「一批消息合并成一次回复」的场景——回复挂在第一条上，
   * 其余几条必须被显式收尾，否则会一直挂到超时。
   */
  router.post(
    '/api/agent/ack',
    async (req, res, url, identity) => {
      const handle = identity.member;
      presence.touch(handle);
      const body = await readJson(req, 64 * 1024);
      const ids = Array.isArray(body.requestIds) ? body.requestIds.map(String) : [];
      let n = 0;
      for (const rid of ids) {
        const job = store.getJobByRequestId(rid);
        if (!job || job.handle !== handle) continue;
        if (job.status === JOB_STATUS.done) continue;
        store.finishJob(job.id, JOB_STATUS.done);
        n++;
      }
      sendJson(res, 200, { ok: true, acked: n });
    },
    { auth: 'member' },
  );

  // ── 状态上报 ────────────────────────────────────────────────────────
  router.post(
    '/api/agent/state',
    async (req, res, url, identity) => {
      const handle = identity.member;
      const body = await readJson(req, 4096);
      const state = String(body.state || '');
      if (!Object.values(MEMBER_STATE).includes(state)) {
        throw badRequest(`state 必须是 ${Object.values(MEMBER_STATE).join(' / ')}`);
      }
      presence.setState(handle, state, {
        pid: body.pid ?? null,
        running: body.running,
        limit: body.limit,
        error: body.error ?? null,
      });
      sendJson(res, 200, { ok: true, serverTime: Date.now() });
    },
    { auth: 'member' },
  );

  // ── 档案（sidecar 拼提示词用）──────────────────────────────────────
  router.get(
    '/api/agent/profile',
    (req, res, url, identity) => {
      const m = members.get(identity.member);
      if (!m) throw notFound('成员不存在');
      const digest = memory.read(m.handle);
      const chats = m.chats
        .map((id) => store.getChat(id))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name }));
      sendJson(res, 200, {
        handle: m.handle,
        display: m.display,
        persona: m.persona,
        digest: digest.digest,
        digestUpdatedAt: digest.updatedAt,
        chats,
        wake: m.wake,
        caps: m.caps,
        // sidecar 需要真实命令才能起进程。这是「主人配置、sidecar 自愿执行」的信任链：
        // 桥只负责把配置送到，执行与否由 sidecar 决定（可在本地加白名单）。
        driver: m.driver,
      });
    },
    { auth: 'member' },
  );

  /** 群内上下文：最近若干条消息，供拼提示词。 */
  router.get(
    '/api/agent/context',
    (req, res, url, identity) => {
      const m = members.get(identity.member);
      if (!m) throw notFound('成员不存在');
      const chatId = url.searchParams.get('chat') || m.chats[0] || '';
      if (!chatId) throw badRequest('缺少 chat 参数');
      if (!m.chats.includes(chatId)) throw forbidden('你不在这个群里');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 60);
      const { items } = store.listMessages({ chatId, limit });
      sendJson(res, 200, {
        chatId,
        messages: items.map((msg) => ({
          sender: msg.sender,
          senderName:
            msg.sender === SENDER.user
              ? '主人'
              : msg.sender === SENDER.system
                ? '系统'
                : members.get(msg.sender)?.display || msg.sender,
          text: msg.text,
          createdAt: msg.createdAt,
        })),
      });
    },
    { auth: 'member' },
  );

  // ── 记忆 ────────────────────────────────────────────────────────────
  router.get(
    '/api/agent/memory',
    (req, res, url, identity) => {
      sendJson(res, 200, memory.read(identity.member));
    },
    { auth: 'member' },
  );

  router.put(
    '/api/agent/memory',
    async (req, res, url, identity) => {
      const body = await readJson(req, 64 * 1024);
      const saved = memory.write(identity.member, body.digest ?? '');
      hub.emit('change', { type: 'memory', handle: identity.member });
      sendJson(res, 200, { ok: true, ...saved });
    },
    { auth: 'member' },
  );

  /**
   * 拼好的提示词。
   * 放在服务端生成而不是让 sidecar 自己拼：三层记忆的顺序与措辞是协议的一部分，
   * 集中在一处才能保证所有驱动的行为一致。
   */
  router.get(
    '/api/agent/prompt',
    (req, res, url, identity) => {
      const m = members.get(identity.member);
      if (!m) throw notFound('成员不存在');
      const chatId = url.searchParams.get('chat') || m.chats[0] || '';
      const chat = store.getChat(chatId);
      if (!chat) throw notFound('会话不存在');
      if (!m.chats.includes(chatId)) throw forbidden('你不在这个群里');

      const digest = memory.read(m.handle).digest;
      const { items } = store.listMessages({ chatId, limit: 20 });
      const messages = items.map((msg) => ({
        sender: msg.sender,
        senderName:
          msg.sender === SENDER.user
            ? '主人'
            : msg.sender === SENDER.system
              ? '系统'
              : members.get(msg.sender)?.display || msg.sender,
        text: msg.text,
      }));

      const prompt = planner.buildPrompt({
        member: m,
        digest,
        messages,
        chatName: chat.name,
        trigger: url.searchParams.get('trigger') || '',
      });

      sendJson(res, 200, { prompt, chatId, chatName: chat.name });
    },
    { auth: 'member' },
  );
}
