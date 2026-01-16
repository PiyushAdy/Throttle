import { StoreUnavailableError } from '../errors.js';

/**
 * The rule-descriptor contract between Node and the Lua script
 * (PLAN Phase 1: "shared by producer and parser so the two cannot drift").
 *
 * Node serializes one descriptor per rule into ARGV[1]; the script returns a
 * JSON string parsed back into StackResult by parseStackResult().
 */

export type Algorithm = 'token-bucket' | 'sliding-window';

export interface TokenBucketParams {
  capacity: number;
  refillPerSecond: number;
}

export interface SlidingWindowParams {
  limit: number;
  windowMs: number;
}

export type AlgorithmParams = TokenBucketParams | SlidingWindowParams;

export interface RuleDescriptor {
  algorithm: Algorithm;
  params: AlgorithmParams;
  /** Positive integer cost in units of the rule's limit (DECISIONS §4). */
  cost: number;
  ruleName: string;
  /** Unique per request — becomes the sliding-window member id. */
  requestId: string;
}

/** One rule's outcome, as computed inside the atomic script. */
export interface RuleOutcome {
  ruleName: string;
  allowed: boolean;
  /** Headroom after the request, floor-rounded. */
  remaining: number;
  limit: number;
  /** Seconds until the request would be admitted. 0 when allowed. */
  retryAfter: number;
  /** Seconds until the limit meaningfully resets (draft-8, in seconds). */
  reset: number;
}

/** The uniform shape the script returns — Node has exactly one parser. */
export interface StackResult {
  allowed: boolean;
  /** Name of the most-over-its-limit denied rule ('' when allowed). */
  worstRule: string | null;
  results: RuleOutcome[];
}

export function serializeDescriptors(descriptors: RuleDescriptor[]): string {
  return JSON.stringify(descriptors);
}

/**
 * Parses the Lua script's return value. Malformed output is a store-level
 * failure, not a config error — it counts toward the circuit breaker like
 * any other script error (DECISIONS §13).
 */
export function parseStackResult(raw: unknown): StackResult {
  if (typeof raw !== 'string') {
    throw new StoreUnavailableError(
      `Unexpected script result type: ${typeof raw} (expected JSON string)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreUnavailableError('Script result was not valid JSON', { cause: err });
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('allowed' in parsed) ||
    !('results' in parsed)
  ) {
    throw new StoreUnavailableError('Script result is missing required fields');
  }
  const obj = parsed as Record<string, unknown>;
  const resultsRaw = obj.results;
  if (!Array.isArray(resultsRaw)) {
    throw new StoreUnavailableError('Script result "results" is not an array');
  }

  const results: RuleOutcome[] = resultsRaw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new StoreUnavailableError(`Script result results[${i}] is not an object`);
    }
    const r = entry as Record<string, unknown>;
    return {
      ruleName: String(r.ruleName ?? ''),
      allowed: r.allowed === 1 || r.allowed === true,
      remaining: Number(r.remaining ?? 0),
      limit: Number(r.limit ?? 0),
      retryAfter: Number(r.retryAfter ?? 0),
      reset: Number(r.reset ?? 0),
    };
  });

  const worstRuleRaw = typeof obj.worstRule === 'string' ? obj.worstRule : '';
  return {
    allowed: obj.allowed === 1 || obj.allowed === true,
    worstRule: worstRuleRaw === '' ? null : worstRuleRaw,
    results,
  };
}
