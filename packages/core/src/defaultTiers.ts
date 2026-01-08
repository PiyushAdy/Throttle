import type { TierMap } from './tiers.js';

/**
 * The example tier set from DECISIONS §8 — typed, validated at load, env-
 * overridable. Ship yours instead; these exist so the one-liner import has
 * sane defaults and the demo matches the decisions record verbatim.
 */
export const defaultTiers: TierMap = {
  anonymous: { algorithm: 'sliding-window', limit: 60, window: '1m' },
  authenticated: { algorithm: 'token-bucket', capacity: 100, refill: 10, refillUnit: 's' },
  apiKey: { algorithm: 'token-bucket', capacity: 1000, refill: 100, refillUnit: 's' },
  internal: { algorithm: 'token-bucket', capacity: 10000, refill: 5000, refillUnit: 's' },
};
