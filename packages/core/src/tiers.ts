import { ThrottleConfigError } from './errors.js';

/**
 * Named tiers in a typed TypeScript config object (DECISIONS §8).
 * No external config file, no admin write path, no inline per-route limits.
 *
 * Validation happens at load time (defineTiers) — a tier naming an unknown
 * algorithm or a bad capacity throws at boot, not at request time
 * (PLAN Phase 2). Capacity/limit/refill are env-overridable so the demo is
 * tweakable without a rebuild.
 */

export type TimeUnit = 'ms' | 's' | 'm' | 'h';

/** A duration literal like `'1m'`, `'10s'`, `'500ms'`, `'2h'`. */
export type Duration = `${number}${TimeUnit}`;

const UNIT_MS: Record<TimeUnit, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export interface SlidingWindowTier {
  algorithm: 'sliding-window';
  /** Maximum requests charged inside the window. 0 denies everything. */
  limit: number;
  window: Duration;
}

export interface TokenBucketTier {
  algorithm: 'token-bucket';
  /** Burst ceiling — the bucket starts full. */
  capacity: number;
  /** Tokens replenished per `refillUnit`, fractions allowed. */
  refill: number;
  refillUnit: TimeUnit;
}

export type TierConfig = SlidingWindowTier | TokenBucketTier;

export type TierMap = Record<string, TierConfig>;

/** A tier resolved into plain numbers the descriptor/serializer understands. */
export type CompiledTier =
  | { algorithm: 'token-bucket'; name: string; capacity: number; refillPerSecond: number }
  | { algorithm: 'sliding-window'; name: string; limit: number; windowMs: number };

const DURATION_RE = /^(\d+)(ms|s|m|h)$/;

export function parseDuration(d: Duration): number {
  const match = DURATION_RE.exec(d);
  if (!match) {
    throw new ThrottleConfigError(
      `Invalid duration "${d}" — expected a literal like "500ms", "10s", "1m" or "2h"`,
    );
  }
  const ms = Number(match[1]) * UNIT_MS[match[2] as TimeUnit];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new ThrottleConfigError(`Duration "${d}" must resolve to a positive number of ms`);
  }
  return ms;
}

function toFinitePositive(value: unknown, field: string, tier: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new ThrottleConfigError(
      `Tier "${tier}": ${field} must be a finite number > 0, got ${String(value)}`,
    );
  }
  return n;
}

function toNonNegativeInteger(value: unknown, field: string, tier: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new ThrottleConfigError(
      `Tier "${tier}": ${field} must be a non-negative integer, got ${String(value)}`,
    );
  }
  return n;
}

const ENV_TIER_PREFIX = 'THROTTLE_TIER_';

function envKey(tier: string, field: string): string {
  const snakeTier = tier.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return `${ENV_TIER_PREFIX}${snakeTier}_${field}`;
}

/** Applies THROTTLE_TIER_<NAME>_<CAPACITY|LIMIT|REFILL|WINDOW> overrides (DECISIONS §8). */
function applyEnvOverride(tier: string, cfg: TierConfig): TierConfig {
  const next: TierConfig = { ...cfg };
  const read = (field: string): string | undefined => {
    const v = process.env[envKey(tier, field)];
    return v === undefined || v === '' ? undefined : v;
  };
  const num = (field: string): number | undefined => {
    const v = read(field);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new ThrottleConfigError(
        `Environment override ${envKey(tier, field)} must be numeric, got "${v}"`,
      );
    }
    return n;
  };
  const capacity = num('CAPACITY');
  if (capacity !== undefined && next.algorithm === 'token-bucket') next.capacity = capacity;
  const limit = num('LIMIT');
  if (limit !== undefined && next.algorithm === 'sliding-window') next.limit = limit;
  const refill = num('REFILL');
  if (refill !== undefined && next.algorithm === 'token-bucket') next.refill = refill;
  const window = read('WINDOW');
  if (window !== undefined && next.algorithm === 'sliding-window') next.window = window as Duration;
  return next;
}

function compileTier(name: string, cfg: TierConfig): CompiledTier {
  if (cfg.algorithm === 'token-bucket') {
    const capacity = toFinitePositive(cfg.capacity, 'capacity', name);
    const refill = toFinitePositive(cfg.refill, 'refill', name);
    if (!(cfg.refillUnit in UNIT_MS)) {
      throw new ThrottleConfigError(
        `Tier "${name}": refillUnit must be one of ms|s|m|h, got "${String(cfg.refillUnit)}"`,
      );
    }
    const refillPerSecond = (refill * UNIT_MS[cfg.refillUnit]) / 1_000;
    return { algorithm: 'token-bucket', name, capacity, refillPerSecond };
  }
  if (cfg.algorithm === 'sliding-window') {
    const limit = toNonNegativeInteger(cfg.limit, 'limit', name);
    const windowMs = parseDuration(cfg.window);
    return { algorithm: 'sliding-window', name, limit, windowMs };
  }
  throw new ThrottleConfigError(
    `Tier "${name}": unknown algorithm "${String((cfg as { algorithm?: unknown }).algorithm)}"`,
  );
}

/**
 * Validates every tier at load time and returns the map unchanged (typed).
 * Any problem throws at boot — never at request time.
 */
export function defineTiers<T extends TierMap>(tiers: T): T {
  for (const [name, cfg] of Object.entries(tiers)) {
    applyEnvOverride(name, cfg);
    compileTier(name, cfg);
  }
  return tiers;
}

/** Looks a tier up in a map compiled by defineTiers, throwing on a miss. */
export function resolveTier(tiers: TierMap, name: string): CompiledTier {
  const cfg = tiers[name];
  if (cfg === undefined) {
    throw new ThrottleConfigError(
      `Unknown tier "${name}". Known tiers: ${Object.keys(tiers).join(', ') || '(none)'}`,
    );
  }
  return compileTier(name, applyEnvOverride(name, cfg));
}
