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

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBridge } from './src/bridge.js';
import { createCampfireClient } from './src/campfire-client.js';
import { createStateStore } from './src/bindings.js';
import { describeConfig, resolveConfig } from './src/config.js';
import { registerConfigRoutes } from './src/config-api.js';
import { createDshHost } from './src/dsh-host.js';

/**
 * 配置 schema（schemastery）。
 *
 * 导出它的作用是让 DSH 知道有哪些可配项、类型与默认值，从而在插件界面里渲染表单，
 * 而不是逼用户去手改 `$DSH_HOME/campfire/config.json`。
 *
 * 两个刻意的选择：
 *
 * 1. **用 createRequire 同步加载，不用顶层 await。** 插件模块可能被加载器同步求值，
 *    顶层 await 会让它变成异步模块，某些加载路径下会静默失败（实测 NAS 上就完全没加载）。
 *    schemastery 有 CJS 构建，createRequire 能同步拿到。
 * 2. **解析不到就不导出。** 本插件是零依赖的，从仓库目录 link 安装时拿不到
 *    schemastery（它只存在于 DSH 自己的 node_modules 里）。那种情况下 Config 为
 *    undefined，DSH 当作「没有 schema」，配置仍走配置文件，功能完全不受影响。
 */
let Config;
try {
  const Schema = createRequire(import.meta.url)('schemastery');
  Config = Schema.object({
    baseUrl: Schema.string()
      .default('')
      .description('围炉服务地址，例如 http://192.168.31.252:8099。留空则插件待命、不拉流。'),
    token: Schema.string()
      .role('secret')
      .default('')
      .description('渠道令牌（一 token = 一成员），在围炉里为该成员创建后粘贴到这里。'),
    memberHandle: Schema.string()
      .default('facai')
      .description('本插件在围炉里的成员 handle（英文小写），要和令牌所属成员一致。'),
    chatIds: Schema.array(Schema.string())
      .default(['main'])
      .description('要接入的群 ID 列表，例如 ["main"]。留空则待命。'),
    cwd: Schema.string()
      .default('')
      .description('会话工作目录（绝对路径）。留空则用 DSH 当前工作区。建议填一个干净目录。'),
    sessionScope: Schema.string()
      .default('member')
      .description('会话绑定粒度：member = 一个成员一个会话（推荐）；per-chat = 每个群一个会话。'),
    wait: Schema.number()
      .default(25)
      .description('长轮询挂起秒数（0–30）。越大越省资源，越小越实时。'),
    replyTimeoutMs: Schema.number()
      .default(120000)
      .description('等模型把一轮跑完的上限（毫秒）。超时会中断这一轮。'),
    tokenEnv: Schema.string()
      .default('CAMPFIRE_TOKEN')
      .description('若不想把令牌写进配置，可改从该环境变量读取。'),
    tokenFile: Schema.string()
      .default('')
      .description('或从文件读取令牌（支持 ~ 开头）。token 留空时才会用到。'),
    provider: Schema.string()
      .default('')
      .description('会话使用的模型 provider，留空继承 DSH 当前默认。'),
    model: Schema.string()
      .default('')
      .description('会话使用的模型名，留空继承 DSH 当前默认。'),
    logLevel: Schema.string()
      .default('info')
      .description('日志级别：debug | info | warn | error | silent。'),
  }).description('围炉（campfire）DSH 渠道插件');
} catch {
  Config = undefined;
}
export { Config };

export const name = 'campfire-dsh-plugin';

/**
 * 依赖的 Host 服务。webServer 是配置面板的载体：cordis 不允许在 inject 之外
 * 访问宿主服务（会抛 cannot get property "webServer" without inject）。
 * 没有 webServer 的宿主（如 headless）插件不会激活，那种场景本来也没有界面可配，
 * 直接改配置文件即可。
 */
export const inject = ['agents', 'sessions', 'webServer'];

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * 排查用日志文件。
 *
 * DSH 桌面/容器里 Electron 会接管 stdout，console 输出不一定进 docker logs，
 * 而「插件连不上」这类问题恰恰最需要看启动过程。所以除了 logger/console，
 * 再往 $DSH_HOME/campfire/plugin.log 追加一份——只在 debug 级别下写，正常不产生垃圾。
 */
function resolveLogFile(env = process.env) {
  const root = env.DSH_HOME || env.DSH_PROFILE_DIR || path.join(os.homedir(), '.campfire');
  return path.join(root, 'campfire', 'plugin.log');
}

function appendLogFile(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch {
    // 写日志失败绝不能影响插件本身
  }
}

// 模块加载留痕：debug 级别下写入 plugin.log，便于排查「插件没连上」这类问题
appendLogFile(resolveLogFile(), `BOOT module loaded | DSH_HOME=${process.env.DSH_HOME || '(empty)'} | pid=${process.pid}`);

function createLogger(ctx, level) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const logFile = resolveLogFile();

  function emit(lvl, message) {
    if ((LEVELS[lvl] ?? LEVELS.info) < threshold) return;
    const text = `[campfire] ${message}`;
    // debug 级别下同时落盘：容器里 stdout 不可靠时，这是唯一能看见启动流程的地方
    if (threshold <= LEVELS.debug) appendLogFile(logFile, `${lvl.toUpperCase()} ${message}`);
    // 同时打到 stdout：DSH 跑在容器里时，只有 stdout 会进 docker logs，
    // 排查「插件没连上」这类问题时看不到日志等于瞎猜。
    // debug 级别下连 info 也打，便于完整追踪启动流程。
    const toStdout = lvl === 'error' || lvl === 'warn' || lvl === 'debug' || (lvl === 'info' && threshold <= LEVELS.debug);
    try {
      const sink = ctx.logger ?? ctx.get?.('logger');
      if (sink && typeof sink[lvl] === 'function') {
        sink[lvl](text);
        // 同时打到 stdout：DSH 跑在容器里时，只有 stdout 会进 docker logs，
        // 排查「插件没连上」这类问题时看不到日志等于瞎猜。
        if (toStdout) (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(text);
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
      logger.debug(
        `配置解析完成：baseUrl=${resolved.baseUrl || '(空)'} member=${resolved.memberHandle} chats=${JSON.stringify(resolved.chatIds)} token=${resolved.token ? '已配置' : '缺失'} logLevel=${resolved.logLevel}`,
      );

      // 配置面板必须先于「待命」分支挂载：从没配过的新用户正是最需要它的人。
      // webServer 用可选获取而不是写进 inject，这样没有该服务的宿主仍能正常加载插件。
      try {
        // webServer 是宿主服务的属性（dsh-model-health 也是直接 ctx.webServer.register），
        // ctx.get('webServer') 在部分版本上拿不到，两个都试一下。
        const webServer = ctx.webServer ?? ctx.get?.('webServer');
        if (webServer) {
          registerConfigRoutes(
            { webServer },
            { configFile: resolved.configFile, resolved, log: logger.emit },
          );
        } else {
          logger.info('宿主没有 webServer 服务，配置面板不可用（可继续用配置文件）');
        }
      } catch (error) {
        logger.warn(`挂载配置面板失败：${error?.message ?? error}`);
      }

      if (!resolved.baseUrl) {
        logger.info('未配置围炉 baseUrl，插件待命（不拉流）。到「设置 → 围炉渠道」填地址和令牌。');
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
