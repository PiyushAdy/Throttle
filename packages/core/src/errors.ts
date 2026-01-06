/** Base class for every error the library raises deliberately. */
export class ThrottleError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Configuration and validation errors — tier definitions, rule stacks,
 * missing files. These should surface at boot, never at request time
 * (PLAN Phase 2: "validate at load time").
 */
export class ThrottleConfigError extends ThrottleError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'THROTTLE_CONFIG', options);
  }
}

/**
 * A resolver could not derive an identity from the request — e.g. perUser
 * with no req.user, perApiKey with no x-api-key header. This is a wiring
 * mistake, not a rate-limit event: it fails loudly (DECISIONS §7), surfaces
 * as a 500, and never degrades to a shared bucket.
 */
export class MissingIdentityError extends ThrottleError {
  constructor(resolverName: string, hint: string) {
    super(
      `Resolver "${resolverName}" could not derive an identity from the request: ${hint}`,
      'THROTTLE_IDENTITY',
    );
  }
}

/** A cost value is invalid — non-finite, negative, or zero (PLAN Phase 2). */
export class CostError extends ThrottleError {
  constructor(message: string) {
    super(message, 'THROTTLE_COST');
  }
}

/**
 * A denial made tangible. Raised nowhere by default — the middleware writes
 * the 429 itself — but exported so consumers can build custom flows
 * (PLAN Phase 3: "a typed RateLimitError class").
 */
export class RateLimitError extends ThrottleError {
  readonly ruleName: string;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfter: number;
  readonly cost: number;

  constructor(fields: {
    ruleName: string;
    limit: number;
    remaining: number;
    retryAfter: number;
    cost: number;
  }) {
    super(
      `Rate limited by rule "${fields.ruleName}" — retry after ${fields.retryAfter}s`,
      'THROTTLE_RATE_LIMITED',
    );
    this.ruleName = fields.ruleName;
    this.limit = fields.limit;
    this.remaining = fields.remaining;
    this.retryAfter = fields.retryAfter;
    this.cost = fields.cost;
  }
}

/**
 * The store could not be reached or the script failed. Under the default
 * fail-closed mode this becomes a 503 with no RateLimit-* headers
 * (DECISIONS §13) — and it always counts as a circuit-breaker failure.
 */
export class StoreUnavailableError extends ThrottleError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'THROTTLE_STORE_UNAVAILABLE', options);
  }
}

/** The 429 JSON body contract (DECISIONS §12). */
export interface RateLimitBody {
  error: 'rate_limited';
  rule: string;
  limit: number;
  remaining: number;
  retryAfter: number;
  cost: number;
}

export function buildDeniedBody(worst: RateLimitBodyInput, cost: number): RateLimitBody {
  return {
    error: 'rate_limited',
    rule: worst.ruleName,
    limit: worst.limit,
    remaining: Math.max(0, worst.remaining),
    retryAfter: Math.max(1, worst.retryAfter),
    cost,
  };
}

type RateLimitBodyInput = {
  ruleName: string;
  limit: number;
  remaining: number;
  retryAfter: number;
};
