import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startAcpGateway } from '../src/bridges/workbuddy/launcher.js';

/** 假 CLI：起一个 HTTP 服务、打印 Endpoint、把关键环境变量写盘供断言。 */
const FAKE_CLI = `
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((req, res) => { res.end('ok'); });
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.PROBE_ENV_FILE, JSON.stringify({
    SERVER_PORT: process.env.SERVER__PORT || null,
    AUTH: process.env.CODE_BUDDY_AUTH || process.env.CODEBUDDY_AUTH_TOKEN || null,
    CFG: process.env.CODEBUDDY_CONFIG_DIR || null,
  }));
  console.log('Endpoint    http://127.0.0.1:' + server.address().port);
});
setInterval(() => {}, 1000);
`;

test('launcher 清理环境、解析端口、可优雅停止', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-launcher-'));
  const cli = path.join(dir, 'fake-cli.cjs');
  const envFile = path.join(dir, 'env.json');
  fs.writeFileSync(cli, FAKE_CLI, 'utf8');

  const gw = await startAcpGateway({
    cliBin: cli,
    configDir: dir,
    token: 'tok-123',
    password: 'pw-123',
    cwd: dir,
    env: { ...process.env, SERVER__PORT: '59999', PROBE_ENV_FILE: envFile },
    waitMs: 15000,
  });

  assert.match(gw.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const probe = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  assert.equal(probe.SERVER_PORT, null, 'SERVER__PORT 必须被清掉');
  assert.equal(probe.AUTH, 'tok-123');
  assert.equal(probe.CFG, dir);

  await gw.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
