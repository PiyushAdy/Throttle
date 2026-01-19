import type { RuleOutcome } from './redis/descriptor.js';

/**
 * Response-contract headers (DECISIONS §12, PLAN Phase 3).
 *
 * The IETF draft-8 fields are the current standards-track shape:
 *   RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, plus Retry-After.
 *
 * ⚠ RateLimit-Reset in draft-8 is SECONDS UNTIL RESET, not an absolute
 * epoch — the classic mistake. The Lua script computes resets in seconds;
 * nothing here converts units.
 */

export interface RateLimitHeaders {
  'RateLimit-Limit': string;
  'RateLimit-Remaining': string;
  'RateLimit-Reset': string;
  'Retry-After'?: string;
}

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

function baseHeaders(rule: RuleOutcome): RateLimitHeaders {
  return {
    'RateLimit-Limit': String(rule.limit),
    'RateLimit-Remaining': String(Math.max(0, Math.ceil(rule.remaining))),
    'RateLimit-Reset': String(clampNonNegative(rule.reset)),
  };
}

/** Headers for an allowed request — no Retry-After, ever. */
export function buildSuccessHeaders(rule: RuleOutcome): RateLimitHeaders {
  return baseHeaders(rule);
}

/** Headers for a 429 — the worst rule's numbers plus Retry-After. */
export function buildDeniedHeaders(rule: RuleOutcome): RateLimitHeaders {
  const headers = baseHeaders(rule);
  const retry = Math.max(1, Math.ceil(rule.retryAfter));
  headers['Retry-After'] = String(retry);
  return headers;
}

export function setHeaders(
  res: { setHeader(name: string, value: string): unknown },
  headers: RateLimitHeaders,
): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}
