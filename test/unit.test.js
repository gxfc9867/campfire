import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTargets, hasBroadcast } from '../src/targets.js';
import { maskDriver } from '../src/members.js';

const candidates = [
  { handle: 'ruyi', display: '如意', aliases: ['小如'] },
  { handle: 'chen', display: '老陈', aliases: [] },
  { handle: 'fe', display: '阿飞', aliases: [] },
];

describe('@ 提及解析', () => {
  test('命中 handle', () => {
    assert.deepEqual(parseTargets('@ruyi 帮我看下', candidates).targets, ['ruyi']);
  });

  test('命中备注名', () => {
    assert.deepEqual(parseTargets('@如意 帮我看下', candidates).targets, ['ruyi']);
  });

  test('命中别名', () => {
    assert.deepEqual(parseTargets('@小如 在吗', candidates).targets, ['ruyi']);
  });

  test('英文 handle 需要词边界，@ruyi2 不该命中 ruyi', () => {
    assert.deepEqual(parseTargets('@ruyi2 你好', candidates).targets, []);
  });

  test('中文名后面紧跟正文也能命中', () => {
    assert.deepEqual(parseTargets('@如意你帮我看下', candidates).targets, ['ruyi']);
  });

  test('存在更长的同名候选时，优先命中长的那个', () => {
    const withLonger = [...candidates, { handle: 'ruyi2', display: '如意儿', aliases: [] }];
    assert.deepEqual(parseTargets('@如意儿 你好', withLonger).targets, ['ruyi2']);
    assert.deepEqual(parseTargets('@如意 你好', withLonger).targets, ['ruyi']);
  });

  test('大小写不敏感', () => {
    assert.deepEqual(parseTargets('@Ruyi 你好', candidates).targets, ['ruyi']);
  });

  test('可以同时点多人', () => {
    const r = parseTargets('@如意 @老陈 都看一下', candidates);
    assert.deepEqual(r.targets.sort(), ['chen', 'ruyi']);
  });

  test('@所有人 展开成全部成员', () => {
    const r = parseTargets('@所有人 开会', candidates);
    assert.equal(r.broadcast, true);
    assert.deepEqual(r.targets.sort(), ['chen', 'fe', 'ruyi']);
  });

  test('没有提及就是空', () => {
    assert.deepEqual(parseTargets('随便聊聊', candidates).targets, []);
    assert.equal(hasBroadcast('随便聊聊'), false);
  });

  test('@all 也算广播', () => {
    assert.equal(hasBroadcast('@all standup'), true);
  });
});

describe('驱动配置脱敏', () => {
  test('env 的值一律打码', () => {
    const out = maskDriver({ type: 'cli', cmd: 'claude', env: { API_KEY: 'sk-secret-value' } });
    assert.equal(out.env.API_KEY, '****');
    assert.ok(!JSON.stringify(out).includes('sk-secret-value'));
  });

  test('紧跟 --api-key 的参数被打码', () => {
    const out = maskDriver({ type: 'cli', cmd: 'claude', args: ['--api-key', 'abc123456789'] });
    assert.deepEqual(out.args, ['--api-key', '****']);
  });

  test('sk- 形态的长参数被打码', () => {
    const out = maskDriver({ type: 'cli', cmd: 'x', args: ['sk-abcdefghijklmn'] });
    assert.deepEqual(out.args, ['****']);
  });

  test('普通参数与路径不被误伤', () => {
    const out = maskDriver({ type: 'cli', cmd: 'workbuddy', args: ['-p', '{{prompt}}'], cwd: 'C:/Users/me/work' });
    assert.deepEqual(out.args, ['-p', '{{prompt}}']);
    assert.equal(out.cwd, 'C:/Users/me/work');
  });

  test('webhook 的 secret 打码', () => {
    const out = maskDriver({ type: 'webhook', url: 'http://x/hook', secret: 'topsecret' });
    assert.equal(out.secret, '****');
  });
});
