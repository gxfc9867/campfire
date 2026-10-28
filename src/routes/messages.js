import { MAIN_CHAT, SENDER, JOB_STATUS } from '../constants.js';
import { badRequest, notFound } from '../errors.js';
import { readJson, sendJson, prepareStream, createLimiter, clientIp } from '../http/util.js';
import { parseTargets } from '../targets.js';
import { shortId } from '../id.js';

/**
 * 会话与消息。
 *
 * 所有「发消息」都走同一个投递函数，保证：
 * 消息先落库（唤醒失败也不丢）→ 再建投递任务 → 再叫醒挂着的长轮询。
 */
export function registerMessageRoutes(router, ctx) {
  const { cfg, store, members, waiters, hub, planner, presence } = ctx;
  const log = ctx.log;
  const writeLimiter = createLimiter({ limit: 60, windowMs: 60_000 });

  /**
   * 把一条消息投递给被 @ 的成员。
   * 注意顺序：先落库、再建任务、最后才通知。任何一步失败都不该让消息消失。
   */
  function fanout({ chatId, messageId, text, sender }) {
    const candidates = store
      .listMembersOf(chatId)
      .map((h) => members.get(h))
      .filter((m) => m && !m.archivedAt && m.handle !== sender);

    const { targets } = parseTargets(text, candidates);
    const jobs = [];

    for (const handle of targets) {
      const requestId = shortId('r_');
      const job = store.createJob({
        chatId,
        messageId,
        handle,
        requestId,
        text,
        expiresInMs: cfg.jobExpireMs,
      });
      jobs.push(job);

      // 叫醒正挂着的长轮询：这一步就是「下发唤醒」，桥只通知，不执行任何命令
      waiters.notify(handle);

      const decision = planner.decide(handle);
      if (decision.action === 'wake') {
        planner.markWoken(handle);
      } else if (decision.action === 'hold') {
        log.debug(`暂缓唤醒 ${handle}：${decision.reason}`);
      }
    }

    return jobs;
  }

  async function createAndDeliver({ chatId, sender, text, clientId, explicitTargets }) {
    const chat = store.getChat(chatId);
    if (!chat) throw notFound('会话不存在');

    const body = String(text || '').trim();
    if (!body) throw badRequest('消息不能为空');
    if (body.length > cfg.maxTextLength) throw badRequest('消息过长');

    // 幂等：客户端重试时靠 clientId 去重，避免同一句话出现两次
    if (clientId) {
      const dup = store.getMessageByClientId(sender, clientId);
      if (dup) return { message: dup, jobs: [] };
    }

    const message = store.insertMessage({ chatId, sender, text: body, clientId });
    store.touchChat(chatId);

    let jobs = [];
    if (Array.isArray(explicitTargets) && explicitTargets.length) {
      // 允许显式指定收件人（不一定要在正文里 @）
      const valid = explicitTargets
        .map((h) => members.get(String(h)))
        .filter((m) => m && !m.archivedAt && m.handle !== sender);
      for (const m of valid) {
        const job = store.createJob({
          chatId,
          messageId: message.id,
          handle: m.handle,
          requestId: shortId('r_'),
          text: body,
          expiresInMs: cfg.jobExpireMs,
        });
        jobs.push(job);
        waiters.notify(m.handle);
        if (planner.decide(m.handle).action === 'wake') planner.markWoken(m.handle);
      }
    } else {
      jobs = fanout({ chatId, messageId: message.id, text: body, sender });
    }

    hub.emit('change', { type: 'message', chatId, seq: message.seq });
    return { message, jobs };
  }

  // ── 会话 ────────────────────────────────────────────────────────────

  router.get(
    '/api/chats',
    (req, res) => {
      const unread = store.unreadCounts();
      const chats = store.listChats().map((c) => ({
        ...c,
        count: store.countMessages(c.id),
        last: store.lastMessageOf(c.id),
        members: store.listMembersOf(c.id),
        readSeq: store.getReadSeq(c.id),
        unread: unread[c.id] || 0,
      }));
      sendJson(res, 200, { chats, main: MAIN_CHAT.id });
    },
    { auth: 'owner' },
  );

  /** 打开某个会话时调用：把已读位置推到当前最新。 */
  router.post(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})\/read$/,
    async (req, res, url, identity, id) => {
      if (!store.getChat(id)) throw notFound('会话不存在');
      const body = await readJson(req, 4096);
      const latest = store.lastMessageOf(id);
      const seq = Number(body.seq) || latest?.seq || 0;
      store.markRead(id, seq);
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { ok: true, readSeq: store.getReadSeq(id) });
    },
    { auth: 'owner' },
  );

  router.post(
    '/api/chats',
    async (req, res) => {
      const body = await readJson(req, 16 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw badRequest('会话名称不能为空');
      if (name.length > cfg.maxChatNameLength) throw badRequest('会话名称过长');
      const chat = store.createChat(name);
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { chat });
    },
    { auth: 'owner' },
  );

  router.patch(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})$/,
    async (req, res, url, identity, id) => {
      const body = await readJson(req, 16 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw badRequest('会话名称不能为空');
      const chat = store.renameChat(id, name);
      if (!chat) throw notFound('会话不存在');
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { chat });
    },
    { auth: 'owner' },
  );

  router.delete(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})$/,
    (req, res, url, identity, id) => {
      if (id === MAIN_CHAT.id) throw badRequest('主会话不可删除');
      const chat = store.getChat(id);
      if (!chat) throw notFound('会话不存在');
      store.archiveChat(id);
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { ok: true });
    },
    { auth: 'owner' },
  );

  // ── 消息 ────────────────────────────────────────────────────────────

  router.get(
    '/api/messages',
    (req, res, url) => {
      const chatId = url.searchParams.get('chat') || MAIN_CHAT.id;
      if (!store.getChat(chatId)) throw notFound('会话不存在');
      const after = Number(url.searchParams.get('after') || 0) || undefined;
      const before = Number(url.searchParams.get('before') || 0) || undefined;
      const limit = Number(url.searchParams.get('limit') || 50);
      const { items, hasMore } = store.listMessages({ chatId, after, before, limit });
      sendJson(res, 200, { messages: items, hasMore });
    },
    { auth: 'owner' },
  );

  router.post(
    '/api/messages',
    async (req, res) => {
      if (writeLimiter(clientIp(req, cfg))) throw badRequest('发送过于频繁，请稍后再试', 'rate_limited');
      const body = await readJson(req, 128 * 1024);
      const { message, jobs } = await createAndDeliver({
        chatId: body.chat || MAIN_CHAT.id,
        sender: SENDER.user,
        text: body.text,
        clientId: body.clientId,
        explicitTargets: body.targets,
      });
      sendJson(res, 200, {
        message,
        jobs: jobs.map((j) => ({ id: j.id, handle: j.handle, status: j.status })),
      });
    },
    { auth: 'owner' },
  );

  /**
   * 重试一条投递。requestId 不变，所以成员真在线时回执幂等会兜住重复。
   * 重试后立刻 notify：挂着的长轮询不用等 25 秒超时。
   */
  router.post(
    /^\/api\/jobs\/([A-Za-z0-9_-]{1,40})\/retry$/,
    (req, res, url, identity, id) => {
      const job = store.retryJob(id, cfg.jobExpireMs);
      if (!job) throw badRequest('这条投递当前状态不可重试');
      waiters.notify(job.handle);
      if (planner.decide(job.handle).action === 'wake') planner.markWoken(job.handle);
      hub.emit('change', { type: 'job', chatId: job.chatId });
      sendJson(res, 200, { ok: true, job: { id: job.id, status: job.status } });
    },
    { auth: 'owner' },
  );

  /** 取消：等太久了不想等。群里留一条说明，历史才对得上。 */
  router.post(
    /^\/api\/jobs\/([A-Za-z0-9_-]{1,40})\/cancel$/,
    (req, res, url, identity, id) => {
      const job = store.cancelJob(id);
      if (!job) throw badRequest('这条投递当前状态不可取消');
      store.insertMessage({
        chatId: job.chatId,
        sender: SENDER.system,
        text: `给 @${job.handle} 的那条消息已取消投递。`,
        meta: { kind: JOB_STATUS.cancelled, jobId: job.id },
      });
      hub.emit('change', { type: 'message', chatId: job.chatId });
      sendJson(res, 200, { ok: true });
    },
    { auth: 'owner' },
  );

  /** SSE：只做「有变化」的信号，真实数据由前端自己拉增量。 */
  router.get(
    '/api/events',
    (req, res, url) => {
      const chatId = url.searchParams.get('chat') || '';
      prepareStream(res);
      hub.subscribe(req, res, chatId);
    },
    { auth: 'owner' },
  );

  // 供成员复用的投递函数（Member API 里成员发言也要能 @ 别人）
  ctx.deliver = createAndDeliver;
  ctx.fanout = fanout;
}

/**
 * 投递超时巡检。
 * 到点仍未处理的投递降级为 expired 并在群里留一条说明——
 * 这里刻意不标 failed：成员可能只是睡着了，说「失败」会让用户以为消息丢了。
 */
export function startJobSweeper({ store, hub, log, everyMs = 30_000 }) {
  const timer = setInterval(() => {
    const expired = store.expireStaleJobs();
    if (!expired.length) return;
    for (const job of expired) {
      try {
        store.insertMessage({
          chatId: job.chatId,
          sender: SENDER.system,
          text: `@${job.handle} 的这条消息还没被处理（已等待 ${Math.round(
            (Date.now() - job.createdAt) / 60000,
          )} 分钟），已转为普通消息留在群里。`,
          meta: { kind: JOB_STATUS.expired, jobId: job.id },
        });
        hub.emit('change', { type: 'message', chatId: job.chatId });
      } catch (e) {
        log.warn('投递超时处理失败', e.message);
      }
    }
    log.info(`投递超时降级 ${expired.length} 条`);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
