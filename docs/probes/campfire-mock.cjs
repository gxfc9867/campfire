#!/usr/bin/env node
'use strict';

/**
 * mock 围炉的薄 CLI 启动器。
 *
 * 用途：人工/脚本做 dsh-campfire 插件的端到端验收时，起一个固定端口的 mock，
 * 把插件 baseUrl 指过去，然后观察插件的长轮询、发消息、ack 行为。
 *
 *   node docs/probes/campfire-mock.cjs
 *   node docs/probes/campfire-mock.cjs --port 8787 --token dev-token --member facai --chat main
 *
 * 参数缺省：port 8787、token dev-token、member facai、chat main。
 * token 优先级：--token > 环境变量 CAMPFIRE_MOCK_TOKEN > dev-token。
 * Ctrl+C 优雅退出（会等挂起的长轮询收尾）。
 */

const { createMockCampfire } = require('../../plugins/dsh-campfire/mock-campfire.cjs');

const DEFAULT_PORT = 8787;
const DEFAULT_TOKEN = 'dev-token';
const DEFAULT_MEMBER = 'facai';
const DEFAULT_CHAT = 'main';

const USAGE = `用法: node docs/probes/campfire-mock.cjs [选项]

  --port <n>        监听端口，默认 ${DEFAULT_PORT}（0 = 系统分配）
  --token <s>       Bearer token，默认取环境变量 CAMPFIRE_MOCK_TOKEN，再默认 ${DEFAULT_TOKEN}
  --member <s>      被 mock 的成员 handle，默认 ${DEFAULT_MEMBER}
  --display <s>     成员显示名，默认按 handle 推断
  --chat <s>        默认 chatId，默认 ${DEFAULT_CHAT}
  --strict          按契约严格回包（错误体扁平、chatId 必填、只看自己会话、非法游标 400、
                    不带 cursor 时用已确认位置）。跑 scripts/conformance.mjs 时开
  --verbose         打印每个请求的内部日志
  -h, --help        显示这段帮助`;

/** 极简参数解析：支持 --k v 与 --k=v，不引第三方库。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function parsePort(raw) {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`端口不合法：${raw}（需要 0-65535 的整数）`);
    process.exit(2);
  }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const args = parseArgs(argv);
  const port = parsePort(args.port);
  const token = args.token || process.env.CAMPFIRE_MOCK_TOKEN || DEFAULT_TOKEN;
  const member = args.member || DEFAULT_MEMBER;
  const chat = args.chat || DEFAULT_CHAT;
  // 没显式给显示名时：默认成员沿用「发财」，换了成员就用 handle 兜底
  const display = args.display || (member === DEFAULT_MEMBER ? undefined : member);

  const mock = createMockCampfire({
    token,
    memberHandle: member,
    memberDisplay: display,
    chatId: chat,
    quiet: args.verbose !== 'true',
    strict: args.strict === 'true',
  });

  const { baseUrl } = await mock.start(port);

  console.log(`mock campfire listening on ${baseUrl}`);
  console.log(`把插件 baseUrl 指向它、token 用 ${token}`);
  console.log(`成员 handle=${member} 默认 chat=${chat}`);

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在关闭 mock campfire ...`);
    try {
      await mock.stop();
      console.log('已关闭。');
      process.exit(0);
    } catch (err) {
      console.error('关闭失败：', err && err.message ? err.message : err);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// 只有直接 `node campfire-mock.cjs` 才启动；被 require 时只导出纯函数，方便单测参数解析。
if (require.main === module) {
  main().catch((err) => {
    console.error('mock campfire 启动失败：', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { parseArgs, parsePort, main, USAGE };
