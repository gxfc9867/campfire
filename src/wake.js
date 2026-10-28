import { DRIVER, WAKE } from './constants.js';

/**
 * 唤醒决策。
 *
 * 这个模块**只做判断，不执行任何命令**——这是整个项目的安全底线：
 * 桥如果自己 exec，等于把 HTTP 输入接到 shell，公网部署就是 RCE。
 * 真正的进程启动在宿主机上的 sidecar 里。
 *
 * 另一个容易搞混的点：休眠的是「agent 进程」，不是 sidecar。
 * sidecar 必须常驻（一个空闲 node 进程 + 一条长轮询），否则没人接唤醒指令，
 * 成员就永远醒不过来。所以 cold/warm 描述的是「现在能不能秒回」，不是「有没有人连」。
 */
export class WakePlanner {
  constructor({ config, presence, members, logger }) {
    this.config = config;
    this.presence = presence;
    this.members = members;
    this.log = logger;
  }

  /**
   * @returns {{action: 'noop'|'wake'|'hold', reason: string, detail?: string}}
   *  action = noop 不需要唤醒；wake 可以下发；hold 需要唤醒但条件不满足
   */
  decide(handle) {
    const m = this.members.get(handle);
    if (!m) return { action: WAKE.noop, reason: 'member_gone' };
    if (m.archivedAt) return { action: WAKE.noop, reason: 'member_archived' };

    // 已经在跑（hot），或者成员自己就在拉取，都不需要叫
    if (this.presence.ready(handle, m.driver.type)) {
      return { action: WAKE.noop, reason: 'already_ready' };
    }

    // 非 cli 型没有「叫醒」这个动作：pull 型由它自己来取，webhook 型由桥推送
    if (m.driver.type !== DRIVER.cli) {
      return { action: WAKE.noop, reason: `driver_${m.driver.type}` };
    }

    // 连 sidecar 都不在，唤醒指令发不出去，只能挂着等它回来
    if (!this.presence.reachable(handle)) {
      return { action: WAKE.hold, reason: 'offline', detail: '成员所在机器的 sidecar 不在线' };
    }

    // 冷却窗：吸收「@所有人」或连续追问造成的进程风暴
    if (this.presence.inCooldown(handle)) {
      return { action: WAKE.hold, reason: 'cooldown', detail: '刚唤醒过，冷却中' };
    }

    // 并发闸门：由 sidecar 上报 running/limit，桥不自行猜测机器负载
    if (!this.presence.hasCapacity(handle, m.driver.type)) {
      return { action: WAKE.hold, reason: 'busy', detail: '该机器上正在跑的成员已达上限' };
    }

    return { action: WAKE.wake, reason: 'ok' };
  }

  /** 真正下发之后调用，开始计冷却窗。 */
  markWoken(handle) {
    this.presence.noteWake(handle);
    this.log.debug(`唤醒指令已下发：${handle}`);
  }

  /**
   * 拼装给 sidecar 的提示词。
   *
   * 三层记忆：人设 → 记忆摘要 → 群内上下文。
   * 刻意不用 session resume：各工具支持度不一，一旦依赖它，
   * 接入成本立刻回到「为每个 CLI 写适配器」的老路上。
   */
  buildPrompt({ member, digest, messages, chatName, trigger }) {
    const persona = member.persona?.trim() || `你是${member.display}。`;
    const memory = digest?.trim();

    const lines = [];
    lines.push('[人设]');
    lines.push(persona);
    lines.push('');

    if (memory) {
      lines.push('[你记得的事]');
      lines.push(memory);
      lines.push('');
    }

    lines.push(`[当前群聊：${chatName}]`);
    for (const msg of messages) {
      const who = msg.sender === 'user' ? '主人' : msg.senderName || msg.sender;
      const text = String(msg.text || '').replace(/\s+/g, ' ').slice(0, 800);
      lines.push(`${who}：${text}`);
    }
    lines.push('');

    if (trigger) {
      lines.push('[本次触发]');
      lines.push(trigger);
      lines.push('');
    }

    lines.push('请只输出一条可以直接发到群里的消息，不要加任何前缀、署名或解释。');
    return lines.join('\n');
  }
}
