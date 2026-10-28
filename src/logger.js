/**
 * 统一日志。
 * 刻意保持极简：一行一条、带级别与时间、敏感字段由调用方脱敏。
 * LOG_LEVEL=debug 可看到唤醒决策的中间过程。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const level = LEVELS[String(process.env.LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function emit(tag, args) {
  const head = `[${stamp()}] ${tag.toUpperCase().padEnd(5)}`;
  // console 自带换行与对象展开，比自己拼字符串更不容易丢信息
  if (tag === 'error') console.error(head, ...args);
  else if (tag === 'warn') console.warn(head, ...args);
  else console.log(head, ...args);
}

export const logger = {
  debug: (...a) => level <= LEVELS.debug && emit('debug', a),
  info: (...a) => level <= LEVELS.info && emit('info', a),
  warn: (...a) => level <= LEVELS.warn && emit('warn', a),
  error: (...a) => level <= LEVELS.error && emit('error', a),

  /** 生成带前缀的子日志，便于按模块过滤。 */
  child(scope) {
    const p = `[${scope}]`;
    return {
      debug: (...a) => logger.debug(p, ...a),
      info: (...a) => logger.info(p, ...a),
      warn: (...a) => logger.warn(p, ...a),
      error: (...a) => logger.error(p, ...a),
    };
  },
};
