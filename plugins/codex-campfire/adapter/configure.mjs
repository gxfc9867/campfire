#!/usr/bin/env node
/**
 * 围炉接入 · 统一配置核心（跨平台 Node）
 *
 * 三条接入路径都调用它，区别只在"怎么把三个参数给到它"：
 *   路径1 MCP 表单：MCP server 收到表单后用这三个参数调它
 *   路径2 skill 引导：Codex 引导用户给出三个值后调它
 *   路径3 围炉网页：网页生成这条命令，用户在终端粘贴执行
 *
 * 用法：
 *   node configure.mjs --base URL --token TOKEN --member HANDLE [--chat main]
 *   node configure.mjs --code "campfire://setup?..."      # 也支持配置码
 *
 * 职责：自动从桌面会话索引选两条会话 → 写 .env → 调 launch.ps1 点火。
 * 用户不需要手填任何会话 ID，也不需要理解 caller/target。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
// CAMPFIRE_CONFIG_DIR lets tests / custom installs override the config location.
const CFG_DIR = process.env.CAMPFIRE_CONFIG_DIR || path.join(HOME, '.campfire-codex');
const ENV_FILE = path.join(CFG_DIR, '.env');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

const out = (m) => console.log('[围炉] ' + m);
const die = (m) => { console.error('[围炉] 出错：' + m); process.exit(1); };

// ---- 解析参数 ----
function parseArgv(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--code' && argv[i + 1]) { o.code = argv[++i]; continue; }
    const m = a.match(/^--(base|token|member|chat|memberThread|senderThread)$/);
    if (m && argv[i + 1] !== undefined) { o[m[1]] = argv[++i]; continue; }
  }
  return o;
}

function decodeCode(code) {
  const m = String(code).match(/^campfire:\/\/setup\?(.+)$/);
  if (!m) die('配置码格式不对，应以 campfire://setup? 开头');
  let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const json = Buffer.from(b64, 'base64').toString('utf8');
  const o = JSON.parse(json);
  if (!o.base || !o.token || !o.member) die('配置码内容不完整');
  return o;
}

const args = parseArgv(process.argv.slice(2));
let cfg = args;
if (args.code) {
  try { cfg = decodeCode(args.code); } catch (e) { die('解析配置码失败：' + e.message); }
  // 显式会话参数不能被配置码覆盖（修 --code 会冲掉 --memberThread 的 bug）
  if (args.memberThread) cfg.memberThread = args.memberThread;
  if (args.senderThread) cfg.senderThread = args.senderThread;
  if (args.chat) cfg.chat = args.chat;
}
const base = String(cfg.base || '').trim();
const token = String(cfg.token || '').trim();
const member = String(cfg.member || '').trim();
const chat = String(cfg.chat || 'main').trim();
if (!base || !token || !member) {
  die('缺少参数。需要 --base（围炉地址）--token（渠道令牌）--member（成员名）三项。');
}
if (!/^https?:\/\//.test(base)) die('围炉地址要以 http:// 或 https:// 开头');

// ---- 会话选择：直接接入当前会话，不要求命名、不按标题匹配、不读易脏的索引标题 ----
// 规则：
//   1. 成员会话 = 显式传进来的 memberThread（GPT 方式 A 会把"当前会话 ID"传进来），
//      没传就取列表第一条会话（终端命令方式 C）。
//   2. 发话口 = 另一条不同的会话；不足则明确报错。
//   3. 只要两条不同会话即可，不再要求任何标题、不再因改名/索引旧行失败。
function pickThreads() {
  const idx = path.join(CODEX_HOME, 'session_index.jsonl');
  const list = [];
  if (fs.existsSync(idx)) {
    for (const line of fs.readFileSync(idx, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.id) list.push({ id: String(o.id) }); } catch { /* 跳过坏行 */ }
    }
  }
  const sessDir = path.join(CODEX_HOME, 'sessions');
  if (fs.existsSync(sessDir)) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.jsonl')) continue;
        const mm = e.name.match(/-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/);
        if (mm && !list.some((t) => t.id === mm[1])) list.push({ id: mm[1] });
      }
    };
    try { walk(sessDir); } catch { /* 忽略 */ }
  }
  const seen = new Set();
  return list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}
const threads = pickThreads();
const memberThread = cfg.memberThread || (threads[0] && threads[0].id);
if (!memberThread) {
  die('桌面端找不到任何会话。请先打开 GPT 桌面端、有至少一条会话，再重跑本命令。');
}
const senderThread = cfg.senderThread || (threads.find((t) => t.id !== memberThread) || {}).id;
if (!senderThread || senderThread === memberThread) {
  die('桌面端还需要另一条不同会话用来在后台发话。请再新建或打开一条会话，然后重跑本命令。');
}

// ---- 写 .env（run.ps1 已支持读取）----
const envLines = [
  '# 由围炉统一配置核心生成',
  'CAMPFIRE_BASE_URL=' + base,
  'CAMPFIRE_CHANNEL_TOKEN=' + token,
  'CAMPFIRE_MEMBER=' + member,
  'CAMPFIRE_CHAT=' + chat,
  'CODEX_THREAD_ID=' + memberThread,
  'CODEX_CALLER_THREAD_ID=' + senderThread,
  'CODEX_HOST_ID=local',
  'CODEX_POLL_WAIT=25',
  'CODEX_POLL_LIMIT=20',
  'CODEX_INTERVAL_MS=1000',
  'CODEX_MAX_REPLY_MS=120000',
  'LOG_LEVEL=info',
];
fs.mkdirSync(CFG_DIR, { recursive: true });
fs.writeFileSync(ENV_FILE, envLines.join('\n') + '\n', 'utf8');
out('配置已保存。');
out('  围炉地址：' + base);
out('  成员：' + member);
out('  群里的回答会进这条会话：' + (threads.find((t) => t.id === memberThread)?.title || memberThread));

// ---- 点火（Windows 走 launch.ps1 无窗口启动；其它平台按文档手动启动）----
function adapterAliveWin() {
  // launch.ps1 用 WMI 拉起 run.ps1；查命令行里带 run.ps1 且指向本插件的进程。
  const ps = "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'codex-campfire' -and $_.CommandLine -match 'run[.]ps1' } | Select-Object -First 1 -ExpandProperty ProcessId";
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });
  const pid = (r.stdout || '').trim();
  return /^\d+$/.test(pid) ? pid : null;
}

// 重新配置时，旧适配器进程内存里还是旧令牌 —— launch.ps1 的幂等检查会跳过启动，
// 导致一直 401。所以点火前必须先杀掉旧进程，确保新配置生效。
function killAdaptersWin() {
  const ps = "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'codex-campfire' -and $_.CommandLine -match 'run[.]ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
}

if (process.platform === 'win32') {
  const launch = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'launch.ps1');
  if (!fs.existsSync(launch)) {
    die('配置已写好，但没找到 launch.ps1（' + launch + '）；请把插件装完整后重试。');
  }
  // 先停旧进程（可能还持有旧令牌），再启动新的
  const killed = killAdaptersWin();
  if (killed) out('已停掉旧适配器进程：' + killed.replace(/\s+/g, ','));
  spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launch],
    { windowsHide: true, stdio: 'ignore' });
  // 验证适配器真的起来了，不再"假成功"
  let pid = null;
  for (let i = 0; i < 10 && !pid; i++) {
    pid = adapterAliveWin();
    if (!pid) {
      const wait = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1000'], { windowsHide: true });
      void wait;
    }
  }
  if (pid) {
    out('适配器已在后台运行（进程 ' + pid + '），无窗口。回群里 @' + member + ' 发句话试试。');
    const log = path.join(CFG_DIR, 'adapter.log');
    out('如没回复，看日志：' + log);
  } else {
    die('配置已写好，但适配器没能启动。请看 ignite.log：' + path.join(CFG_DIR, 'ignite.log') + '。常见原因是 GPT 桌面端没开或管道未就绪，打开 GPT 桌面端后重跑本命令即可。');
  }
} else {
  out('配置已写好。Mac/Linux 请按文档启动适配器，然后回群里 @' + member + ' 试试。');
}
