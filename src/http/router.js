/**
 * 极简路由。
 *
 * 用「方法 + 字符串或正则」匹配，捕获组按顺序传给处理器。
 * 之所以不引框架：路由总量可控，一个 30 行的匹配器比任何框架都更容易读懂，
 * 也避免把零依赖这个卖点丢掉。
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    this.routes.push({ method, pattern, handler, opts });
    return this;
  }

  get(pattern, handler, opts) {
    return this.add('GET', pattern, handler, opts);
  }

  post(pattern, handler, opts) {
    return this.add('POST', pattern, handler, opts);
  }

  put(pattern, handler, opts) {
    return this.add('PUT', pattern, handler, opts);
  }

  patch(pattern, handler, opts) {
    return this.add('PATCH', pattern, handler, opts);
  }

  delete(pattern, handler, opts) {
    return this.add('DELETE', pattern, handler, opts);
  }

  /**
   * @returns {{route, params}|null}
   * opts.auth: 'owner' | 'member' | undefined（不校验）
   */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue;
      if (typeof route.pattern === 'string') {
        if (route.pattern === pathname) return { route, params: [] };
        continue;
      }
      const m = route.pattern.exec(pathname);
      if (m) return { route, params: m.slice(1).map(decodeURIComponent) };
    }
    return null;
  }
}
