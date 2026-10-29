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

/**
 * 驱动类型。
 * pull    —— 成员自己来取（任意语言/任意机器）
 * cli     —— sidecar 在宿主机起进程
 * webhook —— 桥推给成员暴露的 HTTP 地址
 * llm     —— 桥内直连大模型接口，无需任何外部进程
 *
 * 加 llm 的理由：前三种都要用户先写点东西（脚本/配置/服务），
 * 而「先看看真 agent 在群里什么样」这个需求，本该只要一把 key。
 * llm 把这段门槛压到「填三个框」，也是四种驱动里唯一零部署的。
 */
export const DRIVER = {
  pull: 'pull',
  cli: 'cli',
  webhook: 'webhook',
  llm: 'llm',
};

/**
 * 大模型服务商预设。
 * 全部走 OpenAI 兼容的 /chat/completions，所以「自定义」也能接任何自建网关。
 * 模型名只给保守默认，界面上可改——模型迭代比版本号快，写死会过期。
 */
export const LLM_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  dashscope: { label: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  custom: { label: '自定义 / 自建网关', baseUrl: '', model: '' },
};

/**
 * 一次投递的生命周期。
 * pending    —— 已落库，等成员处理（不判死）
 * processing —— 成员已认领
 * done       —— 已回执
 * expired    —— 超过等待上限，降级为普通消息
 * failed     —— 成员明确报错
 * cancelled  —— 主人手动取消（挂太久了不想等）
 */
export const JOB_STATUS = {
  pending: 'pending',
  processing: 'processing',
  done: 'done',
  expired: 'expired',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** handle 规则：小写字母开头，允许小写字母、数字、下划线、连字符。 */
export const HANDLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * 成员回复里点名主人的显式写法。
 * 「@我」后面紧跟汉字（如「@我们」）或字母数字（如 @me2）都不算，
 * 这是结构化判定，替代之前前端那套自然语言关键词猜测——那套误报太多。
 */
export const MENTION_OWNER_RE = /@(?:主人|owner|me|我)(?![\u4e00-\u9fa5a-zA-Z0-9_-])/i;

/** 预置头像模板数量，对应 public/avatars/preset-NN.svg。 */
export const AVATAR_PRESET_COUNT = 24;

/** 唤醒 planner 的决策结果。 */
export const WAKE = {
  noop: 'noop', // 不需要做任何事（成员已就绪）
  wake: 'wake', // 下发唤醒指令
  hold: 'hold', // 暂不唤醒，等条件满足（冷却中 / sidecar 不在线 / 闸门满）
};
