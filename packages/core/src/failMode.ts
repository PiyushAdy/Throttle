import { ThrottleConfigError } from './errors.js';

/**
 * Fail mode (DECISIONS §13, PLAN Phase 4).
 *
 *   'closed' (default) — when the store is unreachable, DENY with 503.
 *   Fail-closed is the honest default for a limiter: an outage must not
 *   silently remove the limit and turn a rate-limit failure into a capacity
 *   incident.
 *
 *   'open' — when the store is unreachable, ADMIT everything.
 *   Defensible for availability-first services, but it must be opt-in and
 *   loud: the middleware logs a (rate-limited) warning on every pass-through.
 */

export type FailMode = 'closed' | 'open';

export const DEFAULT_FAIL_MODE: FailMode = 'closed';

export function resolveFailMode(raw: string | undefined): FailMode {
  if (raw === undefined || raw === '') return DEFAULT_FAIL_MODE;
  if (raw === 'closed' || raw === 'open') return raw;
  throw new ThrottleConfigError(`THROTTLE_FAIL_MODE must be "closed" or "open", got "${raw}"`);
}
