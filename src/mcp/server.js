import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { AppError } from '../errors.js';
import { createMcpAuth } from './auth.js';
import { createTools } from './tools.js';
import { createMcpTransport, createSessionStore } from './transport.js';
import { RPC_ERROR, negotiateProtocolVersion, rpcError, rpcResult, serverInfo } from './protocol.js';

/**
 * MCP 服务端（streamable HTTP）。
 *
 * 拆成两层，是为了「挂载」和「独立进程」两种用法共用同一套协议实现：
 *
 *   createMcpHandler({ ctx })  → 一个 (req, res) 处理函数 + 路径 + 会话表
 *                                主服务用它挂到自己的 http server 上（见 mount.js）
 *   createMcpServer({ ctx })   → 把 handler 包进独立的 http.Server
 *                                适合单独起进程：`node src/mcp/server.js`
 *
 * 与主服务的关系：共用同一个 Store / Members / Memory，不复制存储。
 * 发消息走 ctx.deliver（落库 → 建投递任务 → 唤醒），和浏览器那边是同一条管线。
 */

const DEFAULT_MCP_PORT = 8100;
const log = logger.child('mcp');

/** 给「协议层失败」用的异常：带 JSON-RPC 错误码，由传输层翻成错误响应。 */
function rpcFault(code, message, data) {
  const err = new Error(message);
  err.rpcCode = code;
  if (data !== undefined) err.rpcData = data;
  return err;
}

/**
 * 构造 MCP 协议处理函数（不监听端口）。
 * @returns {{path:string, handle:Function, sessions:object, tools:Array, auth:object, dispatch:Function, close:Function}}
 */
export function createMcpHandler({ ctx, config = {} } = {}) {
  if (!ctx?.store || !ctx?.members) {
    throw new Error('createMcpHandler 需要 createApp() 产出的 ctx（含 store 与 members）');
  }

  const cfg = { ...(ctx.cfg || {}), ...config };
  const endpointPath = cfg.mcpPath || '/mcp';

  const auth = createMcpAuth({ config: cfg, members: ctx.members, store: ctx.store });
  const tools = createTools({ ctx, auth });
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const sessions = createSessionStore();
  const info = serverInfo(ctx.version);

  /** 对外暴露的工具描述：不把内部 handler 泄给客户端。 */
  function publicTool(t) {
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    };
  }

  /**
   * tools/call。
   *
   * 两种失败必须分开：
   * - 工具名/参数形状不对 → JSON-RPC 错误（-32602），这是「报文有问题」；
   * - 工具执行失败（越权、会话不存在、内容过长）→ result.isError = true，
   *   这是「调用成功，但结果是错误」，客户端据此把错误喂回模型而不是中断会话。
   */
  async function callTool(id, params, identity) {
    const name = params?.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw rpcFault(RPC_ERROR.invalidParams, '缺少工具名 name');
    }
    const tool = toolMap.get(name);
    if (!tool) {
      throw rpcFault(RPC_ERROR.invalidParams, `未知工具：${name}`, { available: [...toolMap.keys()] });
    }
    const args = params?.arguments ?? {};
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw rpcFault(RPC_ERROR.invalidParams, 'arguments 必须是对象');
    }

    try {
      const value = await tool.handler(args, { identity });
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
        isError: false,
      });
    } catch (e) {
      if (e instanceof AppError) {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ code: e.code, message: e.message }) }],
          isError: true,
        });
      }
      throw e;
    }
  }

  /** 把一条 JSON-RPC 报文变成响应。通知由传输层识别，这里只处理请求。 */
  async function dispatch(msg, { identity }) {
    const id = msg.id ?? null;
    const params = msg.params || {};

    switch (msg.method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          instructions:
            '围炉 MCP 端点：用 campfire_list_chats 找会话、campfire_read_messages 读消息、campfire_send_message 发言。' +
            'MCP 只做请求-响应，不会主动唤醒；需要「有人说话就响应」请接 Channel API 的投递流。',
        });

      case 'ping':
        return rpcResult(id, {});

      // 新版客户端（如 DSH 的 MCP SDK 2.2）连上来第一发是能力探测，不是 initialize。
      // 回 -32601 等于告诉它「我没有 discover 能力」，它会自动回退到 initialize；
      // 回 5xx 或 401 则会被判定为服务端坏了，连接直接失败。
      case 'server/discover':
        throw rpcFault(RPC_ERROR.methodNotFound, '不支持 server/discover，请用 initialize 握手');

      case 'tools/list':
        return rpcResult(id, { tools: tools.map(publicTool) });

      case 'tools/call':
        return callTool(id, params, identity);

      default:
        throw rpcFault(RPC_ERROR.methodNotFound, `未实现的方法：${msg.method}`);
    }
  }

  const handle = createMcpTransport({
    path: endpointPath,
    basePath: cfg.basePath || '',
    auth,
    sessions,
    dispatch,
    log,
  });

  return {
    path: endpointPath,
    handle,
    sessions,
    tools,
    auth,
    dispatch,
    close() {
      sessions.close();
    },
  };
}

/** 把 handler 包成一个独立监听的 http 服务（独立进程模式）。 */
export function createMcpServer({ ctx, config = {} } = {}) {
  const cfg = { ...(ctx?.cfg || {}), ...config };
  const handler = createMcpHandler({ ctx, config });
  const host = cfg.mcpHost || cfg.host || '127.0.0.1';
  const port = Number.isFinite(cfg.mcpPort) ? cfg.mcpPort : DEFAULT_MCP_PORT;

  const server = http.createServer((req, res) => {
    handler.handle(req, res).catch((e) => {
      log.error('MCP 请求处理异常', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(rpcError(null, RPC_ERROR.internalError, '服务内部错误')));
      } else {
        res.end();
      }
    });
  });

  // 与主服务同样的取舍：keep-alive 要够长，否则客户端复用连接会撞上已关闭的套接字
  server.keepAliveTimeout = Math.max(cfg.keepAliveMs || 70_000, 30_000);
  server.headersTimeout = server.keepAliveTimeout + 5_000;

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    log.info(`MCP 端点 http://${host}:${actualPort}${cfg.basePath || ''}${handler.path}`);
    log.info(`工具 ${handler.tools.length} 个：${handler.tools.map((t) => t.name).join(', ')}`);
    return { port: actualPort, path: handler.path };
  }

  async function stop() {
    handler.close();
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  return { server, start, stop, handle: handler.handle, ...handler };
}

// 直接运行：node src/mcp/server.js
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [{ createApp }, { ensureOwnerKey }] = await Promise.all([
    import('../server.js'),
    import('../config.js'),
  ]);

  const app = createApp();
  // 主服务还没启动过时口令可能尚未生成，这里补上，否则主人令牌无从校验
  ensureOwnerKey(app.cfg);

  const mcp = createMcpServer({
    ctx: app.ctx,
    config: {
      mcpPort: Number.parseInt(process.env.MCP_PORT || '', 10) || DEFAULT_MCP_PORT,
      mcpHost: process.env.MCP_HOST || app.cfg.host,
      mcpPath: process.env.MCP_PATH || '/mcp',
    },
  });

  await mcp.start();
  log.info('令牌：主人用 OWNER_PASSWORD（或 data/owner-key.txt 里那串）；成员用 <handle>:<成员密钥>');

  const shutdown = async (signal) => {
    log.info(`收到 ${signal}，MCP 服务退出`);
    await mcp.stop();
    app.ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝', e));
}
