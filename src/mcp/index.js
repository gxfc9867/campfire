/**
 * MCP 面的入口。
 *
 * 对外只需要一个函数：createMcpServer({ ctx })。
 * 其余模块（protocol / auth / tools / transport）是它的四块拼图，
 * 单独导出是为了测试能直接打靶，不必每次起完整服务。
 */
export { createMcpServer, createMcpHandler } from './server.js';
export { registerMcpRoutes } from './mount.js';
export { createMcpTransport, createSessionStore } from './transport.js';
export { createMcpAuth } from './auth.js';
export { createTools } from './tools.js';
export {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  RPC_ERROR,
  negotiateProtocolVersion,
} from './protocol.js';
