# Throttle — Implementation Plan

**Companion to:** `DECISIONS.md` (read that first — it holds the *why*; this holds the *how* and the *order*)
**Status:** Awaiting `GO`.

---

## Guiding Principles

Three rules govern every choice below.

**Atomicity lives in Redis, not in Node.** Every limit decision — the check and the counter update together — happens inside a Lua script. The Node layer only prepares keys, fires the script, and formats the answer. If you ever find yourself reading a counter in Node and deciding based on it, the design has gone wrong.

**One script per request, not one per rule.** All of a request's stacked rules are evaluated in a single Lua invocation (§11 of the decisions record). This is what makes the stack itself atomic and what allows evaluate-then-commit: on any denial, nothing is charged. Splitting the rules back into separate scripts would quietly undo both properties.

**Every phase ends runnable.** No phase leaves the repo in a state where `npm run build` fails. Each phase has explicit exit criteria that can be checked before moving on.

---

## Phase Overview

| Phase | Name | Depends on | Exit criteria |
|---|---|---|---|
| 0 | Scaffold & tooling | — | `npm run build` succeeds on an empty core |
| 1 | Redis layer & the atomic script | 0 | 200 parallel admits against capacity 5 yield exactly 5, repeatably |
| 2 | Core library — tiers, resolvers, middleware | 1 | A route can be throttled end-to-end with one rule |
| 3 | Response contract — headers & errors | 2 | 429 and success both carry correct draft-8 headers |
| 4 | Resilience — circuit breaker & fail-closed | 3 | Killing Redis yields 503, not a hang |
| 5 | Demo app | 3 | Every sample route responds and throttles as documented |
| 6 | Load test & invariant proof | 4–5 | Invariant script exits 0 across all variants; autocannon table produced |
| 7 | README, benchmarks, polish | 6 | Repo is clone-and-run from a clean machine |

Phases 0–2 are strictly sequential. Phase 3 and Phase 4 can overlap once 2 lands. Phase 5 needs only the response contract, so it can start as soon as Phase 3 is done — and it is worth starting it there, because a running demo app is the most convenient way to eyeball Phase 4's 503 once that lands.

---

## Phase 0 — Scaffold & Tooling

**Goal:** the skeleton exists and builds.

**Deliverables**

- `package.json` at root with workspaces: `packages/*`, `apps/*`.
- `tsconfig.base.json` with `strict: true`, `target: ES2022`, `moduleResolution: bundler`.
- `packages/core/package.json` — name `@throttle/core`, `tsup` build config emitting ESM + CJS + `.d.ts`.
- `apps/demo/package.json` — Express service, depends on `@throttle/core` via workspace protocol.
- `packages/load-test/package.json` — autocannon + the invariant script.
- `docker-compose.yml` — a single Redis 7 service for local dev.
- `.env.example` — `REDIS_URL`, `PORT`, per-tier capacity overrides.
- `.gitignore`, `.editorconfig`, `prettier` config.
- Root scripts: `build`, `dev`, `load-test`, `lint`. (**No `test` script** — see §15 of the decisions record.)

**Notes**

Pin the Node engine to `>=18`. Use `workspace:*` for the internal dependency so the demo always builds against local core.

**Exit criteria:** `npm install && npm run build` completes with an empty `src/index.ts` that exports nothing.

---

## Phase 1 — Redis Layer & the Atomic Script

**Goal:** both algorithms exist inside one script that evaluates a whole rule stack atomically, and the concurrency property is demonstrated.

This is the phase that matters most. Everything downstream is plumbing around this one file.

**Deliverables**

- `packages/core/src/redis/client.ts` — ioredis factory. Accepts `REDIS_URL`, exposes a narrow `RedisClient` interface so the rest of the code never touches ioredis directly.
- `packages/core/src/redis/scripts/throttle.lua` — **one** script, both algorithms, whole stack.
- `packages/core/src/redis/scripts/loader.ts` — registers the script via `defineCommand` so EVALSHA is used after the first call, with automatic fallback to EVAL.
- `packages/core/src/redis/keys.ts` — the single place key names are constructed.
- `packages/core/src/redis/descriptor.ts` — the rule-descriptor type the Node side serializes into `ARGV[1]`, shared by producer and parser so the two cannot drift.

**Script interface**

```
KEYS[1..N]   one key per rule
ARGV[1]      JSON array of rule descriptors:
             [{ algorithm, params, cost, ruleName, requestId }, ...]
```

**Script behavior**

1. `now = redis.call('TIME')` — called **once**, used for every rule (§5).
2. **Evaluate pass.** For each rule, dispatch on `algorithm` and compute `{ allowed, remaining, limit, retryAfter }` **without writing anything**. Track the rule with the largest shortfall as the worst.
3. If every rule allowed → **commit pass**: apply every consume and refresh every TTL.
4. If any rule denied → **write nothing at all** (§9), and return the worst rule's numbers.
5. Return one uniform shape — `{ allowed, remaining, limit, retryAfter, worstRule }` — so the Node layer has exactly one parser.

**Token bucket, per rule**

- Read `tokens` and `lastRefillTs`. If the key is absent, treat it as full.
- `elapsed = now - lastRefillTs`; `tokens = min(capacity, tokens + elapsed * rate)`.
- Allow if `tokens >= cost`; on commit, decrement, write back, refresh TTL (time to fully refill from empty).
- On denial, `retryAfter` = time until enough tokens accumulate. Note that on denial the refill is **not** persisted — the next request recomputes from the stored `lastRefillTs`, which is correct and keeps the denial path write-free.

**Sliding window, per rule**

- `ZREMRANGEBYSCORE key 0 (now - window)` to trim.
- `ZCARD` to count.
- Allow if `count + cost <= limit`; on commit, add `cost` members (or one member carrying cost; **decide and document** — see D1) and refresh TTL to the window length.
- On denial, `retryAfter` from the oldest in-window member's score.

**Why one `TIME` call:** computing `now` per rule would let a long stack straddle a millisecond boundary, giving different rules different clocks within the same atomic decision. One timestamp, one decision.

**Tests (a scratch concurrency script, not a suite)**

This phase needs a way to check itself before the real invariant script exists in Phase 6. Write a throwaway script that fires parallel admits and counts successes, then promote it into `packages/load-test/invariant.ts` later rather than writing the logic twice.

- Bucket starts full and admits exactly `capacity` requests.
- Refill is proportional to elapsed time (control the clock by manipulating `lastRefillTs` directly).
- Window trims correctly at the boundary.
- **Concurrency:** fire 200 parallel admits against a bucket of 5; assert exactly 5 succeed. This is the oversell test, in miniature.
- **Stacked atomicity:** two rules where the second denies; assert the first rule's counter did **not** move. This is the all-or-nothing property from §9 and the reason the single script exists.

**Exit criteria:** the 200-against-5 concurrency test passes, and it passes repeatably — run it 20 times in a loop with no variance.

---

## Phase 2 — Core Library

**Goal:** a route can be throttled with one rule, end to end.

**Deliverables**

- `packages/core/src/tiers.ts` — the typed tier config from §8 of the decisions record, plus env-var capacity overrides and a `resolveTier(name)` lookup. **Validate at load time** — a tier naming an unknown algorithm or a negative capacity should throw at boot, not at request time.
- `packages/core/src/resolvers.ts` — `perIp`, `perUser`, `perApiKey`, plus the `Resolver` type. API key is hashed with SHA-256 before it becomes part of a key.
- `packages/core/src/cost.ts` — cost normalization. Accepts `number | ((req) => number)`, defaults to 1, and **clamps to the hard cap** (see D3). Reject non-finite and negative values loudly.
- `packages/core/src/rules.ts` — the rule type and the stack builder. A rule is `{ tier, by, cost, name }`. Stacking produces an ordered array, and the builder rejects a stack that mixes key scopes it cannot express rather than silently producing a bad key set.
- `packages/core/src/middleware.ts` — the Express middleware. For one request: resolve **every** rule's key, compute **every** rule's cost, build the descriptor array, and fire **one** `EVALSHA`. Collect the result.
- `packages/core/src/decide.ts` — turns the script's return value into the middleware's decision. The script already picked the worst rule (§10); this module only maps the shape, it does not re-derive the choice.
- `packages/core/src/index.ts` — the public surface: `throttle()`, resolvers, tier types, error types.

**Design note on the single call**

There is exactly one Redis round trip per request no matter how many rules are stacked. The middleware never inspects an intermediate counter, and it never needs to know which slot anything lives in. If a future change reintroduces a second call, that is the signal that the §11 decision is being eroded.

**Tests (a scratch script against real Redis)**

- Resolver: `perIp` reads `req.ip`, `perApiKey` hashes, missing `req.user` fails loudly.
- Tier config validation: unknown algorithm throws; env override applies.
- Cost: default, numeric, dynamic function, over-cap clamps, negative throws.
- Decision: the worked example from §10 — per-IP fine, per-user blown → report `perUser`.
- End to end: one route, one rule, real Redis — first N pass, N+1 returns denied.

**Exit criteria:** `app.get('/x', throttle('anonymous', { by: perIp }), handler)` throttles correctly against real Redis.

---

## Phase 3 — Response Contract

**Goal:** headers and error bodies match §12 exactly.

**Deliverables**

- `packages/core/src/headers.ts` — builds `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` from a rule result. On success, headers come from the **most constrained** rule (lowest remaining), so the client sees the tightest ceiling it is actually subject to.
- `packages/core/src/errors.ts` — the 429 JSON body, including `rule`, `limit`, `remaining`, `retryAfter`, and `cost`. A typed `RateLimitError` class.
- A configurable `onDenied` hook so a consumer can override the body without forking the middleware.

**Notes**

`RateLimit-Reset` in draft-8 is **seconds until reset**, not an absolute epoch. Getting this wrong is the classic mistake — assert the unit before moving on.

Because the script returns one result per rule, the "most constrained" and "worst" picks both happen over an array that is already in hand. No extra Redis work.

**Tests (scratch script)**

- Assert every header on a success response and on a 429.
- Assert `Retry-After` is present on 429 and absent on success.
- Assert the JSON body names the correct rule in the stacked scenario.

**Exit criteria:** a `curl` against a throttled route shows the full header set and a well-formed body.

---

## Phase 4 — Resilience

**Goal:** Redis going away produces a fast, honest 503.

**Deliverables**

- `packages/core/src/circuit.ts` — a small state machine: `closed → open → half-open → closed`. Thresholds configurable; defaults 5 failures / 10s cooldown / one half-open probe.
- Failure classification — connection refused, timeout, and script errors all count. A denial (`allowed: false`) is **never** a failure; that is the limiter working.
- Wire the breaker into the middleware: when open, short-circuit to 503 without touching Redis.
- `packages/core/src/failMode.ts` — `closed` (default) vs `open`, per §13. Fail-open is supported but must be opt-in and loud.

**Notes**

Distinguish three outcomes in the middleware, not two: **allowed**, **denied (429)**, and **unavailable (503)**. Collapsing the third into either of the others is the mistake this phase exists to prevent.

A single script per request makes the breaker's job easier than it would be otherwise: there is one Redis interaction to wrap, so "the call failed" is unambiguous. With one call per rule, a partial failure would have forced a decision about which of several failures counts.

**Tests (scratch script)**

- Point the client at a dead port → 503, no `RateLimit-*` headers, fast return.
- Trip the breaker, assert subsequent calls return immediately without a connection attempt (count connection attempts on a mock).
- After cooldown, assert one probe is issued and recovery re-closes the breaker.

**Exit criteria:** `docker compose stop redis` and the demo returns 503 in single-digit milliseconds rather than hanging.

---

## Phase 5 — Demo App

**Goal:** the routes exist and behave as the README will claim.

**Deliverables**

- `apps/demo/src/server.ts` — Express app wiring several sample routes across tiers:
  - `GET /api/public` — anonymous, per-IP, cost 1
  - `GET /api/me` — authenticated, per-user, cost 1
  - `POST /api/search` — authenticated, per-user, **dynamic cost** (scales with the query), demonstrating §4
  - `POST /api/internal` — internal tier, per-API-key
  - `GET /api/stacked` — **two stacked rules** (per-IP and per-user), so the atomicity and report-worst behavior from §9–§11 is reachable from a URL rather than only from the load test
- `apps/demo/src/fakeAuth.ts` — populates `req.user` from a header so `perUser` is demonstrable without real auth. Clearly labeled as demo-only.
- `docker-compose.yml` updated so the app and Redis start together.

**Notes**

Each route should log one structured line per denial — rule, key scope (never the raw key for API keys — log the hash), and cost. That log is the demo's whole "observability" story now, so make it readable.

**Exit criteria:** every route responds; firing past a limit returns a 429 whose body names the expected rule; the stacked route names the *worst* rule.

---

## Phase 6 — Load Test & Invariant Proof

**Goal:** the numbers and the correctness claim, both measured.

**Deliverables**

- `packages/load-test/bench.ts` — autocannon against a capped route. Outputs a markdown table: sustained RPS, p50, p99, total requests, non-2xx count.
- `packages/load-test/invariant.ts` — the hand-rolled assertion, promoted from the Phase 1 scratch script. Fires N concurrent requests at a route with limit L and asserts **successful responses ≤ L**. Also runs the same burst with the limit set to 0 to confirm every request is denied. Exits non-zero on violation.
- `packages/load-test/README.md` explaining what each measures and how to reproduce it.

**Notes**

Run the invariant script against **both** algorithms — token bucket and sliding window. They can fail differently, and the sliding window's ZSET trim is the more subtle of the two under concurrency.

Then run it against the **stacked** route. That is the configuration most likely to reveal a flaw in the evaluate-then-commit logic, and it has its own distinct assertion: after a burst that trips the second rule, the first rule's counter must be untouched. That check is worth more than the raw pass/fail count and should be its own named case.

**Exit criteria:** invariant script exits 0 across all variants, including the all-or-nothing assertion; autocannon table produced with real numbers.

---

## Phase 7 — README, Benchmarks, Polish

**Goal:** the repo tells its story without a narrator.

**Deliverables**

- `README.md` structured like QueueGate's:
  - what it is, one paragraph
  - architecture diagram — Express middleware → single atomic Lua script → Redis, with the 503 path drawn in
  - a "Concurrency & Correctness" section explaining the atomicity argument, including that **the whole stack is atomic and consumption is all-or-nothing**, and what that buys over a per-rule design
  - **Benchmark Results** table with measured numbers, the machine, the Redis version, and the standalone mode stated explicitly
  - a "0 violations" line mirroring QueueGate's "0.00% oversell"
  - API spec: middleware signature, tiers, resolvers, headers, error body
  - Getting Started: `docker compose up`, `npm install`, `npm run dev`
  - **Stretch Goals** section: progressive backoff, temporary bans, penalty tier (§16)
  - a "Deferred / Known Limitations" section carried from the decisions record
- A short `ARCHITECTURE.md` if the README gets long — the atomicity argument and the single-script decision deserve room.
- A short transcript or screenshot of the invariant script output in the README. **No dashboard** — the script's output is the visual.

**Notes**

Quote the decisions record where a reviewer would ask "why this way?" — a link to `DECISIONS.md` from the README makes the reasoning auditable instead of implicit. The two questions a reviewer will actually ask are "why is there no test suite?" and "why no Cluster support?" — both are answered in §15 and §16, so link them directly rather than hoping they read the whole document.

**Exit criteria:** a person who has never seen the repo can clone it, run two commands, and understand what it proves.

---

## Cross-Cutting Concerns

**Error handling.** Fail loudly in development, return 503 in production. Never swallow a Redis error — a limiter that silently stops limiting is worse than one that visibly fails.

**Logging.** Structured, one line per denial with the rule, key scope (never the raw key for API keys — log the hash), and cost. Enough to debug without leaking identity.

**Configuration.** All defaults in code, all overrides via env. No config file, per §8.

**Documentation-in-code.** `throttle.lua` should carry a comment block explaining the atomicity argument and the two-pass structure in place. It is the most-read file in a repo like this and the least obvious.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `throttle.lua` grows complex and becomes hard to review | High | Two clearly separated passes (evaluate, then commit); no loop over window members; keep the descriptor minimal |
| Redis blocks on a long script under load | Medium | Script is O(rules); measure script duration in Phase 6 and record it (D6) |
| Cost cap is set too low and breaks realistic routes | Medium | Make it configurable with a generous default; surface it in the README |
| Circuit breaker is over- or under-sensitive | High | Treat defaults as provisional; tune in Phase 6 under load (D2) |
| Missing test suite is read as an oversight | Medium | §15 argues the case explicitly and the README links it; the invariant script is the substitute and prints a number a suite could not |
| Scope creep from the stretch goals | High | §16 is a hard boundary — escalation stays in the README |
| Benchmark numbers are machine-dependent and misleading | Medium | Always quote machine, Redis version, and mode alongside the numbers |

---

## Execution Checklist

Phase 0 — scaffold builds
Phase 1 — 200-against-5 yields exactly 5; stacked denial charges nothing
Phase 2 — single-rule route throttles end to end
Phase 3 — headers and error body match the contract
Phase 4 — Redis down yields a fast 503
Phase 5 — every sample route responds and reports the right rule
Phase 6 — invariant holds across both algorithms and the stacked route; benchmark numbers measured
Phase 7 — README tells the story unaided