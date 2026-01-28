# @throttle/load-test — the proof instruments

Two runnable instruments, no test suite. DECISIONS §14 and §15 explain why:
the correctness question here is **atomicity under concurrency**, and a
mocked store cannot answer it. These scripts fire real concurrent load at
real Redis and count.

## 1. `npm run invariant` — the correctness claim

A hand-rolled fetch-based script that hammers the demo app and asserts the
actual invariant: **the number of successful requests never exceeds the
configured limit.** It exits non-zero on violation.

Seven cases, deliberately adversarial:

| # | Case | Assertion |
|---|---|---|
| 1 | Token-bucket burst — 200 concurrent at capacity 50 | exactly 50 succeed |
| 2 | Sliding-window burst — 200 concurrent at limit 50 | exactly 50 succeed |
| 3 | Zero-limit burst | every request denied |
| 4 | Stacked burst | admits exactly the limit; the never-exhausting rule's counter equals `capacity − successes` (charged once per success) |
| 5 | Stacked all-or-nothing | after rule B is full, 10 further requests are all denied **and rule A's counter does not move** |
| 6 | Report-worst (DECISIONS §10) | per-IP fine, per-user blown → the 429 names the per-IP rule on every denial |

Cases 4–5 verify all-or-nothing consumption **by reading the store**: after
the burst, rule A's token count is compared against `capacity − successes`
with ±1 token of refill slack. If the script had charged denied requests,
the number would drift and the case would fail.

### Run it

```bash
npm run dev            # terminal 1 — demo app + Redis (docker compose up -d redis)
npm run load-test      # terminal 2 — exits 0 on success
```

Environment: `TARGET_URL` (default `http://127.0.0.1:3000`), `REDIS_URL`
(default `redis://127.0.0.1:6379`), `INVARIANT_BURST` (default 200),
`INVARIANT_LIMIT` (default 50).

The script resets its own keys (`throttle:lt-*`, `throttle:anonymous:ip:*`)
before the cases that need clean buckets, so it is re-runnable back to back.

Expected output:

```
  PASS  token-bucket burst — 50/50 admitted from 200 concurrent (expected exactly 50); denied=150, 503=0, keysCleared=0
  PASS  sliding-window burst — 50/50 admitted from 200 concurrent (expected exactly 50); denied=150, 503=0
  PASS  zero-limit burst — admitted=0 (expected 0), denied=50/50
  PASS  stacked burst admits exactly the limit — 50/50 admitted from 200 concurrent; denied=150
  PASS  stacked rule A charged exactly once per success — rule A tokens=99950.0001, expected≈99950 (capacity − successes)
  PASS  stacked denial charges nothing (all-or-nothing) — fill=50/50, secondBurstOk=0/10 (expected 0), rule A tokens=99950.00092000028, expected≈99950
  PASS  report-worst names the most-over-its-limit rule — ok=60/60, denied=10/10, rule named "anonymous:ip" on 10/10 denials

INVARIANT HELD — 0 violations across 7 cases. (TARGET_URL=http://127.0.0.1:3000)
```

## 2. `npm run bench` — the numbers

autocannon produces the README table: sustained RPS, latency percentiles
(p50/p99), total requests, and non-2xx counts.

```bash
npm run dev            # terminal 1
npm run bench          # terminal 2 — ~10s per route
```

Environment: `TARGET_URL`, `BENCH_DURATION` (default 10s), `BENCH_CONNECTIONS`
(default 100), `BENCH_ROUTES` (comma-separated GET paths to override).

**Read the Non-2xx column correctly.** On the throttled demo routes a 429 is
the limiter doing its job — at 100 connections the buckets saturate within
the first second, so nearly every response is a 429, and the row measures
*sustained denial throughput* (the cost of saying no, honestly, at full
speed). The `/api/lt/bench` row is effectively unthrottled and shows the raw
middleware + atomic-script overhead that all the other rows are paying on
top of.

A benchmark that only reports throughput can be fast and wrong. The invariant
script above is what proves the numbers mean anything — run both.
