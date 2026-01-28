# Architecture

This document holds the two arguments a reviewer will actually interrogate:
**why one Lua script per request**, and **what the stack's atomicity buys**.
DECISIONS.md is the full decision record; PLAN.md is the build order. The
README shows the results — this explains the machinery.

```
                      ┌──────────────────────────────────────────────────┐
                      │                    Node #N                       │
                      │                                                  │
 request ──► Express middleware (@throttle/core)                         │
                      │                                                  │
                      │  1. resolve every rule's key      (per-request)  │
                      │  2. compute every rule's cost     (per-request)  │
                      │  3. serialize rule descriptors    (per-request)  │
                      │  4. ONE EVALSHA ────────────────  per request    │
                      │                                                  │
                      │        allowed ─► draft-8 headers ─► next()      │
                      │        denied  ─► 429 + Retry-After + body       │
                      │        error   ─► breaker ●► 503 (no headers)    │
                      └───────────────────────┬──────────────────────────┘
                                              │
                            ┌─────────────────▼─────────────────┐
                            │                Redis               │
                            │                                    │
                            │  throttle.lua — ATOMIC             │
                            │  ┌──────────────────────────────┐  │
                            │  │ PASS 1  evaluate every rule  │  │
                            │  │         (writes NOTHING)     │  │
                            │  │ PASS 2  commit (only if ALL  │  │
                            │  │         allowed) + refresh   │  │
                            │  │         TTLs                 │  │
                            │  └──────────────────────────────┘  │
                            │                                    │
                            │  token bucket → HASH per key       │
                            │  sliding window → ZSET per key     │
                            │  clock = TIME (called once)        │
                            └────────────────────────────────────┘
```

## Why one script per request, not one per rule

A route can stack several rules — a service-wide ceiling, a per-user limit,
a tighter limit on an expensive endpoint. The naive implementation fires one
Lua script per rule (or pipelines them). That has two defects this design
refuses:

**Non-atomic stack.** Between rule 1's script and rule 2's script, other
commands interleave. Per-rule outcomes are still individually atomic, but
the *stack* is not: two requests can each pass a different rule and both
consume, and a denied request can be charged by the rules that happened to
pass before the denial was discovered.

**Partial consumption on denial.** With one script per rule, by the time
rule 3 denies, rules 1–2 have already consumed. Rolling that back needs
compensation logic in Node — a second class of failure for a rate limiter.

The single-script design (DECISIONS §11) evaluates every rule first, writes
nothing if any rule denies, and commits all rules together otherwise. The
request's entire limit decision is one `EVALSHA` — one round trip, no
interleaving, no rollback path, no Node-side counter reads ever.

## All-or-nothing consumption

Because the evaluate pass writes nothing, a denial charges nothing — not to
the denied rule, and not to the rules that would have allowed the request.
Counters therefore mean *requests actually served*. This is the property the
invariant script's cases 4–5 verify against real Redis: after a burst where
the second rule denies, the first rule's counter equals
`capacity − successes`, exactly.

## Why Redis time, why TTLs, why hashed API keys

- **One clock.** The script calls `TIME` once; every rule is judged on the
  same timestamp (§5). Per-instance clocks would make the limit a property
  of whichever Node served the request.
- **TTL is a janitor, not the mechanism.** Correctness comes from the
  counters and arithmetic; the TTL (bucket: time to refill from empty;
  window: window length, refreshed per write) only reclaims memory for keys
  nobody is using (§6).
- **Hashed API keys.** `perApiKey` stores `sha256(key)`; a Redis dump or
  MONITOR session never exposes live credentials (§7).

## The 503 path

Redis down is not a rate-limit event. The middleware distinguishes three
outcomes — allowed, denied (429), unavailable (503) — and the breaker sits
in front: 5 consecutive store failures open it, every request during the
cooldown short-circuits to a sub-millisecond 503 without touching Redis, one
probe after 10s detects recovery, success re-closes. A denial
(`allowed: false`) is never a breaker failure — that is the limiter working.
Fail-open exists as an opt-in and is loud about it (§13).

## What is deliberately not here

Cluster support (the same-slot rule forbids unrelated keys in one script —
§16), escalation/penalty tiers (§16), a test framework (§15), a dashboard
(§16). Each is documented, argued, and out of scope on purpose.
