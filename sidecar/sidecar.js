#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { DEFAULTS, loadConfig } from './config.js';

/**
 * 围炉 sidecar。
 *
 * 常驻在「有 agent CLI 的那台机器」上，职责只有三件：
 *   1. 长轮询从桥收信；
 *   2. 需要的时候起一个 CLI 进程，把提示词喂进去，拿回一条回复；
 *   3. 把状态如实上报，让前端知道现在能不能秒回。
 *
 * 它不执行桥发来的任意命令——命令来自主人写在桥上的成员配置，
 * sidecar 只是「自愿执行者」，可以在本地加白名单（见 allowedCommands）。
 *
 * 关于「休眠」：退出的是 agent 进程，不是 sidecar。
 * sidecar 一旦退出，就没有人去接唤醒指令，成员会永远醒不过来。
 * 所以这里的「静默」是指降到低频轮询，CPU 占用趋近于零，但保持可达。
 */

function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}

// ── HTTP ────────────────────────────────────────────────────────────

class BridgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(member, method, pathname, body, { url, timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${pathname}`, {
      method,
      headers: {
        'X-Campfire-Member': member.handle,
        'X-Campfire-Key': member.key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new BridgeError(res.status, data?.error || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 并发闸门 ────────────────────────────────────────────────────────

/** 本机同时最多跑 N 个 agent 进程；超出的排队，不丢。 */
class Slots {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.running >= this.limit) await new Promise((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ── CLI 执行 ────────────────────────────────────────────────────────

/**
 * 起一个 CLI 进程跑一轮。
 * 提示词替换到 args 的 {{prompt}} 占位符；没有占位符就写 stdin——
 * 后者更安全，长文本不会撞上命令行长度限制，也不会有转义问题。
 */
function execCli(driver, prompt, { timeoutMs, allowedCommands }) {
  return new Promise((resolve, reject) => {
    if (allowedCommands && !allowedCommands.includes(driver.cmd)) {
      return reject(new Error(`命令 ${driver.cmd} 不在 sidecar 白名单内`));
    }

    const hasPlaceholder = driver.args.some((a) => a.includes('{{prompt}}'));
    const args = driver.args.map((a) => a.replaceAll('{{prompt}}', prompt));

    let child;
    try {
      child = spawn(driver.cmd, args, {
        cwd: driver.cwd || undefined,
        env: { ...process.env, ...(driver.env || {}) },
        shell: Boolean(driver.shell),
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }

    let stdout = '';
    let stderr = '';
    const started = Date.now();

    const timer = setTimeout(() => {
      // 卡死的 CLI 必须被杀，否则会永久占住并发名额
      child.kill('SIGKILL');
      reject(new Error(`执行超时（${Math.round(timeoutMs / 1000)}s），已终止进程`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${driver.cmd}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        return reject(new Error(`退出码 ${code}（${ms}ms）：${(stderr || stdout).slice(0, 300)}`));
      }
      const text = stdout.trim();
      if (!text) return reject(new Error('命令没有任何输出'));
      resolve(text);
    });

    if (!hasPlaceholder || driver.promptStdin) {
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }
  });
}

// ── 成员循环 ────────────────────────────────────────────────────────

async function runMember(member, shared) {
  const cfg = { ...DEFAULTS, ...member };
  let backoff = 1000;

  /**
   * 上报状态。
   *
   * 这里必须诚实地说清一件事：sidecar 是**常驻**的，一直在长轮询，不做「降温降频」。
   * 原因很简单——一旦降低轮询频率，成员被 @ 时最多要等一个轮询周期才被发现，
   * 静默省下的那点电，换来的是几十秒的响应延迟，不值。
   *
   * 真正会「休眠」的是 agent 进程：cli 型本来就一问一答、跑完即退。
   * 所以这里上报的 running 才是「能不能秒回」的依据，而不是轮询频率。
   */
  async function report(state, extra = {}) {
    try {
      await call(
        member,
        'POST',
        '/api/agent/state',
        {
          state,
          pid: process.pid,
          running: shared.slots.running,
          limit: shared.slots.limit,
          ...extra,
        },
        { url: shared.url, timeoutMs: 8000 },
      );
    } catch {
      // 状态上报失败不影响收信
    }
  }

  log(`${member.handle} 开始轮询 ${shared.url}（挂起 ${cfg.waitSec}s）`);

  while (!shared.stopping) {
    await report('hot');

    try {
      const data = await call(member, 'GET', `/api/agent/inbox?wait=${cfg.waitSec}`, undefined, {
        url: shared.url,
        // 客户端超时必须比服务端挂起更长，否则每次都会被自己掐断
        timeoutMs: (cfg.waitSec + 20) * 1000,
      });
      backoff = 1000;

      if (data.items?.length) {
        await handleItems(member, data.items, shared, report);
      }
    } catch (e) {
      if (shared.stopping) break;
      if (e instanceof BridgeError && e.status === 401) {
        log(`${member.handle} 鉴权失败：检查密钥是否正确（成员被轮换或归档？）`);
        await sleep(30_000);
        continue;
      }
      log(`${member.handle} 轮询异常：${e.message}，${backoff / 1000}s 后重试`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  await report('cold').catch(() => {});
  log(`${member.handle} 已停止`);
}

async function handleItems(member, items, shared, report) {
  // 同一个群的多条消息合并成一次调用：既省冷启动，也避免回复顺序错乱
  const byChat = new Map();
  for (const it of items) {
    if (!byChat.has(it.chatId)) byChat.set(it.chatId, []);
    byChat.get(it.chatId).push(it);
  }

  for (const [chatId, list] of byChat) {
    await shared.slots.run(async () => {
      // 进闸门后立刻上报 running=1，前端据此把「可唤醒」切成「就绪」
      await report('hot');
      try {
        const profile = await getProfile(member, shared);
        const last = list[list.length - 1];
        const trigger = `刚才有 ${list.length} 条新消息，最后一条来自 ${last.senderName}。请回应。`;

        const { prompt } = await call(
          member,
          'GET',
          `/api/agent/prompt?chat=${encodeURIComponent(chatId)}&trigger=${encodeURIComponent(trigger)}`,
          undefined,
          { url: shared.url, timeoutMs: 10_000 },
        );

        const driver = profile.driver || {};
        if (driver.type !== 'cli') {
          // pull 型成员不该走到这里，留着防止配置漂移
          log(`${member.handle} 的驱动不是 cli，跳过`);
          return;
        }

        log(`${member.handle} 起进程处理 ${list.length} 条（${chatId}）`);
        const text = await execCli(driver, prompt, {
          timeoutMs: driver.timeoutMs || 180_000,
          allowedCommands: shared.allowedCommands,
        });

        // 回复挂在最后一条上，前面几条显式确认，避免它们挂到超时
        await call(member, 'POST', '/api/agent/reply', { requestId: last.requestId, text }, {
          url: shared.url,
          timeoutMs: 15_000,
        });
        const rest = list.slice(0, -1).map((i) => i.requestId);
        if (rest.length) {
          await call(member, 'POST', '/api/agent/ack', { requestIds: rest }, { url: shared.url, timeoutMs: 10_000 });
        }
        log(`${member.handle} 已回执 ${list.length} 条`);
      } catch (e) {
        // 不 ack：让这批投递按桥上配置的等待上限自然降级，用户能看到「没处理」而不是被吞掉
        log(`${member.handle} 处理失败：${e.message}`);
      }
    });
    // 出闸门后补一次上报：此时 running 已归零，前端把「就绪」切回「可唤醒」
    await report('hot');
  }
}

/** 档案缓存 60 秒，避免每批消息都多一次请求。 */
async function getProfile(member, shared) {
  const now = Date.now();
  if (member._profile && now - member._profileAt < 60_000) return member._profile;
  const profile = await call(member, 'GET', '/api/agent/profile', undefined, {
    url: shared.url,
    timeoutMs: 10_000,
  });
  member._profile = profile;
  member._profileAt = now;
  return profile;
}

// ── 入口 ────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const shared = {
    url: cfg.url,
    stopping: false,
    allowedCommands: cfg.allowedCommands ?? null,
    slots: new Slots(Number(cfg.concurrency) || DEFAULTS.concurrency),
  };

  log(`sidecar 启动：${cfg.url}，${cfg.members.length} 个成员，并发上限 ${shared.slots.limit}`);

  const stop = () => {
    if (shared.stopping) return;
    shared.stopping = true;
    log('收到退出信号，正在停止…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await Promise.all(cfg.members.map((m) => runMember(m, shared)));
  process.exit(0);
}

main().catch((e) => {
  console.error('sidecar 启动失败：', e.message);
  process.exit(1);
});
