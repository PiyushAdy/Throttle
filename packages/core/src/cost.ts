import type { Request } from 'express';
import { CostError } from './errors.js';

/**
 * Request cost (DECISIONS §4): every request carries a cost, default 1,
 * dynamic — it may be a function of the request, not merely a static
 * per-route constant. The Lua script consumes `cost` units and the 429 body
 * reports the cost charged.
 */

export type CostInput = number | ((req: Request) => number);

export const DEFAULT_COST = 1;
export const DEFAULT_MAX_COST = 100;

/**
 * Normalizes a CostInput for one request:
 *  - undefined → 1
 *  - function  → called with the request
 *  - fractional → rounded up (sliding windows charge one ZSET member per
 *    cost unit — a documented decision for D1 — so costs are integers)
 *  - clamped to the hard cap, so a single malformed request cannot consume
 *    an absurd number of units (DECISIONS §4, D3)
 *  - non-finite, negative, or zero values throw loudly
 */
export function resolveCost(input: CostInput | undefined, req: Request, maxCost: number): number {
  let cost: number;
  if (input === undefined) {
    cost = DEFAULT_COST;
  } else if (typeof input === 'function') {
    cost = input(req);
  } else {
    cost = input;
  }

  if (typeof cost !== 'number' || !Number.isFinite(cost)) {
    throw new CostError(`Cost must be a finite number, got ${String(cost)}`);
  }
  if (cost <= 0) {
    throw new CostError(`Cost must be a positive integer after normalization, got ${String(cost)}`);
  }

  cost = Math.ceil(cost);
  if (cost > maxCost) cost = maxCost;
  return cost;
}

/** Eager validation for static numeric costs, at middleware-creation time. */
export function validateStaticCost(cost: CostInput | undefined, ruleName: string): void {
  if (typeof cost === 'number') {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new CostError(
        `Rule "${ruleName}": static cost must be a finite number >= 1, got ${String(cost)}`,
      );
    }
  }
}

/** Reads the hard cap from the environment with a safe fallback (D3). */
export function maxCostFromEnv(): number | undefined {
  const raw = process.env.THROTTLE_MAX_COST;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new CostError(`THROTTLE_MAX_COST must be a finite number >= 1, got "${raw}"`);
  }
  return Math.ceil(n);
}
