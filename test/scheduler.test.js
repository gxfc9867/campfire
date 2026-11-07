import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCron, matches, nextRun, validateCron, describeCron } from '../src/cron.js';
import { startScheduler, computeNextRun, newScheduleId } from '../src/scheduler.js';
import { SENDER } from '../src/constants.js';

/** 用本地时间构造，cron 的判断也走本地时区，两边对齐。 */
function local(y, m, d, hh, mm, ss = 0) {
  return new Date(y, m - 1, d, hh, mm, ss).getTime();
}

// ── cron 解析 ───────────────────────────────────────────────────────

test('cron：星号匹配全部', () => {
  const p = parseCron('* * * * *');
  assert.equal(p.minute.size, 60);
  assert.equal(p.hour.size, 24);
  assert.equal(p.weekday.size, 7);
});

test('cron：具体值', () => {
  const p = parseCron('30 9 * * *');
  assert.deepEqual([...p.minute], [30]);
  assert.deepEqual([...p.hour], [9]);
});

test('cron：步长 */30', () => {
  const p = parseCron('*/30 * * * *');
  assert.deepEqual([...p.minute].sort((a, b) => a - b), [0, 30]);
});

test('cron：范围与列表', () => {
  const p = parseCron('0 9-11 * * 1,3,5');
  assert.deepEqual([...p.hour].sort((a, b) => a - b), [9, 10, 11]);
  assert.deepEqual([...p.weekday].sort((a, b) => a - b), [1, 3, 5]);
});

test('cron：范围带步长 1-10/3', () => {
  const p = parseCron('1-10/3 * * * *');
  assert.deepEqual([...p.minute].sort((a, b) => a - b), [1, 4, 7, 10]);
});

test('cron：周日写 7 等同 0', () => {
  const p = parseCron('0 9 * * 7');
  assert.deepEqual([...p.weekday], [0]);
});

test('cron：拒绝非法表达式', () => {
  assert.throws(() => parseCron(''), /为空/);
  assert.throws(() => parseCron('0 9 * *'), /5 段/);
  assert.throws(() => parseCron('60 * * * *'), /超范围/);
  assert.throws(() => parseCron('* 24 * * *'), /超范围/);
  assert.throws(() => parseCron('*/0 * * * *'), /步长非法/);
  assert.throws(() => parseCron('abc * * * *'), /不是整数/);
});

// ── 命中与下一次 ────────────────────────────────────────────────────

test('matches：每天 9 点', () => {
  const p = parseCron('0 9 * * *');
  assert.equal(matches(p, new Date(local(2026, 11, 7, 9, 0))), true);
  assert.equal(matches(p, new Date(local(2026, 11, 7, 9, 1))), false);
  assert.equal(matches(p, new Date(local(2026, 11, 7, 10, 0))), false);
});

test('matches：每周一 9 点', () => {
  const p = parseCron('0 9 * * 1');
  // 2026-11-09 是周一
  assert.equal(matches(p, new Date(local(2026, 11, 9, 9, 0))), true);
  // 2026-11-07 是周六
  assert.equal(matches(p, new Date(local(2026, 11, 7, 9, 0))), false);
});

test('nextRun：从当前时间往后找，跳过当前这一分钟', () => {
  const from = local(2026, 11, 7, 8, 59, 30);
  const next = nextRun('0 9 * * *', from);
  assert.equal(new Date(next).getHours(), 9);
  assert.equal(new Date(next).getMinutes(), 0);
  // 必须是严格之后的分钟，不能是 8:59
  assert.ok(next > from);
});

test('nextRun：每分钟规则返回下一分钟', () => {
  const from = local(2026, 11, 7, 8, 59, 30);
  const next = nextRun('* * * * *', from);
  const d = new Date(next);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
});

test('nextRun：跨天', () => {
  const from = local(2026, 11, 7, 23, 30);
  const next = nextRun('0 9 * * *', from);
  const d = new Date(next);
  assert.equal(d.getDate(), 8);
  assert.equal(d.getHours(), 9);
});

test('nextRun：永不成立的组合会报错，而不是死循环', () => {
  assert.throws(() => nextRun('0 0 30 2 *', local(2026, 11, 7, 0, 0)), /一年内不会触发/);
});

test('validateCron：合法通过、非法抛错', () => {
  assert.doesNotThrow(() => validateCron('0 9 * * *'));
  assert.throws(() => validateCron('0 0 30 2 *'), /一年内不会触发/);
});

// ── 人话描述 ────────────────────────────────────────────────────────

test('describeCron：常见写法翻成人话', () => {
  assert.equal(describeCron('* * * * *'), '每分钟');
  assert.equal(describeCron('0 9 * * *'), '每天 09:00');
  assert.equal(describeCron('30 8 * * 1'), '每周一 08:30');
  assert.equal(describeCron('0 9 1 * *'), '每月 1 号 09:00');
});

test('describeCron：复杂写法原样返回', () => {
  assert.equal(describeCron('*/15 9-18 * * *'), '*/15 9-18 * * *');
});

// ── 调度器 ──────────────────────────────────────────────────────────

function fakeStore(due) {
  const calls = { marked: [], updated: [] };
  return {
    calls,
    dueSchedules: () => due,
    markScheduleRun: (id, patch) => {
      calls.marked.push({ id, ...patch });
      return { id };
    },
    updateSchedule: (id, patch) => {
      calls.updated.push({ id, ...patch });
      return { id };
    },
  };
}

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

test('调度器：到点就投递，并以主人身份发', async () => {
  const schedule = {
    id: 'sc_1',
    chatId: 'main',
    cron: '* * * * *',
    text: '@dsh-pc 早报',
    enabled: true,
    nextRunAt: Date.now() - 1000,
  };
  const store = fakeStore([schedule]);
  const delivered = [];

  const sched = startScheduler({
    store,
    deliver: async (payload) => {
      delivered.push(payload);
    },
    log: silentLog,
  });

  await sched.tick();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].chatId, 'main');
  assert.equal(delivered[0].sender, SENDER.user);
  assert.equal(delivered[0].text, '@dsh-pc 早报');
  // 推进了下次时间
  assert.equal(store.calls.marked.length, 1);
  assert.ok(store.calls.marked[0].nextRunAt > Date.now() - 60_000);
});

test('调度器：投递失败也推进时间，不会卡在同一轮反复重试', async () => {
  const schedule = {
    id: 'sc_2',
    chatId: 'main',
    cron: '* * * * *',
    text: '会失败的消息',
    enabled: true,
    nextRunAt: Date.now() - 1000,
  };
  const store = fakeStore([schedule]);

  const sched = startScheduler({
    store,
    deliver: async () => {
      throw new Error('模拟投递失败');
    },
    log: silentLog,
  });

  await sched.tick();

  // 关键：失败也要 markScheduleRun，否则每次扫描都重试
  assert.equal(store.calls.marked.length, 1);
});

test('调度器：没有到点的计划就不做事', async () => {
  const store = fakeStore([]);
  let called = 0;
  const sched = startScheduler({
    store,
    deliver: async () => {
      called += 1;
    },
    log: silentLog,
  });

  await sched.tick();
  assert.equal(called, 0);
  assert.equal(store.calls.marked.length, 0);
});

test('调度器：cron 坏了就停用这条，不无限刷错', async () => {
  const schedule = {
    id: 'sc_3',
    chatId: 'main',
    cron: '0 0 30 2 *', // 2 月 30 日，永不成立
    text: '坏规则',
    enabled: true,
    nextRunAt: Date.now() - 1000,
  };
  const store = fakeStore([schedule]);

  const sched = startScheduler({
    store,
    deliver: async () => {},
    log: silentLog,
  });

  await sched.tick();

  assert.equal(store.calls.updated.length, 1);
  assert.equal(store.calls.updated[0].enabled, false);
  assert.equal(store.calls.updated[0].nextRunAt, null);
});

test('调度器：stop 之后 tick 不再执行', async () => {
  const store = fakeStore([
    {
      id: 'sc_4',
      chatId: 'main',
      cron: '* * * * *',
      text: 'x',
      enabled: true,
      nextRunAt: Date.now() - 1000,
    },
  ]);
  let called = 0;
  const sched = startScheduler({
    store,
    deliver: async () => {
      called += 1;
    },
    log: silentLog,
  });

  sched.stop();
  await sched.tick();
  assert.equal(called, 0);
});

test('computeNextRun 与 newScheduleId 可用', () => {
  const next = computeNextRun('0 9 * * *');
  assert.ok(next > Date.now());
  assert.match(newScheduleId(), /^sc_/);
});
