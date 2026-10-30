import { SENDER } from '../constants.js';
import { badRequest, forbidden, notFound } from '../errors.js';

/**
 * MCP 工具集。
 *
 * 设计原则：
 * 1. **不复制业务逻辑**。发消息直接调 `ctx.deliver`——它已经处理了「先落库、
 *    再建投递任务、最后叫醒长轮询」的顺序，MCP 面另写一套必然和 UI 面行为分叉。
 * 2. **返回结构与 docs/design/CONNECTION-DRAFT.md §2 的消息模型对齐**，
 *    客户端不必为 MCP 面单独写一套解析。
 * 3. **只读为主**。M2 里唯一会写库的工具是 send_message，且写前必过归属校验。
 * 4. 工具执行失败（越权、会话不存在、参数不合法）不抛到协议层，
 *    统一转成 `isError: true` 的结果——这是 MCP 的约定：调用成功，结果是错误。
 */

/** 预览用的截断长度：列表和摘要里只放这么多，避免一次工具调用把上下文撑爆。 */
const PREVIEW_CHARS = 120;
const SUMMARY_CHARS = 200;

function clip(text, max = PREVIEW_CHARS) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function requireString(args, key, { max = 32_000 } = {}) {
  const v = args?.[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`参数 ${key} 必须是非空字符串`);
  const s = v.trim();
  if (s.length > max) throw badRequest(`参数 ${key} 过长（上限 ${max} 字符）`);
  return s;
}

function optionalString(args, key, { max = 200 } = {}) {
  const v = args?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw badRequest(`参数 ${key} 必须是字符串`);
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > max) throw badRequest(`参数 ${key} 过长（上限 ${max} 字符）`);
  return s;
}

function optionalInt(args, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = args?.[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`参数 ${key} 必须是整数`);
  if (n < min || n > max) throw badRequest(`参数 ${key} 超出范围（${min}~${max}）`);
  return n;
}

export function createTools({ ctx, auth }) {
  const { store, members, cfg } = ctx;

  /** 把库里的消息行翻成对外契约里的形状（sender 是对象，不是裸字符串）。 */
  function messageView(m) {
    const kind = m.sender === SENDER.user ? 'user' : m.sender === SENDER.system ? 'system' : 'member';
    const display =
      kind === 'user' ? '主人' : kind === 'system' ? '系统' : members.get(m.sender)?.display || m.sender;
    return {
      id: m.id,
      chatId: m.chatId,
      seq: m.seq,
      sender: { kind, handle: m.sender, display },
      type: 'text',
      text: m.text,
      replyTo: m.replyTo || null,
      createdAt: m.createdAt,
      // 编辑/删除目前只有布尔标记：M1 的 update 日志落地后才会有精确时间戳
      edited: Boolean(m.meta?.edited),
      deleted: Boolean(m.meta?.deleted),
    };
  }

  function chatView(c, unread) {
    const last = store.lastMessageOf(c.id);
    const peer = c.kind === 'dm' && c.peer ? members.get(c.peer) : null;
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      peer: c.peer || null,
      peerDisplay: peer?.display || null,
      members: store.listMembersOf(c.id),
      messageCount: store.countMessages(c.id),
      unread,
      last: last
        ? { seq: last.seq, sender: last.sender, text: clip(last.text), createdAt: last.createdAt }
        : null,
      updatedAt: c.updatedAt,
    };
  }

  // ── 工具实现 ────────────────────────────────────────────────────────

  function listChats(args, { identity }) {
    const unread = store.unreadCounts();
    const chats = store
      .listChats()
      .filter((c) => auth.canAccess(identity, c.id))
      // 未读数是「主人视角」的概念（成员自己发的也算未读），对成员身份不适用
      .map((c) => chatView(c, identity.kind === 'owner' ? unread[c.id] || 0 : null));
    return { chats, count: chats.length };
  }

  function readMessages(args, { identity }) {
    const chatId = requireString(args, 'chatId', { max: 40 });
    const chat = store.getChat(chatId);
    if (!chat) throw notFound('会话不存在');
    if (!auth.canAccess(identity, chatId)) throw forbidden('无权读取该会话');

    const limit = optionalInt(args, 'limit', { min: 1, max: 200 }) ?? 50;
    const after = optionalInt(args, 'cursor', { min: 0 });
    const before = optionalInt(args, 'before', { min: 0 });

    // store.listMessages 同时给 after 和 before 时以 after 为准，这里显式只传一个，
    // 免得调用方以为两个都给会取交集
    const { items, hasMore } = store.listMessages({
      chatId,
      after: after === 0 ? undefined : after,
      before: after ? undefined : before,
      limit,
    });

    const messages = items.map(messageView);
    let nextCursor;
    if (after) {
      // 追新方向：下一页从这一页最后一条之后开始
      nextCursor = messages.length ? messages[messages.length - 1].seq : after;
    } else {
      // 翻历史方向：下一页从这一页最旧一条之前开始
      nextCursor = messages.length ? messages[0].seq : before || 0;
    }

    return {
      chatId,
      chatName: chat.name,
      messages,
      nextCursor,
      hasMore,
      direction: after ? 'forward' : before ? 'backward' : 'latest',
    };
  }

  async function sendMessage(args, { identity }) {
    const chatId = requireString(args, 'chatId', { max: 40 });
    const text = requireString(args, 'text', { max: cfg.maxTextLength });
    if (Array.isArray(args?.attachments) && args.attachments.length) {
      throw badRequest('M2 暂不支持附件，请只发文本', 'unsupported_type');
    }

    const chat = store.getChat(chatId);
    if (!chat) throw notFound('会话不存在');
    if (!auth.canAccess(identity, chatId)) throw forbidden('无权在该会话发言');

    const replyTo = optionalString(args, 'replyTo', { max: 40 });
    if (replyTo) {
      const quoted = store.getMessage(replyTo);
      // 引用只在同一会话内有意义；跨会话引用等于把 A 群的话塞进 B 群的上下文
      if (!quoted || quoted.chatId !== chatId) throw badRequest('replyTo 指向的消息不在该会话里');
    }

    const targets = Array.isArray(args?.targets) ? args.targets.map((h) => String(h)) : undefined;
    const sender = identity.kind === 'owner' ? SENDER.user : identity.handle;

    // 走既有的投递管线：落库 → 建投递任务 → 唤醒，一步都不能少
    const { message, jobs } = await ctx.deliver({
      chatId,
      sender,
      text,
      clientId: optionalString(args, 'clientMsgId', { max: 80 }),
      explicitTargets: targets,
      replyTo: replyTo || null,
    });

    return {
      message: messageView(message),
      deliveries: jobs.map((j) => ({ id: j.id, handle: j.handle, status: j.status })),
    };
  }

  function searchMemory(args, { identity }) {
    const query = requireString(args, 'query', { max: 500 });
    const chatId = optionalString(args, 'chatId', { max: 40 });
    if (chatId && !auth.canAccess(identity, chatId)) throw forbidden('无权检索该会话');
    return {
      query,
      chatId: chatId || null,
      k: optionalInt(args, 'k', { min: 1, max: 50 }) ?? 10,
      hits: [],
      implemented: false,
      // 明确说「还没做」，比返回一堆假命中更诚实——客户端可以据此降级到 read_messages
      note: '向量 + 关键词混合检索在 M5 实现，当前为空实现（返回 0 条命中）',
    };
  }

  function getSummary(args, { identity }) {
    const chatId = requireString(args, 'chatId', { max: 40 });
    const chat = store.getChat(chatId);
    if (!chat) throw notFound('会话不存在');
    if (!auth.canAccess(identity, chatId)) throw forbidden('无权读取该会话');

    const since = optionalInt(args, 'since', { min: 0 });
    const limit = optionalInt(args, 'limit', { min: 1, max: 100 }) ?? 30;
    const { items } = store.listMessages({ chatId, after: since === 0 ? undefined : since, limit });

    // 参与人统计：谁在这个窗口里说过话、各说了几条
    const tally = new Map();
    for (const m of items) {
      const view = messageView(m);
      const key = view.sender.handle;
      const prev = tally.get(key) || { ...view.sender, count: 0 };
      prev.count += 1;
      tally.set(key, prev);
    }

    const fromSeq = items.length ? items[0].seq : since ?? 0;
    const toSeq = items.length ? items[items.length - 1].seq : since ?? 0;

    return {
      chatId,
      chatName: chat.name,
      fromSeq,
      toSeq,
      messageCount: items.length,
      participants: [...tally.values()].sort((a, b) => b.count - a.count),
      // 只给最近几条的原文摘取，供客户端自己拼上下文；模型生成的滚动摘要留到 M5
      recent: items.slice(-10).map((m) => {
        const view = messageView(m);
        return {
          seq: view.seq,
          sender: view.sender.display,
          text: clip(view.text, SUMMARY_CHARS),
          createdAt: view.createdAt,
        };
      }),
      summary: null,
      implemented: false,
      note: '滚动摘要（模型生成）在 M5 实现，当前返回窗口内的原文摘取',
    };
  }

  // ── 工具清单 ────────────────────────────────────────────────────────
  // description 会原样进模型的工具列表，所以写「什么时候该用」而不是「函数做什么」

  return [
    {
      name: 'campfire_list_chats',
      title: '列出会话',
      description: '列出围炉里的会话（群聊与单聊），带未读数、成员和最后一条消息。想知道「现在有哪些群、哪些没读」时先调它。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: listChats,
    },
    {
      name: 'campfire_read_messages',
      title: '读消息',
      description:
        '读某个会话的消息。cursor 用于追新（读 seq 之后的新消息），before 用于往前翻历史；都不给则取最新一页。返回 nextCursor 供下次续读。',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: '会话 id，例如 main' },
          cursor: { type: 'integer', minimum: 0, description: '从这个 seq 之后开始读（追新）' },
          before: { type: 'integer', minimum: 0, description: '读这个 seq 之前的历史（翻旧），与 cursor 互斥' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 50' },
        },
        required: ['chatId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: readMessages,
    },
    {
      name: 'campfire_send_message',
      title: '发言',
      description:
        '在会话里发一条文本消息，按 @ 提及或 targets 投递给成员。replyTo 可引用同会话内的某条消息。受身份限制：成员只能在自己所在的会话发言。',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: '会话 id' },
          text: { type: 'string', minLength: 1, description: '消息正文；用 @handle 提及成员' },
          replyTo: { type: 'string', description: '被引用消息的 id，必须在同一会话内' },
          clientMsgId: { type: 'string', description: '幂等键：同一发送者重复提交只落一条' },
          targets: {
            type: 'array',
            items: { type: 'string' },
            description: '显式收件人 handle 列表；省略则按正文里的 @ 提及投递',
          },
        },
        required: ['chatId', 'text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      handler: sendMessage,
    },
    {
      name: 'campfire_search_memory',
      title: '检索记忆',
      description:
        '在会话历史与成员记忆里做检索（向量 + 关键词混合）。M2 为空实现，恒返回 0 条命中；需要内容请改用 campfire_read_messages。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: '检索词' },
          chatId: { type: 'string', description: '限定会话；省略则检索全部可访问范围' },
          k: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条，默认 10' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: searchMemory,
    },
    {
      name: 'campfire_get_summary',
      title: '会话摘要',
      description:
        '取某个会话的滚动摘要快照：消息数、参与人、最近几条原文。since 指定起始 seq，省略则取最近 limit 条。M2 返回原文摘取，模型摘要留到 M5。',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: '会话 id' },
          since: { type: 'integer', minimum: 0, description: '从这个 seq 之后开始统计；省略则取最近 limit 条' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '统计窗口内的最大消息数，默认 30' },
        },
        required: ['chatId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: getSummary,
    },
  ];
}
