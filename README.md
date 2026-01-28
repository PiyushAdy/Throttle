# Throttle

**Distributed rate limiting as drop-in Express middleware.** Stacked rules are evaluated for every request inside **one atomic Redis Lua script** — token bucket and exact sliding window, typed limit tiers, dynamic per-request cost, draft-8 `RateLimit-*` headers, and a circuit breaker that fails closed with an honest 503. Multi-instance services sharing one Redis get exact limits, because every decision is made by the store, not by the caller.

Modeled on the repo shape and proof style of [QueueGate](https://github.com/PiyushAdy/QueueGate): a library core, a demo Express service, and a load-test package whose invariant script prints the one number that matters — **0 violations**.

```
Express middleware ──► ONE atomic Lua script ──► Redis
        │               evaluate all rules         │
        │               commit all-or-nothing      │
        ├── allowed  → RateLimit-* headers → next()
        ├── denied   → 429 + Retry-After + JSON body
        └── store down → circuit breaker → fast 503 (no RateLimit headers)
```

DECISIONS.md is the source of truth for *what and why* (16 recorded decisions, each with the rejected alternatives); PLAN.md covers *how and in what order*. ARCHITECTURE.md holds the atomicity argument.

---

## Quick start

```bash
docker compose up -d redis   # or: any standalone Redis 7 on :6379
npm install
npm run dev                  # demo app on :3000 (core is built first)
```

Try it:

```bash
curl -i http://localhost:3000/api/public
#   200 with RateLimit-Limit: 60 / -Remaining: 59
#   ...after 60 requests from your IP within a minute:
#   429 + RateLimit-Remaining: 0 + Retry-After + {"error":"rate_limited","rule":"anonymous:ip",...}

curl -i http://localhost:3000/api/me -H 'x-user-id: alice'      # per-user token bucket
curl -i -X POST http://localhost:3000/api/search \
     -H 'content-type: application/json' -H 'x-user-id: alice' \
     -d '{"q":"throttle","results":30}'                          # dynamic cost: 4 units
```

Prove it and measure it:

```bash
npm run load-test   # invariant script — exits 0 only if the limit held everywhere
npm run bench       # autocannon — the table below
```

## Demo routes

| Route | Tier | Algorithm | Keyed by | Cost |
|---|---|---|---|---|
| `GET /api/public` | `anonymous` — 60/min | sliding window | per-IP | 1 |
| `GET /api/me` | `authenticated` — bucket 100 @ 10/s | token bucket | per-user (`x-user-id`) | 1 |
| `POST /api/search` | `authenticated` | token bucket | per-user | **dynamic 1–5** (scales with `results`) |
| `POST /api/internal` | `apiKey` — bucket 1000 @ 100/s | token bucket | per-API-key (**SHA-256 hashed**) | 1 |
| `GET /api/stacked` | `anonymous` **+** `authenticated` | both | per-IP **+** per-user | 1 + 1 |

The `/api/lt/*` routes back the load-test package's cases (buckets that
don't refill during a burst, a zero-limit tier, the all-or-nothing pair).

## Concurrency & correctness

Three properties, all verified against **real Redis** by `npm run load-test`:

1. **The stack is atomic, not just each rule.** Every rule attached to a request is evaluated inside one Lua invocation. Redis runs scripts atomically, so the *stack* is atomic too — and the whole decision is a single `EVALSHA` regardless of how many rules are stacked (DECISIONS §11). This is only possible because Cluster is out of scope (§16): Cluster's same-slot rule forbids unrelated keys in one script.
2. **Consumption is all-or-nothing.** The script evaluates first and writes nothing if any rule denies. A denied request never spends headroom on a request that never ran — counters mean *requests actually served* (§9). This is the property a per-rule design cannot offer and the reason a denial can't quietly leak quota.
3. **Report worst.** With all rules evaluated, the 429 names the rule most over its limit, chosen *inside* the script (§10) — so `RateLimit-Remaining` never overstates the caller's headroom. Worked example: stack per-IP (60/min) with per-user (bucket 100); one user fires 70 requests — per-IP blows, per-user is fine → the 429 names the per-IP rule.

> **0 violations** — 200 concurrent admits against a limit of 50 succeed exactly 50 times, on both algorithms and on the stacked route, every run. The invariant script exits non-zero on any deviation.

Two further honesty properties: **Redis server time is the only clock** (refill and window math never read `Date.now()`, so per-instance drift can't bend the limit — §5), and **expiry is a safety net, not the mechanism** (TTLs are refreshed on every write to reclaim keys nobody uses; correctness lives in the counters — §6).

## Benchmark results

Measured, not estimated (DECISIONS §14). Saturated throttled routes deny at full speed — 429s dominate the Non-2xx column by design; `/api/lt/bench` is effectively unthrottled and shows the raw middleware + script overhead.

| Route | Method | Avg RPS | p50 (ms) | p99 (ms) | Total | Non-2xx |
|---|---|---:|---:|---:|---:|---:|
| `/api/lt/bench` | GET | 15598 | 4.0 | 32.0 | 156000 | 0 |
| `/api/public` | GET | 14740 | 4.0 | 31.0 | 147401 | 147401 |
| `/api/me` | GET | 15105 | 4.0 | 31.0 | 151037 | 150838 |
| `/api/search` | POST | 12262 | 5.0 | 34.0 | 122620 | 122595 |
| `/api/stacked` | GET | 14222 | 5.0 | 32.0 | 142223 | 142223 |

- **Machine:** linux x64, 2 vCPU, Node 24 — localhost loopback
- **Redis:** 7.4.1, standalone mode (the documented deployment target, §16)
- **Load:** autocannon, 100 connections, 10 s per route, pipelining 1

Resilience, measured on the same run: with Redis killed, the demo returns **503 in 0.4–1.7 ms** (never hangs, never leaks a `RateLimit-*` header), the breaker logs `closed → open` after 5 consecutive failures, probes `half-open` after the 10 s cooldown, and re-closes on the first successful probe.

## API

### Middleware

```ts
import { createThrottle, perIp, perUser, perApiKey } from '@throttle/core';

const throttle = createThrottle({ tiers, failMode: 'closed', maxCost: 100 });

// one rule
app.get('/x', throttle('anonymous', { by: perIp }), handler);

// stacked rules — all evaluated, deny if any denies, all-or-nothing consume
app.get('/y', throttle([
  { tier: 'anonymous', by: perIp },
  { tier: 'authenticated', by: perUser, cost: (req) => computeCost(req) },
]), handler);
```

One factory per service — it owns the shared Redis store and one breaker.

### Tiers (DECISIONS §8)

```ts
const tiers = defineTiers({
  anonymous:     { algorithm: 'sliding-window', limit: 60,  window: '1m' },
  authenticated: { algorithm: 'token-bucket',   capacity: 100, refill: 10, refillUnit: 's' },
  apiKey:        { algorithm: 'token-bucket',   capacity: 1000, refill: 100, refillUnit: 's' },
  internal:      { algorithm: 'token-bucket',   capacity: 10000, refill: 5000, refillUnit: 's' },
});
```

Typed, validated at boot (unknown algorithms and bad numbers throw before the first request), reusable across services, env-overridable per tier (`THROTTLE_TIER_<NAME>_<CAPACITY|LIMIT|REFILL>`) — no config files, no rebuild.

### Resolvers (DECISIONS §7)

| Resolver | Identity | Note |
|---|---|---|
| `perIp` | `req.ip` | only as honest as Express `trust proxy` |
| `perUser` | `req.user?.id` | missing identity **fails loudly** (500), never degrades to a shared bucket |
| `perApiKey` | `sha256(x-api-key)` | raw keys never reach Redis |

Pluggable by design: a resolver is `(req) => string`; compose identities (e.g. user + route) without forking. Authentication is out of scope — resolvers only read what upstream auth already put on the request.

### Response contract (DECISIONS §12)

Success carries draft-8 headers from the **most constrained** rule; denial carries the **worst** rule's numbers plus `Retry-After`:

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 60
RateLimit-Remaining: 0
RateLimit-Reset: 60
Retry-After: 60

{"error":"rate_limited","rule":"anonymous:ip","limit":60,"remaining":0,"retryAfter":60,"cost":1}
```

`RateLimit-Reset` is *seconds until reset* (draft-8), and a configurable `onDenied` hook can replace the body without forking the middleware.

### Failure mode (DECISIONS §13)

Redis unreachable or script error → **503 Service Unavailable**, no `RateLimit-*` headers (no numbers are knowable), wrapped by a circuit breaker (5 failures / 10 s cooldown / 1 half-open probe, all configurable). A denial is never a breaker failure. Fail-closed is the honest default; fail-open exists as an opt-in and logs loudly.

## What each package is

```
throttle/
  packages/core/        @throttle/core — middleware, algorithms, Lua, resolvers, tiers, breaker
  apps/demo/            Express service wiring the library across five sample routes
  packages/load-test/   autocannon benchmark + the invariant assertion script
```

## Stretch goals (documented, not built — §16)

Progressive backoff / escalation on repeated denial, temporary bans, and a penalty tier are the natural third layer on top of the two algorithms. They are deliberately out of scope: they would compete with the load test for time, and half-building them is worse than describing them.

## Deferred / known limitations (from the decision record)

| # | Item | Status |
|---|---|---|
| D1 | Token-bucket refill arithmetic matrix; cost-unit storage in windows (one ZSET member per unit — decided, documented in `throttle.lua`) | settled for v0 |
| D2 | Circuit-breaker tuning (5/10s/half-open is provisional) | needs sustained-outage measurement |
| D3 | Dynamic-cost function shapes | hard cap shipped (`maxCost`, default 100); shapes need a soak test |
| D4 | Benchmark numbers | measured and quoted above — machine-dependent by nature |
| D5 | `trust proxy` interaction | demo sets it from env; a simulated proxy would test it properly |
| D6 | Single-script size limit | script is O(rules); stacks beyond a handful of rules unmeasured |

Also out of scope: Redis Cluster (§16 — and that constraint is exactly what makes the single-script design legal), authentication, config hot-reload, an admin API, persistence beyond Redis, and a test framework — the last argued explicitly in §15: atomicity cannot be proven against a fake, so the repo carries one instrument (the invariant script) instead of two.

## Why no test suite?

The two questions a reviewer asks first. **Why no Cluster?** §16 — the same-slot rule would force one script per rule, eroding the two properties the whole design exists to provide. **Why no test suite?** §15 — the only correctness-critical claim is atomic behavior under real concurrency, which a mocked store cannot answer; the invariant script fires real load at real Redis and asserts the result, which is a stronger statement than any fixture suite. Both link to the decision record rather than hoping you'll read it.
