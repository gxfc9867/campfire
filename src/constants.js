/**
 * 全局常量与枚举。
 * 只放不随环境变化的字面量，环境相关的都在 config.js。
 */

/** 消息发送者保留标识。成员一律用 handle，这两个不能被成员占用。 */
export const SENDER = {
  user: 'user',
  system: 'system',
};

/** 主会话：首次启动自动创建，不可删除。 */
export const MAIN_CHAT = { id: 'main', name: '大厅' };

/**
 * 成员的生命周期状态。
 * hot  —— 长轮询常挂，收到即处理
 * warm —— 低频短轮询，仍在进程内
 * cold —— 进程可退出，等待被唤醒
 * wake —— 已被要求唤醒，进程正在启动
 */
export const MEMBER_STATE = {
  hot: 'hot',
  warm: 'warm',
  cold: 'cold',
  wake: 'wake',
};

/** 驱动类型。pull 由成员自己来取，cli 由 sidecar 起进程，webhook 由桥推。 */
export const DRIVER = {
  pull: 'pull',
  cli: 'cli',
  webhook: 'webhook',
};

/**
 * 一次投递的生命周期。
 * pending    —— 已落库，等成员处理（不判死）
 * processing —— 成员已认领
 * done       —— 已回执
 * expired    —— 超过等待上限，降级为普通消息
 * failed     —— 成员明确报错
 */
export const JOB_STATUS = {
  pending: 'pending',
  processing: 'processing',
  done: 'done',
  expired: 'expired',
  failed: 'failed',
};

/** handle 规则：小写字母开头，允许小写字母、数字、下划线、连字符。 */
export const HANDLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 预置头像模板数量，对应 public/avatars/preset-NN.svg。 */
export const AVATAR_PRESET_COUNT = 24;

/** 唤醒 planner 的决策结果。 */
export const WAKE = {
  noop: 'noop', // 不需要做任何事（成员已就绪）
  wake: 'wake', // 下发唤醒指令
  hold: 'hold', // 暂不唤醒，等条件满足（冷却中 / sidecar 不在线 / 闸门满）
};
