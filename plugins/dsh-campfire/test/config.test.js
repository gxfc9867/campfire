import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG, describeConfig, resolveConfig } from '../src/config.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'campfire-config-'));
}

test('无配置时给出安全默认值：不拉流、不猜地址', async () => {
  const dir = await tempDir();
  const config = await resolveConfig({}, { env: { DSH_HOME: dir } });
  assert.equal(config.baseUrl, '');
  assert.equal(config.memberHandle, 'facai');
  assert.deepEqual(config.chatIds, ['main']);
  assert.equal(config.sessionScope, 'member');
  assert.equal(config.wait, 25);
  assert.equal(config.stateFile, path.join(dir, 'campfire', 'state.json'));
  assert.equal(config.configFile, path.join(dir, 'campfire', 'config.json'));
});

test('优先级：行内 config > 环境变量 > 配置文件 > 默认值', async () => {
  const dir = await tempDir();
  const configFile = path.join(dir, 'cfg.json');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(
    configFile,
    JSON.stringify({ baseUrl: 'http://from-file:1', memberHandle: 'file-member', chatIds: ['file-chat'] }),
  );

  const config = await resolveConfig(
    { memberHandle: 'row-member' },
    {
      env: {
        DSH_HOME: dir,
        CAMPFIRE_CONFIG_FILE: configFile,
        CAMPFIRE_BASE_URL: 'http://from-env:2',
        CAMPFIRE_MEMBER: 'env-member',
      },
    },
  );

  assert.equal(config.baseUrl, 'http://from-env:2');
  assert.equal(config.memberHandle, 'row-member');
  assert.deepEqual(config.chatIds, ['file-chat']);
});

test('配置文件解析失败只告警，不阻断启动', async () => {
  const dir = await tempDir();
  const configFile = path.join(dir, 'broken.json');
  await fs.writeFile(configFile, '{ not json');
  const warnings = [];
  const config = await resolveConfig(
    {},
    { env: { DSH_HOME: dir, CAMPFIRE_CONFIG_FILE: configFile }, log: (level, message) => warnings.push([level, message]) },
  );
  assert.equal(config.baseUrl, '');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'warn');
});

test('token 解析顺序：行内 > tokenEnv > tokenFile', async () => {
  const dir = await tempDir();
  const secretFile = path.join(dir, 'token.txt');
  await fs.writeFile(secretFile, '  from-file-token\n');

  const fromFile = await resolveConfig({ tokenFile: secretFile }, { env: { DSH_HOME: dir } });
  assert.equal(fromFile.token, 'from-file-token');

  const fromEnv = await resolveConfig({ tokenFile: secretFile }, { env: { DSH_HOME: dir, CAMPFIRE_TOKEN: 'from-env' } });
  assert.equal(fromEnv.token, 'from-env');

  const fromRow = await resolveConfig({ tokenFile: secretFile, token: 'from-row' }, { env: { DSH_HOME: dir, CAMPFIRE_TOKEN: 'from-env' } });
  assert.equal(fromRow.token, 'from-row');
});

test('chatIds 支持逗号分隔字符串并去空', async () => {
  const dir = await tempDir();
  const config = await resolveConfig({ chatIds: ' main , ,nas ' }, { env: { DSH_HOME: dir } });
  assert.deepEqual(config.chatIds, ['main', 'nas']);
});

test('数值字段做区间钳制，非法值回落默认', async () => {
  const dir = await tempDir();
  const config = await resolveConfig(
    { wait: 999, limit: 0, replyTimeoutMs: 1, maxReplyChars: -5, sessionScope: 'weird' },
    { env: { DSH_HOME: dir } },
  );
  assert.equal(config.wait, 30);
  assert.equal(config.limit, 1);
  assert.equal(config.replyTimeoutMs, 5_000);
  assert.equal(config.maxReplyChars, 200);
  assert.equal(config.sessionScope, 'member');
});

test('baseUrl 去掉尾部斜杠，DSH_HOME 缺失时回落到用户目录', async () => {
  const config = await resolveConfig({ baseUrl: 'http://x:1///' }, { env: {} });
  assert.equal(config.baseUrl, 'http://x:1');
  assert.ok(config.stateFile.includes('campfire'));
});

test('describeConfig 不回显 token 明文', async () => {
  const dir = await tempDir();
  const config = await resolveConfig({ baseUrl: 'http://x:1', token: 'super-secret-token' }, { env: { DSH_HOME: dir } });
  const line = describeConfig(config);
  assert.match(line, /token=已配置/);
  assert.ok(!line.includes('super-secret-token'));
});

test('DEFAULT_CONFIG 不被解析过程改写', async () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  await resolveConfig({ chatIds: ['other'] }, { env: { DSH_HOME: await tempDir() } });
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
});
