import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CircuitBreaker, DEFAULT_BREAKER_OPTIONS, type BreakerOptions } from './circuit.js';
import { DEFAULT_MAX_COST, maxCostFromEnv, resolveCost } from './cost.js';
import { findWorst, pickMostConstrained } from './decide.js';
import { buildDeniedBody, type RateLimitBody } from './errors.js';
import { buildDeniedHeaders, buildSuccessHeaders, setHeaders } from './headers.js';
import { DEFAULT_FAIL_MODE, type FailMode } from './failMode.js';
import { defaultLogger, throttledWarn, type Logger } from './logger.js';
import { compileStack, type CompiledRule, type RuleSpec } from './rules.js';
import { perIp, type Resolver } from './resolvers.js';
import { createThrottleStore, type ThrottleStore } from './redis/client.js';
import {
  serializeDescriptors,
  parseStackResult,
  type RuleDescriptor,
  type StackResult,
} from './redis/descriptor.js';
import { buildKey, ruleScope } from './redis/keys.js';
import { defineTiers, type TierMap } from './tiers.js';

/**
 * The Express middleware (PLAN Phase 2).
 *
 * For one request it: resolves EVERY rule's key, computes EVERY rule's cost,
 * builds the descriptor array, and fires ONE EVALSHA (DECISIONS §11). It
 * never reads an intermediate counter in Node — if you find yourself doing
 * that, the design has gone wrong.
 *
 * Three outcomes, never two (PLAN Phase 4):
 *   allowed   → draft-8 headers, next()
 *   denied    → 429 + draft-8 headers + Retry-After + JSON body (§12)
 *   unavailable → 503, no RateLimit-* headers, breaker counted it (§13)
 */

export interface DeniedInfo {
  ruleName: string;
  limit: number;
  remaining: number;
  retryAfter: number;
  /** Cost the request would have been charged (it was charged nothing). */
  cost: number;
  /** `tier:resolver` scope of the worst rule — identities are never logged raw. */
  keyScope: string;
}

/** Fully overrides the 429 response. Default writes §12's contract. */
export type DeniedHandler = (info: DeniedInfo, req: Request, res: Response) => void;

export interface ThrottleOptions {
  /** Tier definitions — validated at creation time. */
  tiers?: TierMap;
  /** Store override — defaults to one built from REDIS_URL. */
  store?: ThrottleStore;
  /** Breaker tuning; defaults 5 failures / 10s cooldown / 1 probe (D2). */
  breaker?: Partial<BreakerOptions>;
  /** 'closed' (default, 503) or 'open' (admit, loud). */
  failMode?: FailMode;
  /** Hard cap on cost (D3). Default 100, env THROTTLE_MAX_COST. */
  maxCost?: number;
  logger?: Logger;
  onDenied?: DeniedHandler;
  /** Resolver used when a rule omits `by`. Default perIp. */
  identityResolver?: Resolver;
}

export interface ThrottleFactory {
  /** One rule: throttle('anonymous', { by: perIp }). */
  (tier: string, rule?: Omit<RuleSpec, 'tier'>): RequestHandler;
  /** Stacked rules: throttle([{ tier, by, cost }, ...]) (DECISIONS §9). */
  (rules: RuleSpec | RuleSpec[]): RequestHandler;
  store: ThrottleStore;
  breaker: CircuitBreaker;
  close(): Promise<void>;
}

function respondUnavailable(res: Response): void {
  // NO RateLimit-* headers — no numbers are knowable (DECISIONS §13).
  res.status(503).json({ error: 'service_unavailable' });
}

export function createThrottle(options: ThrottleOptions = {}): ThrottleFactory {
  const tiers = options.tiers ?? defineTiers({});
  const log = options.logger ?? defaultLogger;
  const maxCost = options.maxCost ?? maxCostFromEnv() ?? DEFAULT_MAX_COST;
  const failMode = options.failMode ?? DEFAULT_FAIL_MODE;
  const warnOnce = throttledWarn(log, 5_000);

  const breaker = new CircuitBreaker(
    { ...DEFAULT_BREAKER_OPTIONS, ...options.breaker },
    (from, to) => log.warn('circuit_breaker_state', { from, to }),
  );

  const store = options.store ?? createThrottleStore({ logger: log });
  const defaultResolver = options.identityResolver ?? perIp;

  function makeHandler(stack: CompiledRule[]): RequestHandler {
    // NOTE: validation already happened in compileStack — problems throw at
    // middleware-creation time (boot), never at request time.
    return (req: Request, res: Response, next: NextFunction) => {
      void handle(req, res, next, stack);
    };
  }

  async function handle(
    req: Request,
    res: Response,
    next: NextFunction,
    stack: CompiledRule[],
  ): Promise<void> {
    // 0. Breaker short-circuit — never touch Redis while open (§13).
    if (!breaker.canAttempt()) {
      warnOnce('breaker_open', 'circuit_open_short_circuit', { path: req.path, failMode });
      if (failMode === 'open') {
        next();
        return;
      }
      respondUnavailable(res);
      return;
    }

    // 1. Resolve identities and costs Node-side. This is the only per-request
    //    work Node does — no counter is ever read here.
    const keys: string[] = [];
    const descriptors: RuleDescriptor[] = [];
    const scopes: string[] = [];
    try {
      for (const rule of stack) {
        const identity = rule.by(req);
        const cost = resolveCost(rule.cost, req, maxCost);
        const scope = ruleScope(rule.tier.name, rule.by.name);
        keys.push(buildKey(scope, identity));
        scopes.push(scope);
        descriptors.push({
          algorithm: rule.tier.algorithm,
          params:
            rule.tier.algorithm === 'token-bucket'
              ? { capacity: rule.tier.capacity, refillPerSecond: rule.tier.refillPerSecond }
              : { limit: rule.tier.limit, windowMs: rule.tier.windowMs },
          cost,
          ruleName: rule.name,
          requestId: randomUUID(),
        });
      }
    } catch (err) {
      // Config/identity errors are programming errors → 500, loud (§7).
      log.error('identity_or_cost_error', {
        error: err instanceof Error ? err.message : String(err),
        path: req.path,
      });
      next(err);
      return;
    }

    // 2. ONE atomic round trip for the whole stack (§11).
    let result: StackResult;
    try {
      result = parseStackResult(await store.evaluateStack(keys, serializeDescriptors(descriptors)));
    } catch (err) {
      breaker.recordFailure();
      warnOnce('store_error', 'throttle_store_error', {
        error: err instanceof Error ? err.message : String(err),
        failMode,
        path: req.path,
      });
      if (failMode === 'open') {
        next(); // fail-open is opt-in and loud (§13)
        return;
      }
      respondUnavailable(res);
      return;
    }

    // A completed store interaction — allowed OR denied — is the limiter
    // working; neither counts as a breaker failure (§13).
    breaker.recordSuccess();

    // 3. Denied — the script already picked the worst rule (§10).
    if (!result.allowed) {
      const worst = findWorst(result);
      const charged = descriptors.find((d) => d.ruleName === worst.ruleName)?.cost ?? 1;
      const scopeIdx = stack.findIndex((r) => r.name === worst.ruleName);
      log.info('rate_limited', {
        rule: worst.ruleName,
        scope: scopeIdx >= 0 ? scopes[scopeIdx] : 'unknown',
        cost: charged,
        remaining: worst.remaining,
        limit: worst.limit,
        retryAfter: worst.retryAfter,
        path: req.path,
      });
      const info: DeniedInfo = {
        ruleName: worst.ruleName,
        limit: worst.limit,
        remaining: worst.remaining,
        retryAfter: worst.retryAfter,
        cost: charged,
        keyScope: scopeIdx >= 0 ? scopes[scopeIdx] : 'unknown',
      };
      if (options.onDenied) {
        options.onDenied(info, req, res);
        return;
      }
      setHeaders(res, buildDeniedHeaders(worst));
      const body: RateLimitBody = buildDeniedBody(worst, charged);
      res.status(429).json(body);
      return;
    }

    // 4. Allowed — headers from the most constrained rule (Phase 3).
    setHeaders(res, buildSuccessHeaders(pickMostConstrained(result.results)));
    next();
  }

  const factory = ((
    tierOrRules: string | RuleSpec | RuleSpec[],
    maybeRule?: Omit<RuleSpec, 'tier'>,
  ) => {
    const specs: RuleSpec[] =
      typeof tierOrRules === 'string'
        ? [{ tier: tierOrRules, ...(maybeRule ?? {}) }]
        : Array.isArray(tierOrRules)
          ? tierOrRules
          : [tierOrRules];
    const stack = compileStack(specs, tiers, defaultResolver);
    return makeHandler(stack);
  }) as ThrottleFactory;

  factory.store = store;
  factory.breaker = breaker;
  factory.close = async () => {
    await store.close();
  };

  return factory;
}

/**
 * Module-level default factory so the one-liner from the decisions record
 * works: `app.post('/search', throttle('authenticated', { by: perUser }), h)`.
 * Services that want explicit control (one shared store/breaker) should use
 * createThrottle() and configureThrottle().
 */
let defaultFactory: ThrottleFactory | undefined;

export function configureThrottle(options: ThrottleOptions = {}): ThrottleFactory {
  defaultFactory = createThrottle(options);
  return defaultFactory;
}

export function throttle(tier: string, rule?: Omit<RuleSpec, 'tier'>): RequestHandler;
export function throttle(rules: RuleSpec | RuleSpec[]): RequestHandler;
export function throttle(
  tierOrRules: string | RuleSpec | RuleSpec[],
  maybeRule?: Omit<RuleSpec, 'tier'>,
): RequestHandler {
  if (!defaultFactory) {
    defaultFactory = createThrottle();
  }
  return defaultFactory(tierOrRules as string, maybeRule);
}
