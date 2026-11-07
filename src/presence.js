import { MEMBER_STATE, DRIVER } from './constants.js';

/**
 * 在线状态。
 *
 * 关键设计：把「在线」拆成两个独立维度，不要混为一谈。
 * - reachable：最近一段时间有过 inbox 请求或心跳 → 这台机器活着，能接唤醒指令
 * - ready：近期还在拉，能立刻处理消息
 *
 * 混在一起的后果是前端只能显示「在线/离线」，用户 @ 一个睡着的人看到「离线」
 * 会以为消息丢了；拆开之后可以诚实地显示「可唤醒」，并提示大约要多等几秒。
 */
export class Presence {
  constructor({ config }) {
    this.config = config;
    this.map = new Map(); // handle -> 记录
  }

  #rec(handle) {
    let r = this.map.get(handle);
    if (!r) {
      r = {
        handle,
        lastSeenAt: 0, // 最近一次 inbox / heartbeat
        state: MEMBER_STATE.cold, // 成员自报的生命周期状态
        stateAt: 0,
        pid: null,
        lastWakeAt: 0, // 最近一次下发唤醒的时间，冷却窗用
        lastError: null,
      };
      this.map.set(handle, r);
    }
    return r;
  }

  /** 任何来自成员的有效请求都算「还活着」。 */
  touch(handle) {
    const r = this.#rec(handle);
    r.lastSeenAt = Date.now();
    return r;
  }

  setState(handle, state, extra = {}) {
    const r = this.#rec(handle);
    r.lastSeenAt = Date.now();
    if (Object.values(MEMBER_STATE).includes(state)) {
      if (r.state !== state) {
        r.state = state;
        r.stateAt = Date.now();
      }
    }
    if (extra.pid !== undefined) r.pid = extra.pid;
    if (extra.error !== undefined) r.lastError = extra.error;
    return r;
  }

  noteWake(handle) {
    this.#rec(handle).lastWakeAt = Date.now();
  }

  reachable(handle) {
    const r = this.map.get(handle);
    if (!r) return false;
    return Date.now() - r.lastSeenAt < this.config.presenceTtlMs;
  }

  /**
   * 「就绪」= 能立刻给出回应。
   *
   * - pull 型：成员自己控制轮询频率，近期拉过就算就绪。
   * - llm 型：调用发生在桥的进程里，模型接口通不通由调用结果说话，
   *   不能因为「没人来轮询」就把它显示成离线。
   *
   * 三态因此成立：就绪 / 可唤醒 / 离线。若把 reachable 直接当就绪，
   * 「可唤醒」这一档会永远不出现，前端就退化成在线-离线两态。
   */
  ready(handle, driverType) {
    if (driverType === DRIVER.llm) return true;
    const r = this.map.get(handle);
    if (!r || !this.reachable(handle)) return false;
    return Date.now() - r.lastSeenAt < this.config.presenceHotMs;
  }

  inCooldown(handle) {
    const r = this.map.get(handle);
    if (!r || !r.lastWakeAt) return false;
    return Date.now() - r.lastWakeAt < this.config.wakeCooldownMs;
  }

  /**
   * 对外快照。三态文案由前端决定，服务端只给事实。
   * 注意：archived 成员不参与，调用方过滤。
   */
  snapshot(handle, driverType = DRIVER.pull) {
    const r = this.map.get(handle);
    const reachable = driverType === DRIVER.llm || this.reachable(handle);
    const ready = this.ready(handle, driverType);
    return {
      reachable,
      ready,
      state: r ? r.state : MEMBER_STATE.cold,
      lastSeenAt: r ? r.lastSeenAt : 0,
      lastWakeAt: r ? r.lastWakeAt : 0,
      lastError: r ? r.lastError : null,
    };
  }

  /** 供 /api/health 观察挂起规模。 */
  counts() {
    let reachable = 0;
    let ready = 0;
    for (const handle of this.map.keys()) {
      if (this.reachable(handle)) reachable++;
      if (this.ready(handle)) ready++;
    }
    return { tracked: this.map.size, reachable, ready };
  }

  /** 清理长期不活跃的记录，避免 map 无界增长。 */
  sweep() {
    const ttl = Math.max(this.config.presenceTtlMs * 20, 3_600_000);
    const now = Date.now();
    for (const [handle, r] of this.map) {
      if (now - r.lastSeenAt > ttl) this.map.delete(handle);
    }
  }
}
