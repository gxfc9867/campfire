import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import baseConfig, { announceOwnerKey, ensureOwnerKey, resolvePaths, ROOT } from './config.js';
import { logger } from './logger.js';
import { Store } from './store.js';
import { Members } from './members.js';
import { Memory } from './memory.js';
import { Presence } from './presence.js';
import { InboxWaiters } from './outbox.js';
import { EventHub } from './http/sse.js';
import { Auth } from './http/auth.js';
import { Router } from './http/router.js';
import { WakePlanner } from './wake.js';
import { serverError, notFound, unauthorized } from './errors.js';
import { sendError, sendText } from './http/util.js';
import { serveStatic } from './http/static.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMessageRoutes, startJobSweeper } from './routes/messages.js';
import { registerMemberRoutes } from './routes/member-api.js';

const log = logger.child('server');

/**
 * 组装应用。
 *
 * 依赖自下而上单向流动：
 *   config → store / members / memory / presence / outbox / hub → auth → planner → router
 * 没有任何模块反向依赖 server，因此每一层都能单独构造与测试。
 */
export function createApp(overrides = {}) {
  const cfg = { ...baseConfig, ...(overrides.config || {}) };
  // 覆盖了数据目录就重算路径，否则测试会把数据写进正式目录
  if (overrides.config?.dataDir) cfg.paths = resolvePaths(cfg.dataDir);

  const store = new Store(cfg.dataDir);
  const members = new Members({ file: cfg.paths.members, config: cfg });
  const memory = new Memory({ dir: cfg.paths.memoryDir });
  const presence = new Presence({ config: cfg });
  const waiters = new InboxWaiters({ max: cfg.maxPolls });
  const hub = new EventHub();
  const auth = new Auth({ config: cfg, members });

  const ctx = {
    cfg,
    store,
    members,
    memory,
    presence,
    waiters,
    hub,
    auth,
    log: logger.child('app'),
    version: readVersion(),
  };
  ctx.planner = new WakePlanner({ config: cfg, presence, members, logger: logger.child('wake') });

  const router = new Router();
  // 注册顺序无关，匹配器按方法+路径精确查找
  registerAdminRoutes(router, ctx);
  registerMessageRoutes(router, ctx);
  registerMemberRoutes(router, ctx);

  /** 首页需要注入 basePath，否则子路径部署时前端拼不出正确的 API 地址。 */
  function serveIndex(req, res) {
    const file = path.join(cfg.paths.publicDir, 'index.html');
    let html;
    try {
      html = fs.readFileSync(file, 'utf8').replaceAll('__BASE_PATH__', cfg.basePath || '');
    } catch {
      return sendText(res, 500, '前端资源缺失：public/index.html');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  async function handler(req, res) {
    const started = Date.now();
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      let pathname = url.pathname;

      // 子路径部署：剥掉前缀，之后所有路由都按根路径思考
      if (cfg.basePath) {
        if (pathname === cfg.basePath) {
          // 必须补上尾斜杠，否则页面里的相对路径会解析到上一级
          res.writeHead(301, { Location: `${cfg.basePath}/${url.search}` });
          return res.end();
        }
        if (!pathname.startsWith(`${cfg.basePath}/`)) throw notFound('路径不存在');
        pathname = pathname.slice(cfg.basePath.length);
      }

      if (!pathname.startsWith('/api/')) {
        if (pathname === '/' || pathname === '/index.html') return serveIndex(req, res);
        if (serveStatic(cfg.paths.publicDir, req, res, pathname)) return;
        return sendText(res, 404, 'not found');
      }

      const hit = router.match(req.method || 'GET', pathname);
      if (!hit) throw notFound('接口不存在');

      const identity = auth.identify(req);
      const need = hit.route.opts?.auth;
      if (need === 'owner' && identity.kind !== 'owner') {
        throw unauthorized('需要登录');
      }
      if (need === 'member') {
        if (identity.kind !== 'member') {
          throw unauthorized(identity.reason === 'bad_member_key' ? '成员密钥不正确' : '需要成员凭据');
        }
      }

      await hit.route.handler(req, res, url, identity, ...hit.params);
    } catch (err) {
      sendError(res, err);
    } finally {
      // 只记录慢请求与错误，避免日志被心跳刷屏
      const ms = Date.now() - started;
      if (ms > 1000) log.warn(`慢请求 ${req.method} ${req.url} ${ms}ms`);
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => sendError(res, serverError(e.message)));
  });

  /**
   * keep-alive 必须大于长轮询挂起时长。
   * Node 默认只有 5s，客户端在长轮询返回后复用同一条连接时会撞上已关闭的连接，
   * 表现为随机的 ECONNRESET——这是长轮询最经典的坑。
   */
  server.keepAliveTimeout = cfg.keepAliveMs;
  server.headersTimeout = cfg.keepAliveMs + 5000;
  // 长轮询期间不能因为「请求太久没完成」被服务端掐断
  server.requestTimeout = 0;

  let sweeper = null;
  let sweepTimer = null;

  async function start() {
    // 口令生成必须发生在任何请求进来之前；announce 在监听成功之后打一次
    ensureOwnerKey(cfg);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : cfg.port;

    announceOwnerKey(log);
    sweeper = startJobSweeper({ store, hub, log });
    sweepTimer = setInterval(() => presence.sweep(), 60_000);
    sweepTimer.unref?.();

    log.info(`围炉已启动 http://${cfg.host}:${actualPort}${cfg.basePath || ''}`);
    if (cfg.publicUrl) log.info(`对外地址 ${cfg.publicUrl}`);
    log.info(`成员 ${members.list().length} 位，会话 ${store.listChats().length} 个`);
    return { port: actualPort, basePath: cfg.basePath };
  }

  async function stop() {
    if (sweepTimer) clearInterval(sweepTimer);
    if (sweeper) sweeper();
    // 先放行挂起的长轮询，让它们走正常返回路径而不是被硬断
    waiters.closeAll();
    hub.closeAll();
    auth.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    log.info('已停止');
  }

  return { server, start, stop, ctx, cfg };
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// 直接运行：node src/server.js
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'src/server.js');
if (isMain) {
  const app = createApp();
  await app.start();

  const shutdown = async (signal) => {
    log.info(`收到 ${signal}，开始优雅退出`);
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝', e));
}
