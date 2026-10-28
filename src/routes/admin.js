import { MEMBER_STATE, DRIVER, AVATAR_PRESET_COUNT } from '../constants.js';
import { badRequest, notFound, tooMany } from '../errors.js';
import { readJson, sendJson, clientIp, createLimiter } from '../http/util.js';
import { publicView } from '../members.js';

/**
 * 管理侧接口：登录、健康检查、成员管理、任务面板。
 * 除 /api/health 与 /api/login 外都要求主人身份。
 */
export function registerAdminRoutes(router, ctx) {
  const { cfg, store, members, memory, presence, waiters, hub, auth, planner } = ctx;
  const log = ctx.log;

  // 登录尝试限流：口令是本项目唯一的入口，必须挡住暴力猜解
  const loginLimiter = createLimiter({ limit: 8, windowMs: 5 * 60_000 });

  router.post('/api/login', async (req, res, url, identity) => {
    if (loginLimiter(clientIp(req, cfg))) {
      throw tooMany('尝试次数过多，请 5 分钟后再试');
    }
    const body = await readJson(req, 4096);
    const token = auth.login(body.password);
    if (!token) throw badRequest('口令不正确', 'bad_password');
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.cookieHeader(token) });
  });

  router.post('/api/logout', async (req, res, url, identity) => {
    const t = identity?.token;
    auth.logout(t);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
  });

  router.get('/api/me', (req, res, url, identity) => {
    sendJson(res, 200, {
      kind: identity.kind,
      isOwner: identity.kind === 'owner',
      member: identity.member || null,
    });
  });

  // 健康检查免鉴权：容器编排和监控探针需要它，且它不泄露任何业务数据
  router.get('/api/health', (req, res) => {
    sendJson(res, 200, {
      ok: true,
      version: ctx.version,
      uptime: Math.floor(process.uptime()),
      polls: waiters.count(),
      clients: hub.count(),
      members: members.list().length,
    });
  });

  router.get(
    '/api/status',
    (req, res, url) => {
      const chatId = url.searchParams.get('chat') || '';
      const allowed = chatId ? new Set(store.listMembersOf(chatId)) : null;

      const list = members
        .list()
        .filter((m) => !allowed || allowed.has(m.handle))
        .map((m) => {
          const p = presence.snapshot(m.handle, m.driver.type);
          const mem = memory.meta(m.handle);
          return {
            handle: m.handle,
            display: m.display,
            avatar: m.avatar,
            avatarSalt: m.avatarSalt,
            persona: m.persona.slice(0, 200),
            driverType: m.driver.type,
            chats: m.chats,
            presence: p,
            memory: mem,
            // 三态由服务端算好，前端不再重复推导，避免两处逻辑漂移
            online: p.ready ? 'ready' : p.reachable ? 'wakeable' : 'offline',
          };
        });

      sendJson(res, 200, {
        members: list,
        counts: {
          members: list.length,
          polls: waiters.count(),
          clients: hub.count(),
          ...presence.counts(),
        },
      });
    },
    { auth: 'owner' },
  );

  // ── 成员管理 ────────────────────────────────────────────────────────

  router.get(
    '/api/members',
    (req, res) => {
      const includeArchived = false;
      const list = members.list({ includeArchived }).map((m) => ({
        ...publicView(m),
        presence: presence.snapshot(m.handle, m.driver.type),
        memory: memory.meta(m.handle),
      }));
      sendJson(res, 200, { members: list, etag: members.etag() });
    },
    { auth: 'owner' },
  );

  router.post(
    '/api/members',
    async (req, res) => {
      const body = await readJson(req, 64 * 1024);
      const created = members.upsert(body, body.etag);
      // 归属关系落到库里，侧栏与 @ 解析都依赖它
      store.setMemberChats(created.handle, created.chats);
      for (const chatId of created.chats) {
        if (!store.getChat(chatId)) store.ensureChat(chatId, chatId);
      }
      hub.emit('change', { type: 'members' });
      log.info(`新成员 ${created.handle}（${created.driver.type}）`);
      // 密钥只在创建时明文返回一次，之后列表里都是掩码
      sendJson(res, 200, { member: publicView(created), key: created.key, etag: members.etag() });
    },
    { auth: 'owner' },
  );

  router.get(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})$/,
    (req, res, url, identity, handle) => {
      const m = members.get(handle);
      if (!m) throw notFound('成员不存在');
      const reveal = url.searchParams.get('reveal') === '1';
      sendJson(res, 200, {
        member: {
          ...publicView(m),
          presence: presence.snapshot(m.handle, m.driver.type),
          memory: memory.meta(m.handle),
          digest: memory.read(m.handle).digest,
        },
        // 自托管单人系统，主人需要明文密钥来配置 sidecar，因此支持显式取回
        key: reveal ? m.key : undefined,
        etag: members.etag(),
      });
    },
    { auth: 'owner' },
  );

  router.patch(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})$/,
    async (req, res, url, identity, handle) => {
      const body = await readJson(req, 64 * 1024);
      const etag = body.etag || req.headers['if-match'] || '';
      const updated = members.upsert({ ...body, handle }, etag);
      store.setMemberChats(updated.handle, updated.chats);
      for (const chatId of updated.chats) {
        if (!store.getChat(chatId)) store.ensureChat(chatId, chatId);
      }
      hub.emit('change', { type: 'members' });
      sendJson(res, 200, { member: publicView(updated), etag: members.etag() });
    },
    { auth: 'owner' },
  );

  router.delete(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})$/,
    async (req, res, url, identity, handle) => {
      const etag = req.headers['if-match'] || '';
      members.archive(handle, etag);
      // 归属关系一并撤掉，历史消息保留（sender 仍指向这个 handle）
      store.setMemberChats(handle, []);
      hub.emit('change', { type: 'members' });
      sendJson(res, 200, { ok: true, etag: members.etag() });
    },
    { auth: 'owner' },
  );

  router.post(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})\/restore$/,
    (req, res, url, identity, handle) => {
      const m = members.restore(handle);
      store.setMemberChats(m.handle, m.chats);
      hub.emit('change', { type: 'members' });
      sendJson(res, 200, { member: publicView(m), etag: members.etag() });
    },
    { auth: 'owner' },
  );

  router.post(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})\/rotate$/,
    (req, res, url, identity, handle) => {
      const key = members.rotateKey(handle);
      sendJson(res, 200, { handle, key });
    },
    { auth: 'owner' },
  );

  /** 主人直接改成员记忆摘要（成员自己也能通过 PUT /api/agent/memory 改）。 */
  router.put(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})\/memory$/,
    async (req, res, url, identity, handle) => {
      if (!members.get(handle)) throw notFound('成员不存在');
      const body = await readJson(req, 64 * 1024);
      const saved = memory.write(handle, body.digest ?? '');
      hub.emit('change', { type: 'memory', handle });
      sendJson(res, 200, { ok: true, ...saved });
    },
    { auth: 'owner' },
  );

  /** 测试按钮的「桥侧检查」：只验证密钥与通道，不真的拉起进程。 */
  router.post(
    /^\/api\/members\/([a-z][a-z0-9_-]{0,31})\/probe$/,
    (req, res, url, identity, handle) => {
      const m = members.get(handle);
      if (!m) throw notFound('成员不存在');
      const p = presence.snapshot(handle, m.driver.type);
      const decision = planner.decide(handle);
      sendJson(res, 200, {
        handle,
        driverType: m.driver.type,
        reachable: p.reachable,
        ready: p.ready,
        state: p.state,
        lastSeenAt: p.lastSeenAt,
        polls: waiters.count(),
        decision,
        hint:
          m.driver.type === DRIVER.cli
            ? p.reachable
              ? 'sidecar 在线，可以下发唤醒'
              : 'sidecar 未连接：检查 sidecar 是否启动、桥地址与密钥是否正确'
            : '该成员由自己主动拉取，桥不负责唤醒',
      });
    },
    { auth: 'owner' },
  );

  router.get(
    '/api/avatars',
    (req, res) => {
      const presets = Array.from({ length: AVATAR_PRESET_COUNT }, (_, i) => {
        const n = String(i + 1).padStart(2, '0');
        return { id: `preset:${n}`, url: `${cfg.basePath}/avatars/preset-${n}.svg` };
      });
      sendJson(res, 200, { presets, initial: 'initial' });
    },
    { auth: 'owner' },
  );

  // ── 任务面板 ────────────────────────────────────────────────────────

  router.get(
    '/api/jobs',
    (req, res, url) => {
      const chatId = url.searchParams.get('chat') || '';
      const limit = Number(url.searchParams.get('limit') || 50);
      const jobs = store.listJobs({ chatId: chatId || undefined, limit });
      sendJson(res, 200, { jobs, stats: store.jobStats() });
    },
    { auth: 'owner' },
  );
}
