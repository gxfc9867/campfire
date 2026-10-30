import { spawn } from 'node:child_process';

/**
 * 起一个 codebuddy ACP 网关子进程。
 *
 * 这段代码的每一行都对应一个实测过的坑（见 HANDOFF-WORKBUDDY-BRIDGE）：
 * - 必须先清掉从 App 继承来的 CODEBUDDY_* / WORKBUDDY_* 与 SERVER__PORT，
 *   否则子进程会去抢 App 自己的端口（EADDRINUSE）；
 * - token 用 CODEBUDDY_AUTH_TOKEN 注入，绝不调 authenticate（会注销桌面登录态）；
 * - 端口从 stdout 的 Endpoint 行解析，不用固定端口。
 */
export async function startAcpGateway({
  cliBin,
  configDir,
  token,
  password,
  cwd,
  port = 0,
  spawnImpl = spawn,
  env = process.env,
  log = null,
  waitMs = 60_000,
} = {}) {
  if (!cliBin) throw new Error('startAcpGateway 需要 cliBin');
  if (!configDir) throw new Error('startAcpGateway 需要 configDir');
  if (!token) throw new Error('startAcpGateway 需要 token');
  if (!password) throw new Error('startAcpGateway 需要 password');

  const childEnv = { ...env };
  delete childEnv.SERVER__PORT;
  for (const k of Object.keys(childEnv)) {
    if (/^(CODEBUDDY_|WORKBUDDY_)/i.test(k)) delete childEnv[k];
  }
  Object.assign(childEnv, {
    CODEBUDDY_CONFIG_DIR: configDir,
    CODEBUDDY_GATEWAY_PASSWORD: password,
    CODEBUDDY_AUTH_TOKEN: token,
    CODEBUDDY_DISABLE_PROXY_CONFIG_FILE: '1',
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
    CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
  });

  const child = spawnImpl(process.execPath, [cliBin, '--serve', '--acp', '--port', String(port)], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      try { child.kill(); } catch {}
      reject(new Error(`ACP 网关启动超时（${waitMs}ms）`));
    }, waitMs);

    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        cleanup();
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`ACP 网关退出（code=${code}）：${buf.slice(-400)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off?.('data', onData);
      child.off?.('exit', onExit);
    };

    child.stdout?.on?.('data', onData);
    child.on?.('exit', onExit);
    // stderr 只留最后一段，出错时能给点线索
    child.stderr?.on?.('data', (d) => {
      buf += d.toString();
      if (buf.length > 8000) buf = buf.slice(-4000);
    });
  });

  log?.info?.(`[workbuddy] ACP 网关就绪 ${baseUrl}`);

  return {
    baseUrl,
    child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
