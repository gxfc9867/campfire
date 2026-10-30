import { readJson, sendJson } from '../http/util.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { SENDER } from '../constants.js';

/**
 * Channel API v1。
 *
 * 契约见 docs/design/CONNECTION-DRAFT.md §4。
 * 这里的实现刻意保持「无状态 HTTP + 游标」：服务端不记录谁领走了哪条消息，
 * 只记录客户端读到哪了（cursor），断线重连靠它续传。
 */
export function registerChannelRoutes(router, ctx) {
  const { cfg, store, members, hub } = ctx;

  const CAPABILITIES = {
    messageTypes: ['text', 'markdown'],
    cursor: 'seq',
    wakeup: ['none', 'notify', 'reply'],
    coalesce: { windowMs: 30000, maxItems: 20 },
    attachments: { maxSize: 0, signedUrlTtl: 0 },
    editDelete: true,
    search: { vector: false, keyword: true },
  };

  // ── 能力协商（免鉴权：客户端先看支持什么，再决定怎么接）──────────
  router.get(
    '/v1/meta',
    (req, res) => {
      sendJson(res, 200, {
        apiVersion: 1,
        serverTime: Date.now(),
        capabilities: CAPABILITIES,
        limits: { maxTextLength: cfg.maxTextLength, maxWaitSeconds: cfg.inboxWaitMax },
      });
    },
    { auth: undefined },
  );

  /** 取当前渠道；路由已保证 identity.kind === 'channel'。 */
  function channelOf(identity) {
    return identity.channel;
  }

  function requireScope(identity, scope) {
    const scopes = channelOf(identity).scopes || [];
    if (!scopes.includes(scope)) throw forbidden(`缺少权限：${scope}`);
  }

  /** 成员必须在目标会话里。 */
  function assertMemberInChat(member, chatId) {
    const m = members.get(member);
    if (!m) throw notFound('成员不存在');
    if (!Array.isArray(m.chats) || !m.chats.includes(chatId)) throw forbidden('你不在这个会话里');
    return m;
  }

  function mentionsOf(text, handle) {
    const out = new Set();
    for (const m of String(text).matchAll(/@([A-Za-z0-9_-]{1,32})/g)) out.add(m[1]);
    return out.has(handle) ? [handle] : [];
  }

  function serialize(msg, handle) {
    const senderMember = msg.sender === SENDER.user || msg.sender === SENDER.system ? null : members.get(msg.sender);
    return {
      id: msg.id,
      chatId: msg.chatId,
      seq: msg.seq,
      sender: {
        kind: msg.sender === SENDER.user ? 'user' : msg.sender === SENDER.system ? 'system' : 'member',
        handle: msg.sender,
        display: senderMember?.display || (msg.sender === SENDER.user ? '主人' : msg.sender),
      },
      type: 'text',
      text: msg.text,
      attachments: [],
      replyTo: msg.replyTo || null,
      mentions: mentionsOf(msg.text, handle),
      createdAt: msg.createdAt,
      editedAt: msg.meta?.edited ? msg.createdAt : null,
      deletedAt: msg.meta?.deleted ? msg.createdAt : null,
    };
  }

  // ── 拉取更新（游标流，长轮询）────────────────────────────────────
  router.get(
    '/v1/updates',
    async (req, res, url, identity) => {
      requireScope(identity, 'read');
      const channel = channelOf(identity);
      const member = channel.member;

      const chatId = url.searchParams.get('chat') || (members.get(member)?.chats || [])[0];
      if (!chatId) throw badRequest('缺少 chat 参数');
      assertMemberInChat(member, chatId);
      const chat = store.getChat(chatId);

      const rawCursor = url.searchParams.get('cursor');
      let cursor = rawCursor === null ? store.getChannelCursor(channel.id, chatId) : Number(rawCursor);
      if (!Number.isFinite(cursor) || cursor < 0) throw badRequest('cursor 非法');

      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
      const rawWait = url.searchParams.get('wait');
      const waitSec = Math.min(Math.max(rawWait === null ? 0 : Number(rawWait) || 0, 0), cfg.inboxWaitMax);

      let items = [];
      let hasMore = false;
      const deadline = Date.now() + waitSec * 1000;

      // 客户端提前断开时别把等待挂到超时
      const closed = new AbortController();
      const onClose = () => closed.abort();
      req.on('close', onClose);

      try {
        for (;;) {
          const page = store.listMessages({ chatId, after: cursor, limit });
          items = page.items;
          hasMore = page.hasMore;
          if (items.length > 0 || waitSec === 0 || res.writableEnded) break;
          const remaining = deadline - Date.now();
          if (remaining <= 0 || closed.signal.aborted) break;
          // 事件驱动：同会话有新消息时 hub 立刻叫醒，不必等满 wait
          const outcome = await hub.wait(chatId, remaining, closed.signal);
          if (outcome === 'aborted' || res.writableEnded) break;
        }
      } finally {
        req.off('close', onClose);
      }

      const updates = items.map((msg) => ({
        updateId: `${chatId}:${msg.seq}`,
        type: msg.meta?.deleted ? 'message.deleted' : msg.meta?.edited ? 'message.edited' : 'message.created',
        chatId,
        chatTitle: chat?.name || chatId,
        seq: msg.seq,
        message: serialize(msg, member),
        wakeup: mentionsOf(msg.text, member).length > 0 ? 'reply' : 'notify',
        replyRequired: mentionsOf(msg.text, member).length > 0,
      }));

      const nextCursor = items.length ? items[items.length - 1].seq : cursor;
      sendJson(res, 200, {
        updates,
        nextCursor,
        hasMore,
        serverTime: Date.now(),
      });
    },
    { auth: 'channel' },
  );

  // ── 发送消息（幂等）──────────────────────────────────────────────
  router.post(
    '/v1/messages',
    async (req, res, url, identity) => {
      requireScope(identity, 'write');
      const channel = channelOf(identity);
      const member = channel.member;

      const body = await readJson(req, 256 * 1024);
      const chatId = String(body.chatId || '').trim();
      const text = String(body.text || '').trim();
      if (!chatId) throw badRequest('缺少 chatId');
      if (!text) throw badRequest('消息内容为空');
      if (text.length > cfg.maxTextLength) throw badRequest('消息过长');
      assertMemberInChat(member, chatId);

      const clientMsgId = body.clientMsgId ? String(body.clientMsgId).slice(0, 128) : null;
      if (clientMsgId) {
        const dup = store.getMessageByClientId(member, clientMsgId);
        if (dup) return sendJson(res, 200, { message: serialize(dup, member), duplicate: true });
      }

      const msg = store.insertMessage({
        chatId,
        sender: member,
        text,
        clientId: clientMsgId,
        replyTo: body.replyTo ? String(body.replyTo) : null,
        meta: { via: 'v1', channelId: channel.id },
      });
      store.touchChat(chatId);
      hub.emit('change', { type: 'message', chatId });

      sendJson(res, 201, { message: serialize(msg, member) });
    },
    { auth: 'channel' },
  );

  // ── 推进游标 ─────────────────────────────────────────────────────
  router.post(
    '/v1/updates/ack',
    async (req, res, url, identity) => {
      const channel = channelOf(identity);
      const body = await readJson(req, 64 * 1024);
      const chatId = String(body.chat || '').trim();
      const cursor = Number(body.cursor);
      if (!chatId) throw badRequest('缺少 chat');
      if (!Number.isFinite(cursor) || cursor < 0) throw badRequest('cursor 非法');
      assertMemberInChat(channel.member, chatId);
      store.setChannelCursor(channel.id, chatId, cursor);
      sendJson(res, 200, { ok: true, chat: chatId, cursor });
    },
    { auth: 'channel' },
  );

  // ── 配额 / 背压 ──────────────────────────────────────────────────
  router.get(
    '/v1/quota',
    (req, res, url, identity) => {
      const channel = channelOf(identity);
      const pending = store.listJobs({ handle: channel.member, status: 'pending', limit: 1000 }).length;
      sendJson(res, 200, {
        pending,
        oldestPendingAt: null,
        dropped: { count: 0, oldestAt: null },
        limits: { maxTextLength: cfg.maxTextLength, maxWaitSeconds: cfg.inboxWaitMax },
      });
    },
    { auth: 'channel' },
  );

  // ── 渠道管理（主人）─────────────────────────────────────────────
  router.post(
    '/api/admin/channels',
    async (req, res) => {
      const body = await readJson(req, 16 * 1024);
      const member = String(body.member || '').trim();
      if (!member) throw badRequest('缺少 member');
      const { channel, token } = ctx.channels.create({
        member,
        name: body.name,
        scopes: body.scopes,
      });
      sendJson(res, 200, { channel, token });
    },
    { auth: 'owner' },
  );

  router.get(
    '/api/admin/channels',
    (req, res, url) => {
      const member = url.searchParams.get('member') || null;
      sendJson(res, 200, { channels: ctx.channels.list(member) });
    },
    { auth: 'owner' },
  );

  router.delete(
    /^\/api\/admin\/channels\/([^/]+)$/,
    (req, res, url, identity, id) => {
      sendJson(res, 200, { channel: ctx.channels.revoke(id) });
    },
    { auth: 'owner' },
  );
}
