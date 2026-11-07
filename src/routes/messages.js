import { MAIN_CHAT, SENDER, JOB_STATUS, DRIVER } from '../constants.js';
import { badRequest, notFound } from '../errors.js';
import { readJson, readBody, sendJson, prepareStream, createLimiter, clientIp } from '../http/util.js';
import { parseTargets } from '../targets.js';
import { requestStop } from '../control.js';
import { toMarkdown, toJson, exportBaseName } from '../export.js';
import { publicAttachment } from '../uploads.js';
import { shortId } from '../id.js';
import { computeNextRun, newScheduleId } from '../scheduler.js';
import { validateCron, describeCron } from '../cron.js';
import { deliverWebhook } from '../drivers/webhook.js';
import { deliverLlm } from '../drivers/llm.js';

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
  /**
   * 建投递任务并按驱动分流：webhook 推送、llm 桥内直调、其余靠长轮询叫醒。
   * 三种入口（@提及、显式指定、私聊）共用这一处，避免某条路径漏掉新驱动。
   */
  function enqueue(member, { chatId, messageId, text, sender }) {
    /**
     * 通过渠道令牌接入的成员（DSH 插件、WorkBuddy 桥）走 /v1/updates 游标流，
     * 从来不会来认领 job。给它建 job 的唯一下场就是 10 分钟后超时，然后往群里
     * 插一条「@xxx 的这条消息还没被处理」的噪音——而消息其实早就送到了。
     */
    const viaChannel = (ctx.channels?.list?.(member.handle) || []).some((c) => !c.revokedAt);
    if (viaChannel) {
      log.debug(`跳过 job：${member.handle} 通过渠道令牌接入，走 /v1/updates 游标流`);
      return null;
    }

    const job = store.createJob({
      chatId,
      messageId,
      handle: member.handle,
      requestId: shortId('r_'),
      text,
      expiresInMs: cfg.jobExpireMs,
    });

    const chat = store.getChat(chatId);
    const chatName = chat?.name || chatId;
    const senderName =
      sender === SENDER.user ? '主人' : members.get(sender)?.display || sender;
    const type = member.driver?.type;

    if (type === DRIVER.webhook) {
      // webhook 型成员不会来轮询，直接推过去；回执方式见 drivers/webhook.js
      deliverWebhook(ctx, job, member, { chatName, senderName });
    } else if (type === DRIVER.llm) {
      // 桥内直连模型：没有外部进程可叫醒，这里直接把投递推进到终态
      deliverLlm(ctx, job, member, { chatName });
    } else {
      // 叫醒正挂着的长轮询：这一步就是「下发唤醒」，桥只通知，不执行任何命令
      waiters.notify(member.handle);
      const decision = planner.decide(member.handle);
      if (decision.action === 'wake') {
        planner.markWoken(member.handle);
      } else if (decision.action === 'hold') {
        log.debug(`暂缓唤醒 ${member.handle}：${decision.reason}`);
      }
    }
    return job;
  }

  function fanout({ chatId, messageId, text, sender, maxDepth = 2 }) {
    const chat = store.getChat(chatId);
    // 私聊不接力：成员在私聊里 @ 了别人，也不能把话带到群外或另一个人那里
    if (chat?.kind === 'dm') return [];

    const candidates = store
      .listMembersOf(chatId)
      .map((h) => members.get(h))
      .filter((m) => m && !m.archivedAt && m.handle !== sender);

    const { targets } = parseTargets(text, candidates);
    const jobs = [];
    const message = store.getMessage(messageId);
    const depth = message ? chainDepth(message) : 0;

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
      const member = members.get(handle);
      if (!member) continue;
      const job = enqueue(member, { chatId, messageId, text, sender });
      if (job) jobs.push(job);
    }

    return jobs;
  }

  /**
   * 把成员投递能力挂到 ctx，供渠道 API 复用。
   *
   * 成员通过 /v1/messages 发言时也要能 @ 到别的成员 —— 那条路径之前只落库不投递，
   * 表现就是「agent 之间怎么 @ 都没反应」。挂在这里而不是抽成模块，是因为
   * fanout/enqueue 依赖本函数的闭包（store、members、waiters、planner、log）。
   */
  ctx.deliverToMembers = fanout;
  // 定时消息调度器要用同一条投递管线：定时消息就是「主人到点发的一条普通消息」
  ctx.deliver = createAndDeliver;

  async function createAndDeliver({
    chatId,
    sender,
    text,
    clientId,
    explicitTargets,
    replyTo = null,
    attachmentIds = null,
  }) {
    const chat = store.getChat(chatId);
    if (!chat) throw notFound('会话不存在');

    const body = String(text || '').trim();
    if (body.length > cfg.maxTextLength) throw badRequest('消息过长');

    // 附件：只认本会话里、还没挂到别的消息上的上传记录
    let attachments = null;
    if (Array.isArray(attachmentIds) && attachmentIds.length) {
      if (attachmentIds.length > 10) throw badRequest('一条消息最多 10 个附件');
      attachments = [];
      for (const id of attachmentIds) {
        const row = store.getUpload(String(id));
        if (!row) throw badRequest(`附件不存在：${id}`);
        if (row.chatId !== chatId) throw badRequest('附件不属于这个会话');
        if (row.messageId) throw badRequest(`附件已经用过了：${id}`);
        attachments.push(publicAttachment(row));
      }
    }

    // 只有附件、没有正文也合法（发张图不打字），但两者不能都空
    if (!body && !attachments) throw badRequest('消息不能为空');

    // 幂等：客户端重试时靠 clientId 去重，避免同一句话出现两次
    if (clientId) {
      const dup = store.getMessageByClientId(sender, clientId);
      if (dup) return { message: dup, jobs: [] };
    }

    const message = store.insertMessage({
      chatId,
      sender,
      text: body,
      clientId,
      replyTo,
      attachments,
    });
    if (attachments) store.attachUploadsToMessage(attachments.map((a) => a.id), message.id);
    store.touchChat(chatId);

    let jobs = [];
    if (chat.kind === 'dm') {
      // 私聊不用 @：说给谁就发给谁。发消息的人如果是成员自己（理论上不该走到这里），不再回投。
      const peer = chat.peer ? members.get(chat.peer) : null;
      if (peer && !peer.archivedAt && peer.handle !== sender) {
        const job = enqueue(peer, { chatId, messageId: message.id, text: body, sender });
        if (job) jobs.push(job);
      }
    } else if (Array.isArray(explicitTargets) && explicitTargets.length) {
      // 允许显式指定收件人（不一定要在正文里 @）
      const valid = explicitTargets
        .map((h) => members.get(String(h)))
        .filter((m) => m && !m.archivedAt && m.handle !== sender);
      for (const m of valid) {
        const job = enqueue(m, { chatId, messageId: message.id, text: body, sender });
        if (job) jobs.push(job);
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
    (req, res, url) => {
      const wantArchived = url.searchParams.get('archived') === '1';
      const unread = store.unreadCounts();
      const source = wantArchived ? store.listArchivedChats() : store.listChats();
      const chats = source.map((c) => {
        // 单聊带上对端的显示信息：侧栏要画它的头像，而不是一个首字母
        const peerMember = c.kind === 'dm' && c.peer ? members.get(c.peer) : null;
        return {
          ...c,
          peerInfo: peerMember
            ? {
                handle: peerMember.handle,
                display: peerMember.display,
                avatar: peerMember.avatar,
                avatarSalt: peerMember.avatarSalt,
                driverType: peerMember.driver?.type,
                archived: Boolean(peerMember.archivedAt),
              }
            : null,
          count: store.countMessages(c.id),
          last: store.lastMessageOf(c.id),
          members: store.listMembersOf(c.id),
          readSeq: store.getReadSeq(c.id),
          unread: unread[c.id] || 0,
        };
      });
      sendJson(res, 200, { chats, main: MAIN_CHAT.id, archived: wantArchived });
    },
    { auth: 'owner' },
  );

  /**
   * 归档会话：只是从列表里收起来，成员归属不动，随时可以恢复。
   * 和「解散」的区别：解散会顺带把成员从这个群移除（members.dropChat）。
   */
  router.post(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})\/archive$/,
    (req, res, url, identity, id) => {
      if (id === MAIN_CHAT.id) throw badRequest('大厅是主会话，不能归档');
      const chat = store.getChat(id);
      if (!chat) throw notFound('会话不存在');
      if (chat.archivedAt) throw badRequest('该会话已经在归档里了');
      store.archiveChat(id);
      log.info(`归档会话 ${id}（${chat.name}）`);
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { ok: true });
    },
    { auth: 'owner' },
  );

  /** 把归档的会话放回列表。成员归属保持原样（归档时本来就没动）。 */
  router.post(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})\/restore$/,
    (req, res, url, identity, id) => {
      const chat = store.getChat(id);
      if (!chat) throw notFound('会话不存在');
      if (!chat.archivedAt) throw badRequest('该会话没有被归档');
      const restored = store.restoreChat(id);
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { chat: restored });
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

  /**
   * 导出整个会话。
   *
   * format=md（默认）给人看也给 agent 看；format=json 给需要程序处理的场景。
   * 全量导出不分页：会话再长也是一次读完，避免分页边界把最后几条漏掉。
   */
  router.get(
    /^\/api\/chats\/([^/]+)\/export$/,
    (req, res, url, identity, chatId) => {
      const chat = store.getChat(chatId);
      if (!chat) throw notFound('会话不存在');

      const format = String(url.searchParams.get('format') || 'md').toLowerCase();
      const messages = store.listAllMessages(chatId);

      // 参与成员：群归属优先，再补上「发过言但已不在群里」的，避免显示成裸 handle
      const memberMap = new Map();
      for (const h of store.listMembersOf(chatId)) {
        const m = members.get(h);
        if (m) memberMap.set(h, m);
      }
      for (const msg of messages) {
        if (msg.sender === SENDER.user || msg.sender === SENDER.system) continue;
        if (memberMap.has(msg.sender)) continue;
        const m = members.get(msg.sender);
        if (m) memberMap.set(msg.sender, m);
      }

      const exportedAt = Date.now();
      const base = exportBaseName(chat, exportedAt);

      if (format === 'json') {
        return sendJson(res, 200, toJson({ chat, messages, members: memberMap, exportedAt }), {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.json`)}`,
          'Cache-Control': 'no-store',
        });
      }

      const md = toMarkdown({ chat, messages, members: memberMap, exportedAt });
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.md`)}`,
        'Cache-Control': 'no-store',
      });
      res.end(md);
    },
    { auth: 'owner' },
  );

  // ── 附件上传与下载 ──────────────────────────────────────────────────

  /**
   * 上传：裸 body + 自定义头。
   *
   * 前端 `fetch('/api/uploads', {method:'POST', body: file, headers:{'x-chat','x-filename','content-type'}})`
   * 一行就能发。不用 multipart 是因为那要自己写一套解析器，而这里只有一个文件。
   */
  router.post(
    '/api/uploads',
    async (req, res) => {
      if (cfg.maxUploadMb <= 0) throw badRequest('附件功能未开启（MAX_UPLOAD_MB=0）');
      const chatId = String(req.headers['x-chat'] || MAIN_CHAT.id);
      if (!store.getChat(chatId)) throw notFound('会话不存在');

      let filename = 'file';
      try {
        filename = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
      } catch {
        // 头里的编码坏了就用默认名，不至于让上传失败
      }
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();

      const buffer = await readBody(req, cfg.maxUploadMb * 1024 * 1024);
      if (!buffer.length) throw badRequest('文件是空的');

      let saved;
      try {
        saved = ctx.uploads.save({ buffer, filename, mime, chatId, uploader: SENDER.user });
      } catch (error) {
        throw badRequest(error.message);
      }
      const row = store.createUpload(saved);
      log.info?.(`附件已上传 ${row.id}（${row.name}，${row.size} 字节）→ ${chatId}`);
      sendJson(res, 201, { attachment: publicAttachment(row) });
    },
    { auth: 'owner' },
  );

  /** 下载：主人 cookie 鉴权，浏览器 <img> 会自动带。 */
  router.get(
    /^\/api\/files\/([^/]+)$/,
    (req, res, url, identity, id) => {
      const row = store.getUpload(id);
      if (!row) throw notFound('文件不存在');
      const buf = ctx.uploads.read(row.path);
      if (!buf) throw notFound('文件已丢失');

      res.writeHead(200, {
        'Content-Type': row.mime,
        'Content-Length': buf.length,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    },
    { auth: 'owner' },
  );

  // ── 定时消息 ────────────────────────────────────────────────────────

  /** 把 cron 规则翻成人话，前端列表直接显示。 */
  function decorateSchedule(s) {
    let description = s.cron;
    try {
      description = describeCron(s.cron);
    } catch {
      // cron 坏了就原样显示，不至于让整张列表崩掉
    }
    return { ...s, description };
  }

  router.get(
    '/api/schedules',
    (req, res, url) => {
      const chatId = url.searchParams.get('chat') || null;
      sendJson(res, 200, { schedules: store.listSchedules(chatId).map(decorateSchedule) });
    },
    { auth: 'owner' },
  );

  router.post(
    '/api/schedules',
    async (req, res) => {
      const body = await readJson(req, 16 * 1024);
      const chatId = String(body.chat || MAIN_CHAT.id);
      if (!store.getChat(chatId)) throw notFound('会话不存在');

      const text = String(body.text || '').trim();
      if (!text) throw badRequest('消息内容不能为空');
      if (text.length > cfg.maxTextLength) throw badRequest('消息过长');

      const cron = String(body.cron || '').trim();
      try {
        validateCron(cron);
      } catch (error) {
        throw badRequest(`时间规则不合法：${error.message}`);
      }

      const schedule = store.createSchedule({
        id: newScheduleId(),
        chatId,
        cron,
        text,
        nextRunAt: computeNextRun(cron),
        createdBy: 'owner',
      });
      sendJson(res, 201, { schedule: decorateSchedule(schedule) });
    },
    { auth: 'owner' },
  );

  router.patch(
    /^\/api\/schedules\/([^/]+)$/,
    async (req, res, url, identity, id) => {
      const current = store.getSchedule(id);
      if (!current) throw notFound('定时消息不存在');
      const body = await readJson(req, 16 * 1024);

      const patch = {};
      if (body.text !== undefined) {
        const text = String(body.text).trim();
        if (!text) throw badRequest('消息内容不能为空');
        if (text.length > cfg.maxTextLength) throw badRequest('消息过长');
        patch.text = text;
      }
      if (body.cron !== undefined) {
        const cron = String(body.cron).trim();
        try {
          validateCron(cron);
        } catch (error) {
          throw badRequest(`时间规则不合法：${error.message}`);
        }
        patch.cron = cron;
        patch.nextRunAt = computeNextRun(cron);
      }
      if (body.enabled !== undefined) {
        patch.enabled = Boolean(body.enabled);
        // 重新启用时把时间点接上，否则它会一直是 null 永远不触发
        if (patch.enabled && current.nextRunAt == null) {
          patch.nextRunAt = computeNextRun(patch.cron || current.cron);
        }
      }

      const updated = store.updateSchedule(id, patch);
      sendJson(res, 200, { schedule: decorateSchedule(updated) });
    },
    { auth: 'owner' },
  );

  router.delete(
    /^\/api\/schedules\/([^/]+)$/,
    (req, res, url, identity, id) => {
      if (!store.deleteSchedule(id)) throw notFound('定时消息不存在');
      sendJson(res, 200, { ok: true });
    },
    { auth: 'owner' },
  );

  /**
   * 停止：让正在跑这一轮的成员中断生成。
   *
   * 只往内存里放一个带 TTL 的标记，由成员通过 /v1/control 取走 —— 它这时候
   * 正卡在等回复里，收不到普通消息，只能用独立短轮询取。
   */
  router.post(
    '/api/stop',
    async (req, res) => {
      const body = await readJson(req, 4096);
      const chatId = String(body.chat || MAIN_CHAT.id);
      if (!store.getChat(chatId)) throw notFound('会话不存在');
      requestStop(chatId);
      hub.emit('change', { type: 'control', chatId });
      sendJson(res, 200, { ok: true, chat: chatId });
    },
    { auth: 'owner' },
  );

  /** 开一个与成员的单聊。已有就复用——同一个成员只有一条私聊。 */
  router.post(
    '/api/chats/dm',
    async (req, res) => {
      const body = await readJson(req, 4096);
      const handle = String(body.handle || '').trim().toLowerCase();
      const m = members.get(handle);
      if (!m || m.archivedAt) throw notFound('成员不存在或已移除');
      const chat = store.ensureDm(m.handle, m.display);
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { chat: { ...chat, members: store.listMembersOf(chat.id) } });
    },
    { auth: 'owner' },
  );

  router.patch(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})$/,
    async (req, res, url, identity, id) => {
      const body = await readJson(req, 16 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw badRequest('备注不能为空');
      if (name.length > cfg.maxChatNameLength) throw badRequest('备注过长');
      const chat = store.renameChat(id, name);
      if (!chat) throw notFound('会话不存在');
      hub.emit('change', { type: 'chat' });
      sendJson(res, 200, { chat });
    },
    { auth: 'owner' },
  );

  /** 解散群聊 / 删除私聊：会话从列表消失，成员的归属一并摘掉。 */
  router.delete(
    /^\/api\/chats\/([A-Za-z0-9_-]{1,40})$/,
    (req, res, url, identity, id) => {
      if (id === MAIN_CHAT.id) throw badRequest('大厅是主会话，不能解散');
      const chat = store.getChat(id);
      if (!chat) throw notFound('会话不存在');
      store.archiveChat(id);
      if (chat.kind === 'dm') {
        // 私聊不在成员的 chats 配置里，只需归档会话本身
      } else {
        members.dropChat(id);
      }
      log.info(`${chat.kind === 'dm' ? '删除私聊' : '解散群聊'} ${id}（${chat.name}）`);
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
        attachmentIds: body.attachmentIds,
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
