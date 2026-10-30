import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAcpGateway } from './launcher.js';
import { AcpClient } from './acp-client.js';
import { WorkBuddyBridge, SessionIndex } from './bridge.js';

// 读项目根 .env（与主服务一致；已存在的环境变量不覆盖，方便命令行临时覆盖）
const __root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
{
  let raw;
  try {
    raw = fs.readFileSync(path.join(__root, '.env'), 'utf8');
  } catch {
    raw = '';
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * 桥进程：把围炉里的消息投进 WorkBuddy 会话，再把回复发回围炉。
 *
 * 独立进程运行（`node src/bridges/workbuddy/run.js`），不嵌进主服务：
 * - 主服务不需要知道 WorkBuddy 的存在；
 * - 桥崩了不影响群聊，重启即恢复（游标在服务端）。
 */
export function configFromEnv(env = process.env) {
  const read = (k) => String(env[k] || '').trim();
  const tokenFile = read('WORKBUDDY_TOKEN_FILE');
  return {
    campfireBaseUrl: read('CAMPFIRE_BASE_URL') || 'http://127.0.0.1:8099',
    channelToken: read('CAMPFIRE_CHANNEL_TOKEN'),
    member: read('CAMPFIRE_MEMBER'),
    sessionId: read('WORKBUDDY_SESSION_ID'),
    cwd: read('WORKBUDDY_CWD'),
    tokenFile,
    cliBin: read('WORKBUDDY_CLI'),
    configDir: read('WORKBUDDY_CONFIG_DIR'),
    dbPath: read('WORKBUDDY_DB'),
    password: read('WORKBUDDY_GATEWAY_PASSWORD') || `cf-${Math.random().toString(36).slice(2, 10)}`,
    log: null,
  };
}

export function readTokenFile(file) {
  if (!file) throw new Error('缺少 WORKBUDDY_TOKEN_FILE');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`token 文件为空：${file}`);
  return token;
}

/**
 * 跑一轮：拉一批更新、逐条投递、发回复、推进游标。
 * @returns {Promise<{handled:number,nextCursor:number}>}
 */
export async function runOnce({ cfg, bridge, fetchImpl = fetch, log = null }) {
  const { campfireBaseUrl, channelToken, member, sessionId, cwd } = cfg;
  const url = new URL('/v1/updates', campfireBaseUrl);
  url.searchParams.set('wait', '0');
  url.searchParams.set('limit', '20');

  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${channelToken}` } });
  if (!res.ok) throw new Error(`拉取更新失败 ${res.status}`);
  const body = await res.json();

  let handled = 0;
  for (const update of body.updates || []) {
    if (update.type !== 'message.created') continue;
    if (!update.replyRequired) continue;
    if (update.message?.sender?.handle === member) continue; // 自己的发言不回

    const text = `${update.message.sender.display || update.message.sender.handle}：${update.message.text}`;
    const out = await bridge.deliver({
      sessionId,
      cwd,
      text,
      messageId: update.updateId,
    });
    if (!out.text) continue;

    const send = await fetchImpl(new URL('/v1/messages', campfireBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatId: update.chatId,
        text: out.text,
        clientMsgId: `wb:${update.updateId}`,
        replyTo: update.message.id,
      }),
    });
    if (!send.ok) throw new Error(`回发失败 ${send.status}`);
    handled += 1;
  }

  if (body.nextCursor !== undefined) {
    await fetchImpl(new URL('/v1/updates/ack', campfireBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${channelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat: body.updates?.[0]?.chatId || cfg.chatId || 'main', cursor: body.nextCursor }),
    });
  }

  log?.info?.(`[workbuddy] 本轮处理 ${handled} 条，cursor=${body.nextCursor}`);
  return { handled, nextCursor: body.nextCursor };
}

/** 常驻循环：失败退避，收到 stop 信号优雅退出。 */
export async function runBridge(cfg, { fetchImpl = fetch, log = null, signal = null, intervalMs = 2000 } = {}) {
  const token = readTokenFile(cfg.tokenFile);
  const gateway = await startAcpGateway({
    cliBin: cfg.cliBin,
    configDir: cfg.configDir,
    token,
    password: cfg.password,
    cwd: cfg.cwd,
    log,
  });

  const acp = new AcpClient({ baseUrl: gateway.baseUrl, password: cfg.password, log });
  await acp.connect();
  await acp.initialize({ name: 'campfire-bridge', version: '1' });

  const bridge = new WorkBuddyBridge({
    acp,
    sessionIndex: cfg.dbPath ? new SessionIndex({ dbPath: cfg.dbPath }) : null,
    log,
  });

  let stopped = false;
  const stop = () => { stopped = true; };
  signal?.addEventListener?.('abort', stop);

  let backoff = intervalMs;
  while (!stopped) {
    try {
      await runOnce({ cfg, bridge, fetchImpl, log });
      backoff = intervalMs;
    } catch (err) {
      log?.warn?.(`[workbuddy] 本轮失败：${err.message}`);
      backoff = Math.min(backoff * 2, 30_000);
    }
    await sleep(backoff);
  }

  await gateway.stop();
  return { stopped: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 直接运行：node src/bridges/workbuddy/run.js
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bridges/workbuddy/run.js');
if (isMain) {
  const { logger } = await import('../../logger.js');
  const log = logger.child('workbuddy');
  const cfg = { ...configFromEnv(process.env), log };
  runBridge(cfg, { log }).catch((err) => {
    log.error(`桥启动失败：${err.message}`);
    process.exit(1);
  });
}
