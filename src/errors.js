/**
 * 业务错误。
 * 所有可预期的失败都抛 AppError，HTTP 层统一转成 JSON，避免把栈信息漏给客户端。
 */

export class AppError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code   稳定的机器可读错误码，前端按它分支
   * @param {string} message 可直接展示给人看的中文说明
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

export const badRequest = (msg, code = 'bad_request') => new AppError(400, code, msg);
export const unauthorized = (msg = '需要登录', code = 'unauthorized') => new AppError(401, code, msg);
export const forbidden = (msg = '无权访问', code = 'forbidden') => new AppError(403, code, msg);
export const notFound = (msg = '资源不存在', code = 'not_found') => new AppError(404, code, msg);
export const conflict = (msg, code = 'conflict') => new AppError(409, code, msg);
export const tooMany = (msg = '请求过于频繁', code = 'rate_limited') => new AppError(429, code, msg);
export const serverError = (msg = '服务内部错误', code = 'internal') => new AppError(500, code, msg);
