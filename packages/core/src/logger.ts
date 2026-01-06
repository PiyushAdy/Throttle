/**
 * Minimal structured logger — one JSON line per event (PLAN Cross-Cutting
 * Concerns). The demo's whole observability story is this format: readable,
 * greppable, and dependency-free.
 */

export type LogMeta = Record<string, unknown>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
}

export function lineLogger(minLevel: LogLevel = 'info'): Logger {
  const min = LEVEL_ORDER[minLevel];
  const write = (level: LogLevel, msg: string, meta?: LogMeta): void => {
    if (LEVEL_ORDER[level] < min) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  };
  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}

export const defaultLogger: Logger = lineLogger('info');

/**
 * Returns a warn function that emits each distinct `key` at most once per
 * `everyMs`. Fail-open pass-throughs and repeated client errors would
 * otherwise flood the log during an outage.
 */
export function throttledWarn(
  log: Logger,
  everyMs: number,
): (key: string, msg: string, meta?: LogMeta) => void {
  const lastEmitted = new Map<string, number>();
  return (key, msg, meta) => {
    const now = Date.now();
    const last = lastEmitted.get(key) ?? 0;
    if (now - last < everyMs) return;
    lastEmitted.set(key, now);
    log.warn(msg, meta);
  };
}
