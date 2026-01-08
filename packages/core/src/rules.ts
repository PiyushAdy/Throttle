import type { CostInput } from './cost.js';
import { validateStaticCost } from './cost.js';
import { ThrottleConfigError } from './errors.js';
import type { Resolver } from './resolvers.js';
import { perIp } from './resolvers.js';
import { resolveTier, type CompiledTier, type TierMap } from './tiers.js';

/**
 * Rules and the stack builder (DECISIONS §9, PLAN Phase 2).
 *
 * A route may stack multiple rules — a global rule, a per-key rule, a
 * per-route override. ALL rules are evaluated; the request is denied if ANY
 * rule denies; consumption is all-or-nothing. The stack builder rejects
 * configurations it cannot express honestly rather than silently producing
 * a bad key set.
 */

export interface RuleSpec {
  /** Tier name — must exist in the tier map (validated at boot). */
  tier: string;
  /** Key resolver. Defaults to perIp when omitted. */
  by?: Resolver;
  /** Static or dynamic cost. Default 1. */
  cost?: CostInput;
  /** Rule name reported in headers/bodies. Defaults to `<tier>:<resolver>`. */
  name?: string;
}

export interface CompiledRule {
  name: string;
  tier: CompiledTier;
  by: Resolver;
  cost: CostInput | undefined;
}

/**
 * Compiles a rule spec (or stack of specs) against a tier map.
 * Throws ThrottleConfigError at middleware-creation time for: unknown tiers,
 * duplicate rule names, and two rules sharing one key scope (same tier +
 * resolver) — those would double-charge one bucket inside a single atomic
 * decision.
 */
export function compileStack(
  specs: RuleSpec | RuleSpec[],
  tiers: TierMap,
  defaultResolver: Resolver = perIp,
): CompiledRule[] {
  const arr = Array.isArray(specs) ? specs : [specs];
  if (arr.length === 0) {
    throw new ThrottleConfigError('throttle() requires at least one rule');
  }

  const names = new Set<string>();
  const scopes = new Set<string>();

  return arr.map((spec, i) => {
    if (spec === null || typeof spec !== 'object' || typeof spec.tier !== 'string') {
      throw new ThrottleConfigError(`Rule at position ${i} is missing a "tier" name`);
    }
    const by = spec.by ?? defaultResolver;
    if (typeof by !== 'function') {
      throw new ThrottleConfigError(`Rule at position ${i}: "by" must be a resolver function`);
    }
    const tier = resolveTier(tiers, spec.tier);
    const name = spec.name ?? `${spec.tier}:${by.name}`;

    if (names.has(name)) {
      throw new ThrottleConfigError(
        `Duplicate rule name "${name}" in the stack — pass distinct "name" values so report-worst (§10) stays readable`,
      );
    }
    names.add(name);

    const scope = `${spec.tier}:${by.name}`;
    if (scopes.has(scope)) {
      throw new ThrottleConfigError(
        `Stack has two rules over the same key scope "${scope}" — one bucket would be charged twice inside a single atomic decision. Use different tiers or resolvers.`,
      );
    }
    scopes.add(scope);

    validateStaticCost(spec.cost, name);

    return { name, tier, by, cost: spec.cost };
  });
}
