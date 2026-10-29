import { SENDER, JOB_STATUS, DRIVER } from '../constants.js';
import { recordMemberReply, displayNameOf } from '../reply.js';

/**
 * 大模型驱动：桥内直接调 OpenAI 兼容的 /chat/completions。
 *
 * 为什么值得单独做一种驱动，而不是让用户写个 pull 脚本：
 * 前三种驱动（pull / cli / webhook）都要求用户先付出「写代码或配环境」的成本，
 * 才能看到群里第一句话。而大多数人的第一步诉求只是「我想看看它在这个群里像不像个人」。
 * llm 驱动把这一步压成三个输入框（地址、模型、密钥），零进程、零公网、零脚本。
 *
 * 另外它天然吃得到服务端的三层记忆——人设、记忆摘要、群内上下文本来就是桥在管，
 * 走外部进程反而要靠 /api/agent/prompt 再取一遍。
 *
 * 边界：这里不做流式、不做工具调用、不做多模态。只做「一句话进、一句话出」，
 * 这既是群聊的最小语义，也是所有兼容接口都无条件支持的交集。
 */

/** 同一成员同时只跑一轮，避免连发消息把它自己叠成 N 个并发请求。 */
const queues = new Map();

function enqueue(handle, fn) {
  const prev = queues.get(handle) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    handle,
    next.catch(() => {}),
  );
  return next;
}

/**
 * 拼 chat messages。
 *
 * 语义必须和 wake.buildPrompt 保持一致（人设 → 记忆 → 上下文 → 本次触发 → 输出约束），
 * 那是协议的一部分；这里只是换成结构化格式，好让模型分清谁在说话。
 */
export function buildChatMessages({
  member,
  digest,
  history,
  chatName,
  trigger,
  allowMentions = true,
  members = null,
}) {
  const persona = member.persona?.trim() || `你是${member.display}。`;
  const memory = digest?.trim();
  const nameOf = (sender) => (members ? displayNameOf({ members }, sender) : sender);

  const sys = [];
  sys.push(`你是「${member.display}」，长期待在群聊「${chatName}」里的一个成员。`);
  sys.push('');
  sys.push('[人设]');
  sys.push(persona);

  if (memory) {
    sys.push('');
    sys.push('[你记得的事]');
    sys.push(memory);
  }

  sys.push('');
  sys.push('[群聊规则]');
  sys.push('- 下面给你的是群聊记录，每条形如「发言人：内容」。');
  sys.push('- 只输出一条可以直接发到群里的消息。不要加前缀、署名、引号，也不要解释你在做什么。');
  sys.push('- 像真人在群里说话：有观点、有自己的语气，不要客服腔，不要「作为一个 AI」。');
  sys.push('- 只回应与你有关的部分。信息不足就直接问，不要编造事实。');
  sys.push('- 一般不超过 150 字，除非对方明确要求详细展开。');
  if (allowMentions) {
    sys.push('- 确有必要时可以 @某人 请他接力，但不要为了客气而无意义地 @。');
  } else {
    sys.push('- 不要 @ 任何人。');
  }

  const turns = [];
  for (const msg of history) {
    const isSelf = msg.sender === member.handle;
    const role = isSelf ? 'assistant' : 'user';
    const text = isSelf ? String(msg.text || '') : `${nameOf(msg.sender)}：${msg.text}`;
    const last = turns[turns.length - 1];
    // 连续同角色合并成一条：多成员群里「别人说的话」本来就该是一个整体上下文
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }

  if (trigger) {
    turns.push({ role: 'user', content: trigger });
  }

  return [{ role: 'system', content: sys.join('\n') }, ...turns];
}

/**
 * 调一次模型。
 * 兼容 OpenAI / DeepSeek / Kimi / 通义 / 智谱 / 自建网关——它们的 chat 接口形状一致。
 */
export async function callChat(driver, messages, { timeoutMs } = {}) {
  const url = `${driver.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const t0 = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(driver.apiKey ? { Authorization: `Bearer ${driver.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: driver.model,
      messages,
      temperature: driver.temperature ?? 0.8,
      max_tokens: driver.maxTokens ?? 800,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs || driver.timeoutMs || 60_000),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // 网关挂了常返回 HTML 错误页，原样带出第一行更有用
    throw new Error(`接口返回了非 JSON（HTTP ${res.status}）：${raw.slice(0, 160)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw.slice(0, 160);
    const hint =
      res.status === 401
        ? '密钥无效或已过期'
        : res.status === 404
          ? '接口地址或模型名不对'
          : res.status === 429
            ? '触发了限流或余额不足'
            : '';
    throw new Error(`${hint ? `${hint}：` : ''}HTTP ${res.status} ${msg}`);
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('模型返回了空内容');

  return {
    text,
    model: data.model || driver.model,
    usage: data.usage || null,
    latencyMs: Date.now() - t0,
  };
}

/**
 * 一条投递走 llm 驱动。
 * 和 webhook 一样是 fire-and-forget：投递任务已落库，这里只负责把它推进到终态。
 */
export function deliverLlm(ctx, job, member, { chatName }) {
  const { store, hub, memory, log } = ctx;

  return enqueue(member.handle, async () => {
    // 排队期间可能已被主人取消，或已超时降级——那就不要再冒出一句迟到的回复
    const fresh = store.getJob(job.id);
    if (!fresh || fresh.status !== JOB_STATUS.pending) {
      log.debug(`llm ${member.handle} 跳过：任务已是 ${fresh?.status || 'gone'}`);
      return;
    }
    store.claimJob(job.id, member.handle);

    try {
      const digest = memory.read(member.handle).digest;
      const { items } = store.listMessages({ chatId: job.chatId, limit: 20 });
      // 本次触发的那条单独给，历史里去掉它，否则模型会看到同一句话两遍
      const history = items.filter((m) => m.id !== job.messageId);

      const src = store.getMessage(job.messageId);
      const messages = buildChatMessages({
        member,
        digest,
        history,
        chatName,
        trigger: `${displayNameOf(ctx, src?.sender || SENDER.user)}：${job.text}`,
        allowMentions: member.driver.allowMentions !== false,
        members: ctx.members,
      });

      const out = await callChat(member.driver, messages);
      recordMemberReply(ctx, { handle: member.handle, job: fresh, text: out.text.slice(0, 4000) });
      log.info(`llm ${member.handle} 回复 ${out.latencyMs}ms（${out.model}）`);
    } catch (e) {
      store.finishJob(job.id, JOB_STATUS.failed, e.message);
      hub.emit('change', { type: 'job', chatId: job.chatId });
      log.warn(`llm ${member.handle} 调用失败：${e.message}`);
    }
  });
}

/** 自检：拿驱动配置发一句最短的话，验证地址/密钥/模型三件事都通。 */
export async function probeLlm(driver) {
  const out = await callChat(
    { ...driver, maxTokens: 32, temperature: 0 },
    [
      { role: 'system', content: '你是连通性测试。' },
      { role: 'user', content: '回复「通了」两个字，不要别的内容。' },
    ],
    { timeoutMs: Math.min(driver.timeoutMs || 30_000, 30_000) },
  );
  return out;
}
