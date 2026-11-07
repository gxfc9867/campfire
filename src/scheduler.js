/**
 * 定时消息调度器。
 *
 * 每 30 秒扫一次「到点且启用」的计划，用主人身份往群里发一条，走的是正常投递
 * 管线（`createAndDeliver`），所以 @ 提及、成员互投、投递状态都照常生效——
 * 定时消息在系统里就是一条普通消息，不另开通道。
 *
 * 几个刻意的选择：
 * - **失败也推进时间**：一条计划炸了就炸了，下一轮照常触发；不推进会让它每次
 *   扫到都重试，日志刷屏还把群刷爆。
 * - **单进程内存锁**：同一 tick 里一条计划不会被并发跑两次（多实例部署时各自
 *   跑各自的，需要分布式锁，但围炉定位是单实例自托管，不上那套复杂度）。
 * - **错过的时间点不补发**：服务停了三天再起来，只发当前这一轮，不补三天前的。
 */

import { SENDER } from './constants.js';
import { nextRun } from './cron.js';
import { shortId } from './id.js';

export function startScheduler({
  store,
  deliver,
  hub = null,
  log = console,
  tickMs = 30_000,
  now = Date.now,
} = {}) {
  if (!store) throw new TypeError('startScheduler: store 必填');
  if (typeof deliver !== 'function') throw new TypeError('startScheduler: deliver 必填');

  const inFlight = new Set();
  let timer = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    let due;
    try {
      due = store.dueSchedules(now());
    } catch (error) {
      log.warn?.(`定时消息扫描失败：${error?.message ?? error}`);
      return;
    }

    for (const schedule of due) {
      if (inFlight.has(schedule.id)) continue;
      inFlight.add(schedule.id);
      const firedAt = now();
      try {
        await deliver({
          chatId: schedule.chatId,
          sender: SENDER.user,
          text: schedule.text,
          clientId: `sched-${schedule.id}-${firedAt}`,
        });
        log.info?.(`定时消息已发送：${schedule.id}（${schedule.cron}）→ ${schedule.chatId}`);
        hub?.emit?.('change', { type: 'message', chatId: schedule.chatId });
      } catch (error) {
        log.warn?.(`定时消息发送失败 ${schedule.id}：${error?.message ?? error}`);
      } finally {
        // 无论成败都推进到下一个时间点
        try {
          const next = nextRun(schedule.cron, firedAt);
          store.markScheduleRun(schedule.id, { lastRunAt: firedAt, nextRunAt: next });
        } catch (error) {
          // cron 本身坏了（理论上存的时候就校验过），停用它，别一直刷错
          log.warn?.(`定时消息 ${schedule.id} 的 cron 无法计算下次时间，已停用：${error?.message ?? error}`);
          try {
            store.updateSchedule(schedule.id, { enabled: false, nextRunAt: null });
          } catch {
            /* 忽略：库都写不进去就没别的办法了 */
          }
        }
        inFlight.delete(schedule.id);
      }
    }
  }

  return {
    /** 立刻扫一次（测试和「保存后立即验证」用）。 */
    tick,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => {
        tick().catch((error) => log.warn?.(`定时消息调度异常：${error?.message ?? error}`));
      }, tickMs);
      timer.unref?.();
      log.info?.(`定时消息调度器已启动，每 ${Math.round(tickMs / 1000)} 秒扫描一次`);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** 给路由用：算下一次触发时间，顺带做 cron 校验。 */
export function computeNextRun(cron, fromMs = Date.now()) {
  return nextRun(cron, fromMs);
}

/** 计划 id。 */
export function newScheduleId() {
  return shortId('sc_');
}
