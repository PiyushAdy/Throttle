/**
 * @throttle/core — distributed rate limiting as drop-in Express middleware.
 *
 * The public surface. Everything else is internal by design:
 * the Node layer only prepares keys, fires the atomic script, and formats
 * the answer — all decisions live in Redis (PLAN, Guiding Principles).
 */

export {
  throttle,
  configureThrottle,
  createThrottle,
  type ThrottleOptions,
  type ThrottleFactory,
  type DeniedInfo,
  type DeniedHandler,
} from './middleware.js';

export {
  defineTiers,
  resolveTier,
  parseDuration,
  type TierConfig,
  type TierMap,
  type CompiledTier,
  type Duration,
  type SlidingWindowTier,
  type TokenBucketTier,
  type TimeUnit,
} from './tiers.js';
export { defaultTiers } from './defaultTiers.js';

export { perIp, perUser, perApiKey, type Resolver } from './resolvers.js';
export { type CostInput } from './cost.js';
export { type RuleSpec, type CompiledRule } from './rules.js';

export {
  CircuitBreaker,
  DEFAULT_BREAKER_OPTIONS,
  type BreakerOptions,
  type BreakerState,
} from './circuit.js';

export { resolveFailMode, DEFAULT_FAIL_MODE, type FailMode } from './failMode.js';

export { lineLogger, defaultLogger, type Logger, type LogLevel, type LogMeta } from './logger.js';

export {
  ThrottleError,
  ThrottleConfigError,
  MissingIdentityError,
  CostError,
  RateLimitError,
  StoreUnavailableError,
  type RateLimitBody,
} from './errors.js';

export {
  type RuleDescriptor,
  type RuleOutcome,
  type StackResult,
  type Algorithm,
  type AlgorithmParams,
  type TokenBucketParams,
  type SlidingWindowParams,
} from './redis/descriptor.js';

export {
  createThrottleStore,
  loadThrottleLua,
  type ThrottleStore,
  type ThrottleStoreOptions,
} from './redis/client.js';
export { KEY_PREFIX, buildKey, ruleScope } from './redis/keys.js';
