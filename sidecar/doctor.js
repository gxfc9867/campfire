#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, DEFAULTS } from './config.js';

/**
 * sidecar 自检。
 *
 * 配好 sidecar 后第一件想知道的事就是「它到底通没通」。
 * 没有这个命令，所有接入问题都会变成猜：
 * 是桥没起？密钥错？命令路径不对？还是 CLI 需要登录？
 *
 * 默认只做轻量检查（不调模型、不烧额度）；
 * 加 --deep 才会真跑一次空 prompt，用来确认 CLI 能正常吐出一段文本。
 */

const DEEP = process.argv.includes('--deep');
const COLOR = process.stdout.isTTY && process.platform !== 'win32';

const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);

const OK = green('✓');
const BAD = red('✗');
const WARN = yellow('!');

let failures = 0;
const pass = (msg) => console.log(`${OK} ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`${BAD} ${msg}`);
};
const warn = (msg) => console.log(`${WARN} ${msg}`);

function commandExists(cmd) {
  if (!cmd) return false;
  // 带路径分隔符的按路径判断，否则查 PATH
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return fs.existsSync(cmd);
  }
  const which = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(which, [cmd], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && Boolean(String(r.stdout || '').trim());
}

async function get(url, member, pathname) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${url}${pathname}`, {
      headers: member
        ? { 'X-Campfire-Member': member.handle, 'X-Campfire-Key': member.key }
        : {},
      signal: ctrl.signal,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(dim('围炉 sidecar 自检'));
  console.log(dim('─'.repeat(48)));

  let cfg;
  try {
    cfg = loadConfig();
    pass(`配置读取成功：${cfg.members.length} 个成员`);
  } catch (e) {
    fail(`配置读取失败：${e.message}`);
    if (e.hint) console.log(`  ${dim(e.hint)}`);
    return finish();
  }

  // 1. 桥可达
  let health;
  try {
    const r = await get(cfg.url, null, '/api/health');
    if (r.status !== 200 || !r.data?.ok) {
      fail(`桥返回异常状态 ${r.status}`);
    } else {
      health = r.data;
      pass(`桥可达 ${cfg.url}（版本 ${health.version}，成员 ${health.members} 位）`);
    }
  } catch (e) {
    fail(`连不上桥 ${cfg.url}：${e.message}`);
    console.log(`  ${dim('检查桥是否启动、地址是否写对、是否需要走内网或反代')}`);
    return finish();
  }

  // 2. 逐个成员
  for (const member of cfg.members) {
    const { status, data } = await get(cfg.url, member, '/api/agent/profile').catch((e) => ({
      status: 0,
      data: { error: e.message },
    }));

    if (status === 401) {
      fail(`${member.handle} 鉴权失败：密钥不正确，或成员已被归档/轮换`);
      continue;
    }
    if (status !== 200 || !data) {
      fail(`${member.handle} 拉取档案失败：${data?.error || status}`);
      continue;
    }

    pass(`${member.handle} 鉴权通过（备注名：${data.display}）`);

    if (!data.chats?.length) {
      warn(`${member.handle} 还没有加入任何会话，收到消息也看不到上下文`);
    } else {
      pass(`${member.handle} 在 ${data.chats.length} 个会话中：${data.chats.map((c) => c.name).join('、')}`);
    }

    const driver = data.driver || {};
    if (driver.type !== 'cli') {
      warn(`${member.handle} 的驱动是 ${driver.type}，不需要 sidecar 起进程`);
      continue;
    }

    if (!driver.cmd) {
      fail(`${member.handle} 没有配置命令`);
      continue;
    }

    if (commandExists(driver.cmd)) {
      pass(`命令存在：${driver.cmd}`);
    } else {
      fail(`找不到命令 ${driver.cmd}（检查 PATH，或写成绝对路径）`);
      console.log(`  ${dim('Windows 上 .cmd/.bat 需要在成员配置里打开 shell 选项')}`);
      continue;
    }

    if (cfg.allowedCommands && !cfg.allowedCommands.includes(driver.cmd)) {
      fail(`${driver.cmd} 不在 sidecar 白名单 allowedCommands 里，运行时会被拒绝`);
    }

    // 3. 深度检查（可选，会真的调一次模型）
    if (DEEP) {
      console.log(`  ${dim('深度检查：跑一次空 prompt…')}`);
      const hasPh = (driver.args || []).some((a) => a.includes('{{prompt}}'));
      const args = (driver.args || []).map((a) => a.replaceAll('{{prompt}}', '只回复两个字母：OK'));
      const r = spawnSync(driver.cmd, args, {
        encoding: 'utf8',
        timeout: driver.timeoutMs || 180_000,
        shell: Boolean(driver.shell),
        cwd: driver.cwd || undefined,
        env: { ...process.env, ...(driver.env || {}) },
        input: hasPh ? undefined : '只回复两个字母：OK',
        windowsHide: true,
      });
      if (r.error) fail(`${member.handle} 执行失败：${r.error.message}`);
      else if (r.status !== 0) fail(`${member.handle} 退出码 ${r.status}：${(r.stderr || '').slice(0, 200)}`);
      else if (!String(r.stdout || '').trim()) fail(`${member.handle} 没有任何输出`);
      else pass(`${member.handle} 实跑成功，输出 ${String(r.stdout).trim().length} 字符`);
    }

    // 4. 轮询参数（只是信息，不算失败）
    console.log(`  ${dim(`长轮询挂起 ${DEFAULTS.waitSec}s，本机并发上限 ${cfg.concurrency || DEFAULTS.concurrency}`)}`);
  }

  return finish();
}

function finish() {
  console.log(dim('─'.repeat(48)));
  if (failures) {
    console.log(red(`有 ${failures} 项没通过`));
    process.exitCode = 1;
  } else {
    console.log(green('全部通过'));
    if (!DEEP) console.log(dim('提示：加 --deep 会真跑一次命令，确认能正常返回文本'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
