/**
 * 长轮询挂起表。
 *
 * 每个成员可以有多条挂起请求（比如它同时开了两个进程），任何一条都该被叫醒。
 * 没有新消息时，请求挂在这里等到超时；有新内容时由 notify 立刻放行。
 *
 * 为什么不用 SSE 给成员：成员的收信是「请求-响应」模型，长轮询让它在任何语言里
 * 都只需要一个普通的 HTTP GET，不必处理流式解析、事件 id 与断线重连语义。
 */
export class InboxWaiters {
  constructor({ max = 200 } = {}) {
    this.max = max;
    this.map = new Map(); // handle -> Set<entry>
    this.total = 0;
  }

  /**
   * 注册一次挂起。
   * @returns {Promise<'signal'|'timeout'|'closed'|'rejected'>}
   *   signal 表示有新内容需要去查库，其余都是「这次没拿到东西」。
   */
  wait(handle, res, ms) {
    if (this.total >= this.max) return Promise.resolve('rejected');

    return new Promise((resolve) => {
      let done = false;

      const cleanup = () => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        res.off('close', onClose);
        const set = this.map.get(handle);
        if (set) {
          set.delete(entry);
          if (!set.size) this.map.delete(handle);
        }
        this.total--;
        return true;
      };

      const finish = (why) => {
        if (cleanup()) resolve(why);
      };

      const timer = setTimeout(() => finish('timeout'), ms);
      // 客户端主动断开必须清理，否则挂起表会随断线次数无界增长
      const onClose = () => finish('closed');

      const entry = { finish };
      res.on('close', onClose);

      let set = this.map.get(handle);
      if (!set) {
        set = new Set();
        this.map.set(handle, set);
      }
      set.add(entry);
      this.total++;
    });
  }

  /** 精确唤醒某个成员的所有挂起请求。 */
  notify(handle) {
    const set = this.map.get(handle);
    if (!set) return 0;
    const entries = [...set];
    for (const e of entries) e.finish('signal');
    return entries.length;
  }

  notifyAll() {
    for (const handle of [...this.map.keys()]) this.notify(handle);
  }

  count() {
    return this.total;
  }

  /** 服务退出时释放所有挂起，让它们走正常返回路径而不是被硬掐断。 */
  closeAll() {
    for (const handle of [...this.map.keys()]) this.notify(handle);
    this.map.clear();
    this.total = 0;
  }
}
