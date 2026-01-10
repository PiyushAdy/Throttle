import type { RuleOutcome } from './redis/descriptor.js';

/**
 * Decision mapping (PLAN Phase 2). The Lua script already chose the worst
 * rule inside the atomic section (DECISIONS §10) — this module only maps
 * shapes; it never re-derives the choice.
 */

/**
 * Success headers come from the most constrained rule (lowest remaining, so
 * the client sees the tightest ceiling it is actually subject to; tie → the
 * lower limit) — PLAN Phase 3.
 */
export function pickMostConstrained(results: RuleOutcome[]): RuleOutcome {
  if (results.length === 0) {
    throw new Error('pickMostConstrained requires at least one rule outcome');
  }
  return results.reduce((best, r) => {
    if (r.remaining < best.remaining) return r;
    if (r.remaining === best.remaining && r.limit < best.limit) return r;
    return best;
  });
}

export function findWorst(result: {
  worstRule: string | null;
  results: RuleOutcome[];
}): RuleOutcome {
  const named = result.results.find((r) => r.ruleName === result.worstRule);
  return named ?? result.results[0];
}
