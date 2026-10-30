/**
 * 把 MCP 挂到主 HTTP 服务上。
 *
 * 主服务只需要两行：
 *   import { registerMcpRoutes } from './mcp/mount.js';
 *   registerMcpRoutes(router, ctx);
 *
 * 之所以走 Router 而不是在主 handler 里加分支：
 * 主 handler 只把 `/api/` 开头的路径交给路由表，把端点放在 `/api/mcp`
 * 就能沿用既有的匹配与错误处理，不必改动 server.js 的请求流程——
 * M2 的目录边界是 `src/mcp/**`，对 `src/server.js` 的改动越少，
 * 和 M1/M4 抢同一个文件的概率越低（docs/LAYOUT.md §4）。
 *
 * 注意：这里注册的路由**不走** opts.auth。MCP 客户端没有浏览器 Cookie，
 * 用的是自己的 `Authorization: Bearer`，鉴权在 src/mcp/auth.js 里做。
 * 若让主服务的 auth 先拦一道，MCP 客户端永远进不来。
 */

import { createMcpHandler } from './server.js';

export function registerMcpRoutes(router, ctx, config = {}) {
  const handler = createMcpHandler({
    ctx,
    config: { mcpPath: '/api/mcp', ...config },
  });

  // 三个方法都要注册：POST 收发报文，GET 明确拒绝（405），DELETE 结束会话
  for (const method of ['POST', 'GET', 'DELETE']) {
    router.add(method, handler.path, (req, res) => handler.handle(req, res), {});
  }

  ctx.mcp = handler;
  return handler;
}
