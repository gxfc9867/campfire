import { Summarizer } from './summarizer.js';
import { Embedder } from './embedder.js';

/**
 * 记忆服务的装配入口。
 *
 * 两个能力各自独立开关：
 * - 摘要需要生成模型（OpenAI 兼容 /chat/completions）；
 * - 向量需要 embedding 模型（/embeddings）。
 * 没有配置就返回 null，调用方据此跳过，不报错——自托管默认应该是「不花钱也能跑」。
 */
export function createMemoryService({ store, env = process.env, fetchImpl = fetch, log = null } = {}) {
  const summaryCfg = readSummaryConfig(env);
  const embedCfg = readEmbedConfig(env);

  const summarizer = summaryCfg
    ? new Summarizer({
      store,
      complete: makeChatComplete({ ...summaryCfg, fetchImpl }),
      model: summaryCfg.model,
      minMessages: int(env.MEMORY_SUMMARY_MIN_MESSAGES, 20, 1, 1000),
    })
    : null;

  const embedder = embedCfg
    ? new Embedder({
      store,
      embed: makeEmbed({ ...embedCfg, fetchImpl }),
      model: embedCfg.model,
    })
    : null;

  if (!summarizer && !embedder) log?.info?.('[memory] 未配置模型，记忆功能关闭');
  return { summarizer, embedder, enabled: Boolean(summarizer || embedder) };
}

export function readSummaryConfig(env = process.env) {
  const baseUrl = trim(env.MEMORY_SUMMARY_BASE_URL);
  const model = trim(env.MEMORY_SUMMARY_MODEL);
  if (!baseUrl || !model) return null;
  return { baseUrl, model, apiKey: trim(env.MEMORY_SUMMARY_API_KEY) };
}

export function readEmbedConfig(env = process.env) {
  const baseUrl = trim(env.MEMORY_EMBED_BASE_URL);
  const model = trim(env.MEMORY_EMBED_MODEL);
  if (!baseUrl || !model) return null;
  return { baseUrl, model, apiKey: trim(env.MEMORY_EMBED_API_KEY) };
}

/** OpenAI 兼容的 chat 补全，返回纯文本。 */
export function makeChatComplete({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 120_000 }) {
  return async function complete(prompt) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(join(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat 补全失败 ${res.status}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text);
      const out = data?.choices?.[0]?.message?.content;
      if (typeof out !== 'string' || !out.trim()) throw new Error('chat 补全返回空内容');
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** OpenAI 兼容的 embeddings，返回向量数组（与输入等长）。 */
export function makeEmbed({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 60_000 }) {
  return async function embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(join(baseUrl, '/embeddings'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: ctl.signal,
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`embedding 失败 ${res.status}: ${raw.slice(0, 200)}`);
      const data = JSON.parse(raw);
      const list = data?.data;
      if (!Array.isArray(list)) throw new Error('embedding 返回格式不对');
      return list.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  };
}

function join(baseUrl, suffix) {
  return String(baseUrl).replace(/\/$/, '') + suffix;
}

function trim(v) {
  const s = String(v || '').trim();
  return s || '';
}

function int(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
