/**
 * Circuit breaker (DECISIONS §13, PLAN Phase 4).
 *
 * A small state machine: closed → open → half-open → closed.
 *
 *   closed    — normal operation; consecutive failures are counted
 *   open      — short-circuit everything without touching Redis; after the
 *               cooldown elapses the state lazily becomes half-open
 *   half-open — ONE probe request is allowed through to Redis; success
 *               re-closes the breaker, failure re-opens it with a fresh
 *               cooldown
 *
 * What counts as a failure: connection refused, timeout, script errors —
 * anything that makes the store's answer unknowable. A DENIAL
 * (allowed: false) is never a failure; that is the limiter working.
 *
 * Without a breaker, every request during an outage pays the full Redis
 * connection timeout, converting a dependency outage into a latency outage.
 * The breaker fails fast during the cooldown and probes once to detect
 * recovery. Thresholds are provisional (D2) and configurable.
 */

export interface BreakerOptions {
  /** Consecutive store failures before the breaker opens. */
  threshold: number;
  /** How long the breaker stays open before allowing a half-open probe. */
  cooldownMs: number;
  /** How many probe requests may be in flight while half-open. */
  halfOpenMaxProbes: number;
}

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  threshold: 5,
  cooldownMs: 10_000,
  halfOpenMaxProbes: 1,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failureCount = 0;
  private currentState: BreakerState = 'closed';
  private openedAt = 0;
  private probesInFlight = 0;

  constructor(
    private readonly options: BreakerOptions = DEFAULT_BREAKER_OPTIONS,
    private readonly onChange?: (from: BreakerState, to: BreakerState) => void,
  ) {}

  /** Current state — lazily rolls open → half-open once the cooldown has elapsed. */
  get state(): BreakerState {
    if (this.currentState === 'open' && Date.now() - this.openedAt >= this.options.cooldownMs) {
      this.transition('half-open');
    }
    return this.currentState;
  }

  get failures(): number {
    return this.failureCount;
  }

  /**
   * Whether a Redis interaction may start right now. When half-open, an
   * accepted call consumes a probe slot; balance every accepted call with
   * exactly one recordSuccess()/recordFailure().
   */
  canAttempt(): boolean {
    const state = this.state; // triggers the lazy open → half-open roll
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probesInFlight < this.options.halfOpenMaxProbes) {
      this.probesInFlight += 1;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.probesInFlight = 0;
    this.failureCount = 0;
    this.transition('closed');
  }

  recordFailure(): void {
    if (this.currentState === 'half-open') {
      // The recovery probe failed — re-open with a fresh cooldown (D2).
      this.probesInFlight = 0;
      this.openedAt = Date.now();
      this.transition('open');
      return;
    }
    if (this.currentState === 'closed') {
      this.failureCount += 1;
      if (this.failureCount >= this.options.threshold) {
        this.openedAt = Date.now();
        this.transition('open');
      }
    }
  }

  private transition(to: BreakerState): void {
    if (this.currentState === to) return;
    const from = this.currentState;
    this.currentState = to;
    this.onChange?.(from, to);
  }
}
