# Throttle — Decision Record

**Project:** Throttle — a distributed rate-limiting library packaged as drop-in Express middleware for multi-instance services.
**Status:** Interview complete. Awaiting `GO` to begin implementation.
**Date:** 2026-09-11
**Basis:** A from-scratch rate limiter modeled on the repo shape and proof style of [QueueGate](https://github.com/PiyushAdy/QueueGate).

This document is the source of truth for *what* we are building and *why*. The companion `PLAN.md` covers *how* and *in what order*.

---

## 1. Purpose & Positioning

**Decision:** Portfolio/demo-grade project, not a library that production services depend on.

**Why:** The goal is to demonstrate distributed-systems competence — atomic concurrency control, honest failure modes, measured performance — the same story QueueGate tells for ticketing. Building for real production adoption would impose a stability and support burden out of proportion to the demo value.

**How to apply:** Where a choice trades elegance for durability, prefer the one that reads better in a README. Prefer demonstrating a correctness property over supporting an exotic edge case. Do not add a second algorithm or a feature that competes with the load test for time.

**Shape:** One clone-and-run repo mirroring QueueGate — library core, demo Express service, and a load-test script, with real measured numbers in the README.

**Layout:** npm workspaces.

```
throttle/
  packages/core/        the library — middleware, algorithms, Lua, resolvers, tiers
  apps/demo/            Express service wiring the library up
  packages/load-test/   autocannon benchmark + the invariant assertion script
```

---

## 2. Stack

| Layer | Choice | Note |
|---|---|---|
| Language | TypeScript | strict mode throughout |
| Runtime | Node.js 18+ | matches QueueGate's floor |
| HTTP | Express | "drop-in Express middleware" is the stated deliverable |
| Store | Redis | the atomicity engine, not a cache |
| Client | **ioredis** | `defineCommand` for the preloaded Lua script with EVALSHA fallback |
| Build | tsup | dual ESM + CJS with `.d.ts` |
| Benchmark | autocannon | RPS, latency percentiles, non-2xx counts |

**Rejected:** `node-redis` — official, but its script management is more manual for exactly the thing we lean on hardest (`defineCommand` and the EVALSHA/EVAL fallback).

---

## 3. Algorithms

Two, exactly. No third.

### Token bucket
Stored as a Redis hash per key:

```
throttle:{<scope>:<key>}  →  { tokens: <float>, lastRefillTs: <ms> }
```

Refilled **lazily** inside the Lua script at read time — no background ticker. On each request the script computes elapsed time since `lastRefillTs`, adds `elapsed * refillRate` tokens, clamps to capacity, then attempts to consume the request's cost.

Supports a natural burst up to `capacity`. This is the algorithm for "N requests, replenishing at R per second."

### Sliding window
Stored as a ZSET per key: member = a unique request id, score = the request timestamp in ms.

On each request the script trims members older than `now - window`, counts what remains, and admits the request only if `count + cost <= limit`.

Exact — no edge-of-window burst artifact, at the cost of one ZSET member per in-window request.

**Rejected:** two-counter fixed-window interpolation (cheaper memory, approximate at window edges — the approximation is the opposite of what this repo is trying to demonstrate).

---

## 4. Request Cost

**Decision:** Every request carries a cost. Default `1`. Cost is **dynamic** — it may be a function of the request, not merely a static per-route constant.

**Why:** This is what makes "configurable limit tiers" a real capability rather than decoration. A `POST /search` that fans out to five backends can honestly declare `cost: 5`, and the caller's effective rate becomes one-fifth.

**How to apply:** The middleware accepts an optional cost — a number or `(req) => number`. The Lua script consumes `cost` units and the 429 body reports the cost charged. **A hard cap on cost is required** (see Deferred) so a single malformed request cannot consume an absurd number of units.

---

## 5. Time Source

**Decision:** Redis server time — `redis.call('TIME')` inside the Lua script — is the single clock for refill and window trimming. Node's `Date.now()` is never the authority.

**Why:** In a multi-instance deployment, per-instance clocks drift. A limiter whose refill math reads a local clock will silently over- or under-admit depending on which instance served the request. Using Redis time makes the limit a property of the store, not the caller.

**How to apply:** The script calls `redis.call('TIME')` itself. Do not pass a timestamp in as an argument. Node-side timestamps may be used for logging only. See Deferred for the fallback behavior.

---

## 6. Key Expiry

**Decision:** Every script sets a natural TTL on every key it touches, and re-applies that TTL on **every write**.

- Token bucket TTL = time to fully refill from empty (`capacity / refillRate`).
- Sliding window TTL = the window length.

**Why:** Without expiry, a busy multi-tenant service leaks a Redis key per distinct caller forever. Active keys must not expire mid-window, so the TTL is refreshed on each write rather than set once.

**How to apply:** README states plainly that **expiry is a safety net, not the limiter mechanism**. The limiter's correctness comes from the counters and the arithmetic; the TTL only reclaims memory for keys nobody is using.

**Rejected:** a fixed one-size TTL (a 10-second window would still hold memory for an hour); a background sweeper process (Redis TTL already does this natively, and a sweeper adds a failure mode).

---

## 7. Key Resolvers

**Decision:** Pluggable. A resolver is a function `(req: Request) => string` returning the bucket key. Three built-ins ship:

| Resolver | Key source | Note |
|---|---|---|
| `perIp` | `req.ip` | depends on Express `trust proxy` being configured correctly |
| `perUser` | `req.user?.id` | assumes upstream auth populated `req.user` |
| `perApiKey` | `sha256(req.headers['x-api-key'])` | **raw keys never reach Redis** |

**Why:** The three are named in the original spec. Hashing the API key means a Redis dump or a `MONITOR` session never exposes live credentials. Making resolvers pluggable means a consumer can add a composite identity (e.g. `userId + route`) without forking.

**How to apply:** **Authentication is explicitly out of scope.** Resolvers read what is already on the request; the library never issues or validates credentials. If `req.user` is absent the `perUser` resolver must fail loudly in development, not silently degrade to a shared bucket.

---

## 8. Tier Configuration

**Decision:** Named tiers in a **typed TypeScript config object**. No external config file. No admin write path.

```ts
const tiers = {
  anonymous:     { algorithm: 'sliding-window', limit: 60,  window: '1m' },
  authenticated: { algorithm: 'token-bucket',   capacity: 100, refill: 10, refillUnit: 's' },
  apiKey:        { algorithm: 'token-bucket',   capacity: 1000, refill: 100, refillUnit: 's' },
  internal:      { algorithm: 'token-bucket',   capacity: 10000, refill: 5000, refillUnit: 's' },
} as const;
```

A route references a tier **by name** plus an optional resolver and cost:

```ts
app.post('/search', throttle('authenticated', { by: perUser, cost: dynamicCost }), handler);
```

Capacity is overridable by env var so the demo is tweakable without a rebuild.

**Why:** Type-checked at compile time, reusable across services, and it maps directly onto the "configurable limit tiers, allowing easy reuse across services with varying throttling policies" bullet in the brief.

**Rejected:** inline per-route options (limits drift and duplicate across routes); external JSON/YAML (untyped, misconfigurable at runtime).

---

## 9. Rule Composition

**Decision:** A route may stack multiple rules — a global rule, a per-key rule, and a per-route override. **All rules are evaluated.** The request is denied if **any** rule denies. Consumption is **all-or-nothing**: if any rule denies, no rule is charged.

**Why:** Real throttling policy is layered: a service-wide ceiling *and* a per-user limit *and* a tighter limit on an expensive endpoint, all at once. One-rule-per-route cannot express that.

All-or-nothing consumption is the stronger semantic and it falls out of the single-script design in §11. Under per-rule evaluation a denied request could be charged against the rules that happened to pass, quietly spending a caller's headroom on a request that never ran. Charging nothing on denial makes the counters mean "requests actually served."

---

## 10. Deny Reporting — "Report Worst"

**Decision:** With all rules evaluated, the 429 reports the rule that is **most over its limit**.

**Why this needed resolving:** Two earlier answers — "first denial short-circuits" and "most restrictive rule wins" — are contradictory. On a request where a route override would admit but the per-IP rule denies, short-circuiting reports per-IP while "most restrictive" would first have to check everything and then choose.

**Worked example:** stack `perIp` (100/min) and `perUser` (10/min). A user fires 20 requests. Per-IP is fine; per-user is blown by 10. **Report per-user.**

**How to apply:** Evaluate every rule. Deny if any denies. Report the rule with the largest shortfall, so the `RateLimit-Remaining` value in the response never overstates how much headroom the caller actually has. The worst-rule choice is made **inside the Lua script**, so it stays within the atomic section and Node never has to re-derive it.

**Rejected:** short-circuit-and-report-first (cheaper by one call, but the reported numbers can understate throttling); report-all (most transparent, largest payload, noisier for a client that just wants to back off).

---

## 11. Single Atomic Script for the Whole Stack

**Decision:** Every rule attached to a request is evaluated **inside one Lua script invocation**. The script receives one key per rule plus a JSON descriptor per rule, evaluates all of them, and commits only if all of them allow.

**Why this shape:** Redis executes a Lua script atomically — no other command interleaves while it runs. Putting the whole rule stack in one script therefore makes **the stack itself atomic**, not merely each rule. That buys two things a per-rule design cannot:

- **Evaluate-then-commit.** The script can check every rule first and write to none of them if any denies. This is what makes §9's all-or-nothing consumption possible.
- **One round trip.** A request's entire limit decision is a single `EVALSHA`, regardless of how many rules are stacked.

**Why this was not possible before:** a single Lua script in Redis Cluster may only touch keys that hash to the same slot. Since stacked rules deliberately use unrelated keys (a per-IP key and a per-user key hash differently), Cluster forced the split into one script per rule. **Cluster support is not a requirement of this project, so that constraint is gone** — and with it the hot-spot coupling that `{hash-tag}` slot-pinning would have introduced.

**How to apply:** The script takes `KEYS[1..N]` (one per rule) and a single `ARGV[1]` holding a JSON array of rule descriptors (algorithm, parameters, cost, request id). It runs `redis.call('TIME')` once and uses that one timestamp for every rule. It builds a per-rule result — `{ allowed, remaining, limit, retryAfter }` — and, if all allowed, makes a second pass that applies every consume and refreshes every TTL. If any rule denied, the second pass is skipped entirely.

**Bounded work:** the script is O(rules) and contains no loop over window members — `ZREMRANGEBYSCORE` does the trimming. Keeping the script short matters because Redis is single-threaded while it runs.

**Multi-instance correctness is unaffected.** Several Node instances sharing one Redis still get exact limits, because the decision is made by the store, not the caller (§5). Dropping Cluster means the deployment target is a single Redis instance — which is what the demo runs and what the README documents.

**Rejected:** one script per rule fired through a pipeline (the Cluster-compatible design; leaves the stack non-atomic and forces partial consumption on denial); `{hash-tag}` slot-pinning (couples unrelated keys into one slot and creates a hot-spot).

---

## 12. Denied Response Contract

**Decision:** `429 Too Many Requests` carrying the IETF **draft-8** rate-limit fields, plus `Retry-After`, plus a structured JSON body.

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 4
Retry-After: 4
Content-Type: application/json

{
  "error": "rate_limited",
  "rule": "perUser",
  "limit": 10,
  "remaining": 0,
  "retryAfter": 4,
  "cost": 1
}
```

Successful requests also carry `RateLimit-Limit` / `-Remaining` / `-Reset`, so a well-behaved client can slow down before it is denied.

**Why:** The draft-8 fields are the current standards-track shape and read as forward-looking in a portfolio. `Retry-After` means even a client that ignores everything else still knows when to come back. The `rule` field makes the "report worst" behavior observable.

**Rejected:** legacy `X-RateLimit-*` (widely deployed but dated); both header families behind a flag (noisy, and the compatibility story is not the point here).

---

## 13. Failure Mode — Fail-Closed with 503

**Decision:** When Redis is unreachable or the script errors, deny with **503 Service Unavailable**, not 429.

- No `RateLimit-*` headers on a 503 — no numbers are knowable.
- A **circuit breaker** sits in front: **5** consecutive failures trips it, **10s** cooldown, then a **half-open** probe. Status and thresholds are configurable.

**Why 503 and not 429:** a 429 tells the caller "you did something wrong, back off." If Redis is down, the caller did nothing wrong and backing off does not help — the dependency is the problem. 503 says that honestly and lets infrastructure (load balancers, retry policies) react correctly.

**Why a circuit breaker:** without one, every request during an outage pays the full Redis connection timeout, converting a dependency outage into a latency outage. The breaker fails fast during the cooldown and probes once to detect recovery.

**Fail-closed, not fail-open:** the opposite choice — admit everything when the store is down — is defensible for availability, but it means an outage silently removes the limit and can turn a rate-limit failure into a capacity incident. For a limiter, closed is the honest default; the README should note fail-open as a configurable alternative and why one would choose it.

---

## 14. Proof — autocannon plus an Invariant Script

**Decision:** Ship both, as npm scripts.

1. **`autocannon`** produces the README table — sustained RPS, latency percentiles (p50/p99), total requests, and non-2xx counts.
2. **A hand-rolled fetch-based script** hammers a capped route and asserts the actual invariant: **the number of successful requests never exceeds the configured limit**. It exits non-zero on violation.

**Why both:** autocannon gives the pretty numbers; the invariant script proves correctness. A benchmark that only reports throughput can be fast and wrong. Mirroring QueueGate's "0.00% oversell rate" line with a "0 violations" line is the single most convincing artifact in a repo like this.

**Why a script and not a test suite:** the correctness question here is atomicity under concurrency, and the only honest way to ask it is to fire real concurrent load at real Redis and count. A mocked store cannot answer it, and a fixture-based suite would duplicate what the invariant script already proves end to end. The script is deliberately adversarial — it runs against both algorithms and against a stacked-rule route, because those can fail differently.

**How to apply:** Both runnable via npm scripts. **README numbers must be measured on the demo machine, not estimated** — quote the machine, the Redis version, and the Redis mode alongside the numbers.

---

## 15. Tooling

| Concern | Choice |
|---|---|
| Build | `tsup` → dual ESM + CJS + `.d.ts` |
| Benchmark | `autocannon` |
| Correctness proof | the invariant script (§14) |
| Entry points | `npm run build`, `npm run load-test`, `npm run dev` |

**Why:** `tsup` is fast and emits both module formats with types in one step. There is no unit-test suite: the correctness-critical paths are the Lua script and the concurrency behavior around it, and those are proven against real Redis by the invariant script. **A fake Redis cannot verify atomicity** — asserting the invariant on the real store is a stronger claim than mocking it, so the repo carries one instrument instead of two.

---

## 16. Out of Scope

**Escalation / penalty box.** Progressive backoff, temporary bans, and a penalty tier are **not built**. They appear as an explicit stretch section in the README.

**Why:** Escalation is a third algorithm layered on top of the two already committed to. It would compete directly with the load test for time, and half-building it is worse than documenting it. Listing it signals awareness of the problem without shipping a rushed version.

**Test suite.** No unit or integration test framework. **Why:** as argued in §15, atomicity is the only thing worth proving here and it cannot be proven against a fake; the invariant script covers the real claim. Fixture tests would add a suite whose green light means less than the one number the script prints.

**Dashboard.** No browser UI. **Why:** the demo app already exposes the routes and the invariant script already prints the outcome; a page adds UI surface without adding evidence. The README carries the argument instead.

**Redis Cluster.** Standalone Redis only, and the client does not detect or route for Cluster. **Why:** the single-script design in §11 needs every one of a request's keys in one script, and Cluster's same-slot rule forbids exactly that for unrelated keys. Multi-instance correctness — the property that actually matters here — comes from a shared store, not from sharding it.

Also out of scope, per earlier decisions: authentication, config hot-reload, an admin API, and any persistence beyond Redis.

---

## Deferred — Needs a Prototype or Measurement

These are **high-fidelity** items. They cannot be settled by discussion; they need code or a running system to answer honestly.

| # | Item | What it needs |
|---|---|---|
| D1 | **Token bucket refill arithmetic** — fractional tokens across multiple windows; exact burst-above-capacity semantics | a script and a table-driven matrix of refill cases |
| D2 | **Circuit breaker tuning** — 5 / 10s / half-open is a guess | exercising the failure path under sustained load |
| D3 | **Dynamic cost function shapes** — which request properties are cheap to read; the hard cap on cost | a prototype and a soak test |
| D4 | **All README performance numbers** — RPS, p99, denial counts | measurement, not estimation |
| D5 | **`trust proxy` interaction** — `perIp` is only as good as the proxy config | a simulated proxy in front of the demo app |
| D6 | **Single-script size limit** — how many stacked rules fit before the JSON descriptor or script runtime becomes a problem | a route with an unrealistic number of stacked rules, measured |

---

## Decision Index

| # | Decision | Section |
|---|---|---|
| 1 | Portfolio/demo-grade, workspaces layout | §1 |
| 2 | TypeScript + Node 18 + Express + Redis + ioredis | §2 |
| 3 | Token bucket (hash, lazy refill) + sliding window (ZSET log) | §3 |
| 4 | Per-request cost, default 1, dynamic | §4 |
| 5 | Redis server time as the single clock | §5 |
| 6 | Natural TTL per key, refreshed per write | §6 |
| 7 | Pluggable resolvers; per-IP, per-user, per-API-key (hashed) | §7 |
| 8 | Named tiers in typed TS config, env-overridable capacity | §8 |
| 9 | Stacked rules, all evaluated, deny if any denies, all-or-nothing consume | §9 |
| 10 | Report the rule most over its limit, chosen inside the script | §10 |
| 11 | One atomic script per request for the whole rule stack | §11 |
| 12 | 429 + draft-8 RateLimit headers + Retry-After + JSON body | §12 |
| 13 | Fail-closed with 503 + circuit breaker | §13 |
| 14 | autocannon numbers + custom invariant assertion | §14 |
| 15 | tsup + autocannon; no test framework | §15 |
| 16 | Escalation, tests, dashboard, and Cluster documented, not built | §16 |