import { defineTiers } from '@throttle/core';

/**
 * The demo's tiers (DECISIONS §8) plus the dedicated tiers the load-test
 * package's routes use (packages/load-test — see its README).
 *
 * Every value here is overridable without a rebuild:
 *   THROTTLE_TIER_<NAME>_<CAPACITY|LIMIT|REFILL>
 */
export const tiers = defineTiers({
  // --- DECISIONS §8 -------------------------------------------------------
  anonymous: { algorithm: 'sliding-window', limit: 60, window: '1m' },
  authenticated: { algorithm: 'token-bucket', capacity: 100, refill: 10, refillUnit: 's' },
  apiKey: { algorithm: 'token-bucket', capacity: 1000, refill: 100, refillUnit: 's' },
  internal: { algorithm: 'token-bucket', capacity: 10000, refill: 5000, refillUnit: 's' },

  // --- load-test tiers (packages/load-test/README.md) ---------------------
  // Token bucket with effectively zero refill inside a burst: starts full,
  // admits exactly `capacity` requests — the invariant script's deterministic case.
  'lt-bucket': { algorithm: 'token-bucket', capacity: 50, refill: 0.01, refillUnit: 's' },
  // Exact sliding window for the same burst shape.
  'lt-window': { algorithm: 'sliding-window', limit: 50, window: '1m' },
  // Limit 0: every request must be denied.
  'lt-zero': { algorithm: 'sliding-window', limit: 0, window: '1m' },
  // Stacked pair for the all-or-nothing proof: rule A never exhausts, rule B
  // trips at 50 — after a burst, A must have been charged exactly once per
  // SUCCESSFUL request, and never for a denied one.
  'lt-stack-a': { algorithm: 'token-bucket', capacity: 100_000, refill: 0.01, refillUnit: 's' },
  'lt-stack-b': { algorithm: 'sliding-window', limit: 50, window: '1m' },
  // Clean-throughput benchmark route: effectively unthrottled, shows raw
  // middleware + script overhead against the throttled rows.
  'bench-throughput': {
    algorithm: 'token-bucket',
    capacity: 1_000_000,
    refill: 1_000_000,
    refillUnit: 's',
  },
});
