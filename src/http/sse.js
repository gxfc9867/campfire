/**
 * 事件订阅（SSE）。
 *
 * 只用来「叫醒」浏览器，不承载真实数据：
 * 前端收到事件后自己去拉增量消息。这样即使漏掉一条事件也不会丢数据，
 * 断线重连只需补拉，不必实现事件重放。
 */
export class EventHub {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => this.ping(), 25_000);
    this.timer.unref?.();
  }

  /**
   * 注册一个订阅。
   * @param {string} chatId 只接收该会话的变化；空串表示接收全部
   */
  subscribe(req, res, chatId = '') {
    const client = { res, chatId };
    this.clients.add(client);

    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const cleanup = () => {
      this.clients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    return cleanup;
  }

  /** 广播变化。chatId 存在时只发给关注该会话的订阅者。 */
  emit(type, payload = {}) {
    const chatId = payload.chatId || '';
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) {
      if (chatId && c.chatId && c.chatId !== chatId) continue;
      try {
        c.res.write(frame);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /** 注释行心跳：反代通常只根据「有没有字节流动」判断连接是否还活着。 */
  ping() {
    for (const c of this.clients) {
      try {
        c.res.write(': ping\n\n');
      } catch {
        this.clients.delete(c);
      }
    }
  }

  count() {
    return this.clients.size;
  }

  closeAll() {
    for (const c of this.clients) {
      try {
        c.res.end();
      } catch {
        // 已经断了
      }
    }
    this.clients.clear();
    clearInterval(this.timer);
  }
}
