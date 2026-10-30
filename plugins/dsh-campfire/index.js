/**
 * 围炉（campfire）→ DSH 渠道插件入口。
 *
 * 职责边界（`docs/design/CONNECTION-DRAFT.md` §6.8：围炉不拼提示词）：
 * - 本插件只做「收消息 → 投给会话 → 把回复发回围炉」，不生成人设、不拼上下文；
 * - 人设与记忆归 DSH 会话自己；
 * - 投递内容一律带来源标记（§6.4），让模型知道那是群里的数据而不是用户指令。
 *
 * 装配顺序：解析配置 → 围炉客户端 → 状态文件 → DSH 适配层 → 桥 → 开始拉流。
 * 卸载时逆序收尾：停拉流 → 关客户端 → 释放本插件建的会话。
 */

import { createBridge } from './src/bridge.js';
import { createCampfireClient } from './src/campfire-client.js';
import { createStateStore } from './src/bindings.js';
import { describeConfig, resolveConfig } from './src/config.js';
import { createDshHost } from './src/dsh-host.js';

export const name = 'campfire-dsh-plugin';

/** 依赖的 Host 服务：没有它们插件不激活（不会抛错拖垮整个 profile）。 */
export const inject = ['agents', 'sessions'];

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(ctx, level) {
  let threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, message) {
    if ((LEVELS[lvl] ?? LEVELS.info) < threshold) return;
    const text = `[campfire] ${message}`;
    try {
      const sink = ctx.logger ?? ctx.get?.('logger');
      if (sink && typeof sink[lvl] === 'function') {
        sink[lvl](text);
        return;
      }
    } catch {
      // 日志服务不可用时退回 console，不能因为打日志把插件搞挂
    }
    const write = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    write(text);
  }

  return {
    emit,
    setLevel(next) {
      threshold = LEVELS[next] ?? threshold;
    },
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}

async function probeMeta(client, logger) {
  try {
    const meta = await client.meta({ timeoutMs: 10_000 });
    const caps = meta?.capabilities ?? {};
    logger.info(
      `围炉连通：apiVersion=${meta?.apiVersion ?? '?'} wakeup=${JSON.stringify(caps.wakeup ?? [])} cursor=${caps.cursor ?? '?'}`,
    );
    if (Array.isArray(caps.wakeup) && !caps.wakeup.includes('reply')) {
      logger.warn('围炉没有声明 wakeup=reply 能力，被 @ 的消息可能不会唤醒会话');
    }
  } catch (error) {
    logger.warn(`围炉 /v1/meta 探测失败（不影响拉流重试）：${error?.message ?? error}`);
  }
}

/**
 * @param {any} ctx Cordis 插件上下文
 * @param {Record<string, unknown>} config 插件行内配置
 */
export function apply(ctx, config) {
  const row = config && typeof config === 'object' ? config : {};
  const logger = createLogger(ctx, typeof row.logLevel === 'string' ? row.logLevel : 'info');

  ctx.effect(() => {
    let bridge = null;
    let client = null;
    let host = null;

    const booting = (async () => {
      const resolved = await resolveConfig(row, { log: logger.emit });
      logger.setLevel(resolved.logLevel);

      if (!resolved.baseUrl) {
        logger.info('未配置围炉 baseUrl，插件待命（不拉流）。配置见 docs/design/DSH-PLUGIN.md');
        return;
      }
      if (resolved.chatIds.length === 0) {
        logger.info('chatIds 为空，插件待命（不拉流）');
        return;
      }
      if (!resolved.token) {
        logger.warn('围炉 token 缺失，拉流会一直 401；请设置 token / tokenEnv / tokenFile');
      }

      client = createCampfireClient({
        baseUrl: resolved.baseUrl,
        token: resolved.token,
        log: logger.emit,
      });
      host = createDshHost({ ctx, config: resolved, log: logger.emit });
      const store = createStateStore({ filePath: resolved.stateFile, log: logger.emit });
      await store.load();

      bridge = createBridge({
        client,
        store,
        host,
        config: resolved,
        log: logger.emit,
      });

      logger.info(`围炉插件就绪：${describeConfig(resolved)}`);
      await probeMeta(client, logger);
      bridge.start();
    })().catch((error) => {
      logger.error(`围炉插件启动失败：${error?.stack ?? error?.message ?? error}`);
    });

    return async () => {
      await booting.catch(() => {});
      try {
        await bridge?.stop();
      } catch (error) {
        logger.warn(`停止围炉桥失败：${error?.message ?? error}`);
      }
      try {
        client?.close?.('plugin unload');
      } catch {
        // 已关闭就忽略
      }
      try {
        await host?.dispose();
      } catch (error) {
        logger.warn(`释放围炉会话失败：${error?.message ?? error}`);
      }
    };
  });
}
