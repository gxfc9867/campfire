/**
 * DSH 侧适配层：唯一碰 `ctx.agents` / `ctx.sessions` / Agent 方法的地方。
 *
 * 对外暴露 bridge 需要的动作（mintSessionId / openSession / createSession / ask / inject），
 * 这样 bridge 保持纯逻辑、可单测；DSH API 形状的差异全部收敛在这一个文件里。
 *
 * 契约依据（DSH 0.2.1-rc.5 安装包实测 + 文档，见 docs/design/DSH-PLUGIN.md）：
 * - `ctx.agents.create({ sessionId, meta, agentOptions })` → `AgentHandle{ agent, dispose() }`；
 *   `agentOptions` **必须显式给** provider/model，否则 loop 抛 `has no provider/model`。
 * - `ctx.agents.resume({ resumeSessionId, agentOptions })`：盘上有才成功，失败码要区分。
 * - 投递必须是**完整 durable UserMessage**（带 id/source），纯字符串会被 inbox 去重逻辑挡掉。
 * - `followup` 排队并唤醒；`inject` 只进 inbox 不唤醒；`whenIdle` 只表示回到 idle。
 * - 回复从 `session/event` 收：`assistant/message` 取文本，`turn/end` 判结束。
 * - 本文件**不 import 任何 @deepseek-ai/* 包**：bundle 是链接目录安装，裸包名解析不到。
 */

import { randomUUID } from 'node:crypto';

const MAX_SCAN_EVENTS = 2000;
const POLL_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textFromMessage(message) {
  if (!message) return '';
  const blocks = message.content;
  if (typeof blocks === 'string') return blocks;
  if (Array.isArray(blocks)) {
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  return typeof message.text === 'string' ? message.text : '';
}

/** resume 失败原因分类：决定「同 id 重建」还是「换新 id」。 */
export function classifyResumeError(error) {
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  if (/NotFound/i.test(name) || /not found/i.test(message)) return 'not_found';
  if (/AlreadyOwned/i.test(name) || /already owned|already opened/i.test(message)) return 'owned';
  if (/already registered/i.test(message)) return 'registered';
  return 'failed';
}

/**
 * @param {{ ctx: any, config?: Record<string, any>, log?: Function }} deps
 */
export function createDshHost({ ctx, config = {}, log = () => {} }) {
  const handles = new Map();
  const waits = new Map();
  let detachSessionFeed = null;

  function sessionOf(sessionId) {
    return ctx.sessions?.get?.(sessionId);
  }

  function mintSessionId(chatId) {
    const safe =
      String(chatId ?? 'chat')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'chat';
    return `campfire-${safe}-${randomUUID()}`;
  }

  function resolveCwd() {
    if (config.cwd) return config.cwd;
    try {
      return ctx.get?.('workingDirectory')?.defaultDirectory || '';
    } catch {
      return '';
    }
  }

  /** 会话模型路由：配置写死优先，否则继承 Harness 当前默认模型（必须显式传下去）。 */
  function resolveAgentOptions() {
    if (config.provider && config.model) {
      const out = { provider: config.provider, model: config.model };
      if (config.reasoningEffort) out.reasoningEffort = config.reasoningEffort;
      return out;
    }
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        const out = { provider: selection.provider, model: selection.model };
        if (selection.reasoningEffort) out.reasoningEffort = selection.reasoningEffort;
        return out;
      }
    } catch (error) {
      log('warn', `读取默认模型失败：${error?.message ?? error}`);
    }
    return undefined;
  }

  function buildCreateOptions(sessionId) {
    const options = { sessionId };
    const cwd = resolveCwd();
    if (cwd) options.meta = { cwd };
    const agentOptions = resolveAgentOptions();
    if (agentOptions) options.agentOptions = agentOptions;
    return options;
  }

  /** 构造一条 durable user 消息（形状同官方 createUserMessage 的产物）。 */
  function buildUserMessage(text) {
    return {
      id: `campfire-msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'campfire' },
    };
  }

  function onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (!sessionId) return;
    const wait = waits.get(sessionId);
    if (!wait) return;
    if (event?.type === 'assistant/message') {
      const text = textFromMessage(event.data?.message);
      if (text.trim()) wait.texts.push(text);
      return;
    }
    if (event?.type === 'turn/end') {
      wait.finish({ reason: event.data?.reason ?? null });
    }
  }

  function attachSessionFeed() {
    if (detachSessionFeed) return true;
    if (typeof ctx.on !== 'function') {
      log('warn', '当前 ctx 没有 on()，回复捕获退化为轮询会话日志');
      return false;
    }
    detachSessionFeed = ctx.on('session/event', onSessionEvent);
    return true;
  }

  function eventsAfter(sessionId, startSeq) {
    const session = sessionOf(sessionId);
    const events = session?.ownEvents?.() ?? [];
    const out = [];
    for (let index = events.length - 1, scanned = 0; index >= 0 && scanned < MAX_SCAN_EVENTS; index -= 1, scanned += 1) {
      const event = events[index];
      if (Number(event?.seq ?? 0) <= startSeq) break;
      out.push(event);
    }
    return out.reverse();
  }

  function latestAssistantText(sessionId, startSeq = 0) {
    const events = eventsAfter(sessionId, startSeq);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'assistant/message') continue;
      const text = textFromMessage(event.data?.message).trim();
      if (text) return text;
    }
    return '';
  }

  function currentSeq(sessionId) {
    return Number(sessionOf(sessionId)?.seq ?? 0);
  }

  async function createSession({ sessionId, chatId }) {
    const handle = await ctx.agents.create(buildCreateOptions(sessionId));
    handles.set(sessionId, handle);
    log('debug', `已创建 DSH 会话 ${sessionId}（群 ${chatId}）`);
    return handle.agent;
  }

  /**
   * 打开已有会话：本进程活着 → 直接用；否则 resume。
   * 返回 `{ agent }` 或 `{ error }`，由调用方决定重建策略。
   */
  async function openSession({ sessionId }) {
    const live = ctx.agents.get(sessionId);
    if (live) return { agent: live, reused: true };
    try {
      const options = { resumeSessionId: sessionId };
      const agentOptions = resolveAgentOptions();
      if (agentOptions) options.agentOptions = agentOptions;
      const handle = await ctx.agents.resume(options);
      handles.set(sessionId, handle);
      log('info', `已恢复 DSH 会话 ${sessionId}`);
      return { agent: handle.agent, resumed: true };
    } catch (error) {
      const code = classifyResumeError(error);
      return { error: code, message: error?.message ?? String(error) };
    }
  }

  /** 事件驱动等一轮跑完；拿不到 session/event 时退化为轮询会话日志。 */
  async function waitForTurn({ agent, sessionId, startSeq, timeoutMs }) {
    const collected = [];
    const useEvents = attachSessionFeed();

    if (!useEvents) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const text = latestAssistantText(sessionId, startSeq);
        if (text && eventsAfter(sessionId, startSeq).some((event) => event?.type === 'turn/end')) return text;
      }
      return latestAssistantText(sessionId, startSeq);
    }

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waits.delete(sessionId);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ timedOut: true }), Math.max(1_000, timeoutMs));
      waits.set(sessionId, { texts: collected, finish, agent });
    });

    if (outcome?.timedOut) {
      log('warn', `会话 ${sessionId} 在 ${timeoutMs}ms 内没有 turn/end，取消这一轮并按已收文本收尾`);
      try {
        agent.cancel?.({ kind: 'hook', reason: 'campfire reply timeout' });
      } catch (error) {
        log('debug', `取消会话 ${sessionId} 失败：${error?.message ?? error}`);
      }
    }
    const fromEvents = collected.join('\n').trim();
    return fromEvents || latestAssistantText(sessionId, startSeq);
  }

  /**
   * 同一会话内的投递必须串行。
   *
   * `waits` 按 sessionId 单槽，而成员:会话默认是 1:1（`sessionScope = '*'`），
   * 意味着多个群的 poller 会并发投进同一个会话：后一个 ask 的 waiter 会顶掉前一个，
   * 前一条消息的回复就此丢失。这里用一条 promise 链把同会话的投递排成队。
   */
  const sessionQueues = new Map();

  function withSessionLock(sessionId, task) {
    const key = String(sessionId);
    const previous = sessionQueues.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.then(
      () => {},
      () => {},
    );
    sessionQueues.set(key, tail);
    tail.then(() => {
      if (sessionQueues.get(key) === tail) sessionQueues.delete(key);
    });
    return current;
  }

  /**
   * 中断某个会话正在等的那一轮（对应围炉里的「停止」）。
   *
   * 两件事一起做：叫停 agent 本身，再让 waitForTurn 立刻收尾 —— 只 cancel
   * 不 finish 的话，等待方还得等到超时才知道结束了。
   * 返回 false 表示当前没有在跑的一轮。
   */
  function cancel(sessionId) {
    const wait = waits.get(String(sessionId));
    if (!wait) return false;
    try {
      wait.agent?.cancel?.({ kind: 'user', reason: '围炉用户点了停止' });
    } catch (error) {
      log('debug', `取消会话 ${sessionId} 失败：${error?.message ?? error}`);
    }
    wait.finish({ cancelled: true });
    return true;
  }

  /** 唤醒一轮（followup）并等它跑完，返回这轮 assistant 文本。 */
  async function ask({ agent, sessionId, text, timeoutMs = 120_000 }) {
    return withSessionLock(sessionId, async () => {
      if (typeof agent?.followup !== 'function') {
        throw new Error('该 Agent 没有 followup()，无法投递围炉消息');
      }
      const startSeq = currentSeq(sessionId);
      const message = buildUserMessage(text);
      const waiting = waitForTurn({ agent, sessionId, startSeq, timeoutMs });
      try {
        const queued = agent.followup(message);
        if (queued && typeof queued.then === 'function') await queued;
      } catch (error) {
        waits.delete(sessionId);
        throw error;
      }
      return waiting;
    });
  }

  /** notify 级别：只进 inbox，不唤醒（原生「注入不唤醒」）。 */
  async function inject({ agent, sessionId, text }) {
    return withSessionLock(sessionId, async () => {
      try {
        if (typeof agent?.inject !== 'function') {
          log('warn', '该 Agent 没有 inject()，notify 消息无法注入');
          return false;
        }
        const result = agent.inject(buildUserMessage(text));
        if (result && typeof result.then === 'function') await result;
        return true;
      } catch (error) {
        log('warn', `向会话 ${sessionId} 注入上下文失败：${error?.message ?? error}`);
        return false;
      }
    });
  }

  /** 插件卸载：先放掉等待中的轮次，再交还本插件创建的 agent handle。 */
  async function dispose() {
    for (const [sessionId, wait] of [...waits.entries()]) {
      waits.delete(sessionId);
      wait.finish({ disposed: true });
    }
    if (typeof detachSessionFeed === 'function') {
      try {
        detachSessionFeed();
      } catch {
        // 已随 ctx 卸载就忽略
      }
      detachSessionFeed = null;
    }
    const entries = [...handles.entries()];
    handles.clear();
    for (const [sessionId, handle] of entries) {
      try {
        await handle?.dispose?.();
        log('debug', `已释放会话 ${sessionId}`);
      } catch (error) {
        log('warn', `释放会话 ${sessionId} 失败：${error?.message ?? error}`);
      }
    }
  }

  return {
    mintSessionId,
    createSession,
    openSession,
    ask,
    inject,
    cancel,
    dispose,
    resolveAgentOptions,
    resolveCwd,
    handles,
  };
}
