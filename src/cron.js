/**
 * 极简 cron 解析。
 *
 * 支持标准五段（分 时 日 月 周），以及 `*` `N` `N-M` `N,M` `*\/N` `N-M/S` 这些写法。
 * 不引依赖：定时消息只需要「每天几点」「每周几几点」这类简单规则，一个百来行的
 * 解析器比引一个包更好维护，也不用担心供应链。
 *
 * 语义简化（和标准 cron 的差别，写在这里以免误用）：
 * - 「日」和「周」是 **AND** 关系（标准 cron 是 OR），因为大多数人写 `0 9 * * 1`
 *   想要的是「每周一 9 点」，而不是「每月 1 号或每周一 9 点」。
 * - 不支持 `@daily` 这类别名，也不支持秒级字段。
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 6 }, // 0 = 周日
];

/** 把 `*\/5` `1-10/2` `1,3,5` `7` 这类片段展开成数字集合。 */
function expandField(raw, { min, max, name }) {
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`cron 的 ${name} 字段有空片段`);

    // 拆步长
    const [rangePart, stepPart] = piece.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron 的 ${name} 字段步长非法：${piece}`);
    }

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      // 单值带步长（如 `5/10`）按「从 5 开始到上限」处理，与常见实现一致
      hi = stepPart === undefined ? lo : max;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`cron 的 ${name} 字段不是整数：${piece}`);
    }
    // 周日既可以写 0 也可以写 7
    if (name === 'weekday') {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron 的 ${name} 字段超范围（${min}-${max}）：${piece}`);
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new Error(`cron 的 ${name} 字段为空`);
  return out;
}

/**
 * 解析表达式。
 * @returns {{minute:Set<number>, hour:Set<number>, day:Set<number>, month:Set<number>, weekday:Set<number>, source:string}}
 */
export function parseCron(expression) {
  const raw = String(expression ?? '').trim();
  if (!raw) throw new Error('cron 表达式为空');
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 需要 5 段（分 时 日 月 周），收到 ${parts.length} 段：${raw}`);
  }
  const out = { source: raw };
  parts.forEach((part, i) => {
    out[FIELDS[i].name] = expandField(part, FIELDS[i]);
  });
  return out;
}

/** 某个具体时刻是否命中。 */
export function matches(parsed, date) {
  return (
    parsed.minute.has(date.getMinutes()) &&
    parsed.hour.has(date.getHours()) &&
    parsed.day.has(date.getDate()) &&
    parsed.month.has(date.getMonth() + 1) &&
    parsed.weekday.has(date.getDay())
  );
}

/**
 * 从 fromMs 之后开始找下一个命中时刻，精确到分钟。
 *
 * 逐分钟往前推，最多找 366 天。真实规则几乎都在几步内命中；
 * 找不到说明是 `0 0 30 2 *`（2 月 30 日）这种永不成立的组合，直接报错，
 * 免得存进去以后永远不触发、用户还以为设成功了。
 */
export function nextRun(expression, fromMs = Date.now()) {
  const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
  const start = new Date(fromMs);
  // 从下一分钟整点开始（当前这一分钟已经过了，不该重复触发）
  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const LIMIT_MINUTES = 366 * 24 * 60;
  for (let i = 0; i < LIMIT_MINUTES; i += 1) {
    if (matches(parsed, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`cron 表达式在一年内不会触发：${parsed.source}`);
}

/** 校验表达式是否合法且能触发（存之前调一次）。 */
export function validateCron(expression, fromMs = Date.now()) {
  const parsed = parseCron(expression);
  nextRun(parsed, fromMs);
  return parsed;
}

/** 人话描述，给前端列表用。 */
export function describeCron(expression) {
  const p = parseCron(expression);
  const one = (set) => set.size === 1;
  const val = (set) => [...set][0];

  if (p.source === '* * * * *') return '每分钟';

  const mm = one(p.minute) ? String(val(p.minute)).padStart(2, '0') : null;
  const hh = one(p.hour) ? String(val(p.hour)).padStart(2, '0') : null;

  if (mm && hh) {
    const time = `${hh}:${mm}`;
    if (p.day.size === 31 && p.month.size === 12) {
      if (p.weekday.size === 7) return `每天 ${time}`;
      const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const days = [...p.weekday].sort().map((d) => names[d]).join('、');
      return `每${days} ${time}`;
    }
    if (p.weekday.size === 7) {
      return `每月 ${val(p.day)} 号 ${time}`;
    }
  }

  // 兜底：原样显示
  return p.source;
}
