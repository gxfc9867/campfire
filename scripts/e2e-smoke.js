import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 端到端冒烟：桥 + sidecar + 一个假的 CLI。
 *
 * 验证的是整条链路真的能跑通——从「主人在群里 @ 一个成员」到
 * 「成员被唤起、拿到提示词、把回复写回群里」，中间不 mock 任何一跳。
 *
 * 假的 CLI 用 `node -e` 实现：从 stdin 读提示词，输出一段固定文本。
 * 这样不需要任何真实 agent 的账号或额度。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

process.env.LOG_LEVEL = 'error';
const { createApp } = await import('../src/server.js');

const FAKE_CLI = `
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const hasPersona = input.includes('[人设]');
  const hasChat = input.includes('[当前群聊');
  console.log('我是假成员，看到 ' + input.length + ' 字，人设=' + hasPersona + '，上下文=' + hasChat);
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, msg) {
  console.log(`  ${msg}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-e2e-'));
  let app;
  let sidecar;

  try {
    console.log('1. 启动桥');
    app = createApp({
      config: {
        dataDir: dir,
        port: 0,
        host: '127.0.0.1',
        ownerKey: 'e2e-owner',
        ownerKeySource: 'env',
        ownerKeyGenerated: false,
      },
    });
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;
    log('ok', `桥在 ${base}`);

    console.log('2. 主人登录');
    let cookie = '';
    const req = async (method, p, body, extra = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.getSetCookie?.() || [];
      if (sc.length) cookie = sc[0].split(';')[0];
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    };

    const login = await req('POST', '/api/login', { password: 'e2e-owner' });
    if (login.status !== 200) throw new Error('登录失败');
    log('ok', '已登录');

    console.log('3. 创建成员（cli 驱动，真跑 node）');
    const created = await req('POST', '/api/members', {
      handle: 'bot',
      display: '假成员',
      persona: '你是一个测试用的成员。',
      driver: {
        type: 'cli',
        cmd: process.execPath,
        args: ['-e', FAKE_CLI],
        promptStdin: true,
        timeoutMs: 30_000,
      },
      chats: ['main'],
    });
    if (created.status !== 200) throw new Error(`创建成员失败 ${JSON.stringify(created.data)}`);
    const key = created.data.key;
    log('ok', `成员 bot 已创建，密钥 ${key.slice(0, 4)}…`);

    console.log('4. 启动 sidecar');
    const cfgFile = path.join(dir, 'sidecar.config.json');
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({ url: base, concurrency: 1, members: [{ handle: 'bot', key, waitSec: 5 }] }, null, 2),
    );
    sidecar = spawn(process.execPath, [path.join(ROOT, 'sidecar', 'sidecar.js')], {
      env: { ...process.env, CAMPFIRE_CONFIG: cfgFile, LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let sidecarOut = '';
    sidecar.stdout.on('data', (d) => (sidecarOut += d));
    sidecar.stderr.on('data', (d) => (sidecarOut += d));

    // 等 sidecar 完成第一次长轮询注册
    await sleep(1200);

    const status = await req('GET', '/api/status?chat=main');
    const bot = status.data.members.find((m) => m.handle === 'bot');
    if (!bot?.presence?.reachable) {
      throw new Error(`sidecar 没有连上桥：${JSON.stringify(bot?.presence)}\n${sidecarOut}`);
    }
    log('ok', `sidecar 已连接（状态 ${bot.online}）`);

    console.log('5. 在群里 @ 它');
    const t0 = Date.now();
    const sent = await req('POST', '/api/messages', { chat: 'main', text: '@bot 你好，测试唤醒' });
    if (sent.status !== 200) throw new Error('发消息失败');
    if (!sent.data.jobs.length) throw new Error('没有生成投递任务');
    log('ok', `投递已创建（${sent.data.jobs[0].handle}）`);

    console.log('6. 等它回复');
    let reply = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const msgs = await req('GET', '/api/messages?chat=main');
      reply = msgs.data.messages.find((m) => m.sender === 'bot');
      if (reply) break;
    }
    const elapsed = Date.now() - t0;

    if (!reply) throw new Error(`10 秒内没有收到回复。sidecar 输出：\n${sidecarOut}`);
    log('ok', `${elapsed}ms 后收到回复`);

    console.log('7. 校验内容');
    if (!reply.text.includes('[人设]') && !reply.text.includes('人设=true')) {
      throw new Error(`回复里没有体现三层记忆：${reply.text}`);
    }
    if (!reply.text.includes('上下文=true')) {
      throw new Error(`提示词里缺群内上下文：${reply.text}`);
    }
    log('ok', `回复内容：${reply.text}`);

    console.log('8. 校验投递状态');
    const jobs = await req('GET', '/api/jobs?chat=main');
    const job = jobs.data.jobs.find((j) => j.handle === 'bot');
    if (job?.status !== 'done') throw new Error(`投递状态应为 done，实际 ${job?.status}`);
    log('ok', '投递已完成');

    console.log('\n全部通过。');
  } finally {
    sidecar?.kill();
    await sleep(200);
    await app?.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('\n冒烟失败：', e.message);
  process.exitCode = 1;
});
