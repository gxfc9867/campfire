import { MAIN_CHAT, SENDER, JOB_STATUS, DRIVER } from '../constants.js';
import { badRequest, notFound } from '../errors.js';
import { readJson, sendJson, prepareStream, createLimiter, clientIp } from '../http/util.js';
import { parseTargets } from '../targets.js';
import { shortId } from '../id.js';
import { deliverWebhook } from '../drivers/webhook.js';

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

  /** 一条消息在自己的会话链里属于第几跳（主人发起 = 0）。防互 @ 死循环的依据。 */
  function chainDepth(message) {
    let cur = message;
    for (let d = 0; d < 6; d++) {
      if (!cur) return d;
      if (cur.sender === SENDER.user || cur.sender === SENDER.system) return d;
      const prev = cur.replyTo ? store.getMessage(cur.replyTo) : null;
      if (!prev) return d + 1;
      cur = prev;
    }
    // 六跳还没到头，视为死循环链
    return 99;
  }

  /**
   * 把一条消息投递给被 @ 的成员。
   * 注意顺序：先落库、再建任务、最后才通知。任何一步失败都不该让消息消失。
   *
   * depth 限制成员之间的接力：主人 @ A，A 回 @ B（1 跳，允许），B 回 @ A（2 跳，
   * 允许），A 再回 @ B（3 跳，停）。没有这条规则，两个互相客气的 agent 能烧一晚上。
   */
  function fanout({ chatId, messageId, text, sender, maxDepth = 2 }) {
    const candidates = store
      .listMembersOf(chatId)
      .map((h) => members.get(h))
      .filter((m) => m && !m.archivedAt && m.handle !== sender);

    const { targets } = parseTargets(text, candidates);
    const jobs = [];
    const message = store.getMessage(messageId);
    const depth = message ? chainDepth(message) : 0;
    const chat = store.getChat(chatId);

    if (depth > maxDepth) {
      log.info(`接力深度 ${depth} 已达上限，@${targets.join(',') || '…'} 不再投递`);
      store.insertMessage({
        chatId,
        sender: SENDER.system,
        text: '成员之间的接力到此为止（已连续 3 跳），需要的话请主人亲自接话。',
        meta: { kind: 'chain_stop' },
      });
      hub.emit('change', { type: 'message', chatId });
      return jobs;
    }

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

      if (members.get(handle)?.driver.type === DRIVER.webhook) {
        // webhook 型成员不会来轮询，直接推过去；回执方式见 drivers/webhook.js
        deliverWebhook(ctx, job, members.get(handle), {
          chatName: chat?.name || chatId,
          senderName:
            sender === SENDER.user ? '主人' : members.get(sender)?.display || sender,
        });
        continue;
      }

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

  async function createAndDeliver({ chatId, sender, text, clientId, explicitTargets, replyTo = null }) {
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

    const message = store.insertMessage({ chatId, sender, text: body, clientId, replyTo });
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
      // 引用：只做归属校验，不参与投递逻辑——它是给人看的上下文
      let quote = null;
      if (body.quote) {
        const q = store.getMessage(String(body.quote));
        if (q && q.chatId === (body.chat || MAIN_CHAT.id)) quote = q.id;
      }
      const { message, jobs } = await createAndDeliver({
        chatId: body.chat || MAIN_CHAT.id,
        sender: SENDER.user,
        text: body.text,
        clientId: body.clientId,
        explicitTargets: body.targets,
        replyTo: quote,
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

  /** 主人改自己说的话。成员的产出是 agent 行为，不提供编辑。 */
  router.patch(
    /^\/api\/messages\/([A-Za-z0-9_-]{1,40})$/,
    async (req, res, url, identity, id) => {
      const body = await readJson(req, cfg.maxTextLength + 1024);
      const text = String(body.text || '').trim();
      if (!text) throw badRequest('内容不能为空');
      if (text.length > cfg.maxTextLength) throw badRequest('消息过长');
      const message = store.updateMessage(id, text);
      if (!message) throw notFound('消息不存在或不可编辑');
      hub.emit('change', { type: 'message', chatId: message.chatId, seq: message.seq });
      sendJson(res, 200, { message });
    },
    { auth: 'owner' },
  );

  /** 软删：正文清空，行保留（seq 不空洞）。任何消息都可删，包括成员的。 */
  router.delete(
    /^\/api\/messages\/([A-Za-z0-9_-]{1,40})$/,
    (req, res, url, identity, id) => {
      const message = store.deleteMessage(id);
      if (!message) throw notFound('消息不存在');
      hub.emit('change', { type: 'message', chatId: message.chatId, seq: message.seq });
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
