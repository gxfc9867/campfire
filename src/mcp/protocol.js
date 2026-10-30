/**
 * MCP 的 JSON-RPC 2.0 词汇表。
 *
 * 这里只放「协议本身要求的东西」：版本号、错误码、报文构造函数。
 * 不放任何业务逻辑——业务在 tools.js，传输在 transport.js。
 *
 * 为什么自己写而不引 @modelcontextprotocol/sdk：
 * 整个项目的卖点是零 npm 依赖（见 README「一个 Node 进程，零依赖」），
 * 而 MCP 的线上协议就是 JSON-RPC 2.0 加几条约定的头部，手写比引一个
 * 会随版本变动的 SDK 更稳，也让「协议长什么样」在代码里一眼可见。
 */

/**
 * 支持协商的协议版本，从新到旧。
 *
 * MCP 的版本是日期号，服务端要能同时吃下老客户端：
 * 客户端在 initialize 里报它自己的版本，服务端只回「我也支持的最新那个」，
 * 双方各退一步用交集里的最新版。只认一个版本会让老客户端直接连不上。
 *
 * 2025-11-25 放在最前是有实测依据的：DSH 用的 MCP SDK 2.2.0 会 offer 这个版本，
 * 并且只接受它自己列表里的版本号，回错版本号直接握手失败。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** 服务端默认（也是最新）的协议版本。 */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * JSON-RPC 2.0 标准错误码 + MCP 约定的服务端错误码。
 *
 * 分界线：
 * - -327xx 是 JSON-RPC 规范定的，客户端库普遍认识；
 * - -320xx 是「协议层之外的失败」，MCP 用它们表达鉴权/授权这类语义。
 *   工具执行失败**不**走这里——那属于「调用成功但结果是个错误」，
 *   用 result.isError 表达（见 server.js 的 tools/call）。
 */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unauthorized: -32001,
  forbidden: -32003,
};

/** 构造一条成功响应。id 必须原样回带，否则客户端配不上号。 */
export function rpcResult(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

/** 构造一条错误响应。data 可选，只放对排查有用的东西。 */
export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** 带 id 的是请求，客户端等一个响应。 */
export function isRequest(msg) {
  return Boolean(msg) && typeof msg === 'object' && typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null;
}

/**
 * 不带 id 的是通知，服务端不该回任何报文。
 * 注意 id 为 0 或空串是合法的请求 id，所以只能判「有没有这个键」，
 * 不能写成 `!msg.id`——那会把 id=0 当成通知，客户端永远等不到响应。
 */
export function isNotification(msg) {
  return Boolean(msg) && typeof msg === 'object' && typeof msg.method === 'string' && (msg.id === undefined || msg.id === null);
}

/** 客户端发来的响应报文（本服务端不用，但收到要能识别并忽略而不是当成请求）。 */
export function isResponse(msg) {
  return Boolean(msg) && typeof msg === 'object' && typeof msg.method !== 'string' && ('result' in msg || 'error' in msg);
}

/**
 * 协商协议版本。
 * 客户端报的版本我们认识就用它（双方都支持），否则回我们最新的那个，
 * 由客户端决定要不要继续——这是规范里写的降级方式。
 */
export function negotiateProtocolVersion(requested) {
  const v = String(requested || '').trim();
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(v)) return v;
  return LATEST_PROTOCOL_VERSION;
}

/** 服务端自称。名字固定，版本跟项目走。 */
export function serverInfo(version) {
  return { name: 'campfire', title: '围炉', version: String(version || '0.0.0') };
}
