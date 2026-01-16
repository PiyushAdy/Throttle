import Redis, { type RedisOptions } from 'ioredis';
import { StoreUnavailableError } from '../errors.js';
import type { Logger } from '../logger.js';
import { defaultLogger } from '../logger.js';
import { loadThrottleLua } from './scripts/loader.js';

/**
 * The Redis layer (PLAN Phase 1).
 *
 * Everything downstream of this file talks to THIS interface — no other
 * module may import ioredis. The narrow surface keeps the atomic script the
 * only interesting thing here and makes the store swappable in principle.
 */

export interface ThrottleStoreOptions {
  redisUrl?: string;
  redisOptions?: RedisOptions;
  logger?: Logger;
}

export interface ThrottleStore {
  /**
   * Fire the whole rule stack as ONE atomic script call (DECISIONS §11).
   * Resolves to the raw JSON string the script returns; callers parse it
   * with parseStackResult(). Rejects with StoreUnavailableError on any
   * connection, timeout, or script error — all of which count as breaker
   * failures (DECISIONS §13).
   */
  evaluateStack(keys: string[], descriptorsJson: string): Promise<string>;
  /** Connectivity probe for health checks and tests. */
  ping(): Promise<boolean>;
  /** Underlying client status string ("ready", "end", "connecting", ...). */
  status(): string;
  close(): Promise<void>;
}

/** Loads throttle.lua — exported for tests and tooling that want the raw text. */
export { loadThrottleLua };

export function createThrottleStore(options: ThrottleStoreOptions = {}): ThrottleStore {
  const log = options.logger ?? defaultLogger;
  const url = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const lua = loadThrottleLua();

  const client = new Redis(url, {
    // Fail FAST when Redis is gone. ioredis would otherwise queue commands
    // while offline (enableOfflineQueue) and retry each command up to 20
    // times — converting a dependency outage into a latency outage. The
    // circuit breaker (DECISIONS §13) needs honest, immediate errors.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    ...options.redisOptions,
  });

  // ioredis emits 'error' on every failed reconnect attempt; without a
  // listener an error event would crash the process. Log quietly instead —
  // the middleware surfaces the real 503s.
  client.on('error', (err: Error) => {
    log.warn('redis_client_error', { error: err.message });
  });

  // Register the script with EVALSHA-first dispatch and automatic EVAL
  // fallback on NOSCRIPT — exactly what DECISIONS §2 chose ioredis for.
  // numberOfKeys is deliberately OMITTED: per ioredis semantics, the caller
  // then passes EVAL's numkeys as the first argument of every invocation,
  // so one registered command serves stacks of any size. (Passing
  // numberOfKeys: 0 would swallow numkeys into ARGV and break the script.)
  client.defineCommand('throttleStack', { lua });

  // Preload the script so even the very first request takes the EVALSHA
  // path. Best effort: if Redis is down at boot the breaker handles it.
  void client.script('LOAD', lua).catch(() => undefined);

  const withCommand = client as unknown as {
    throttleStack: (...args: (string | number)[]) => Promise<string>;
  };

  return {
    async evaluateStack(keys: string[], descriptorsJson: string): Promise<string> {
      try {
        return await withCommand.throttleStack(keys.length, ...keys, descriptorsJson);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new StoreUnavailableError(`Redis evaluate failed: ${message}`, { cause: err });
      }
    },
    async ping(): Promise<boolean> {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    status: () => client.status,
    async close(): Promise<void> {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}
