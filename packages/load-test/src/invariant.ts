import { createHash } from 'node:crypto';
import Redis from 'ioredis';

/**
 * The invariant assertion script (DECISIONS §14, PLAN Phase 6).
 *
 * The correctness question here is ATOMICITY UNDER CONCURRENCY, and the only
 * honest way to ask it is to fire real concurrent load at real Redis and
 * count. This script is deliberately adversarial — it runs against both
 * algorithms and against a stacked-rule route, because those can fail
 * differently.
 *
 * The invariant: THE NUMBER OF SUCCESSFUL REQUESTS NEVER EXCEEDS THE
 * CONFIGURED LIMIT. Exits non-zero on violation.
 *
 * Prereqs: demo app running (npm run dev) against Redis.
 *   TARGET_URL=http://127.0.0.1:3000 REDIS_URL=redis://127.0.0.1:6379 npm run load-test
 *
 * Cases:
 *   1. token-bucket burst — 200 concurrent admits against capacity 50 →
 *      exactly 50 succeed (the oversell test, in miniature; PLAN Phase 1)
 *   2. sliding-window burst — same shape, exact window limit 50
 *   3. zero-limit burst — limit 0 denies every request
 *   4. stacked all-or-nothing — 200 concurrent at a two-rule route; the
 *      counter of the rule that never exhausts must equal
 *      capacity − successes (charged once per SUCCESS, never for denials)
 *   5. stacked uncharged denials — fill rule B exactly with sequential
 *      admits, then fire denials at rule B; rule A's counter must not move
 *   6. report-worst (DECISIONS §10) — stack perIp (60/min) + perUser
 *      (bucket 100); fire 70 as one user: first 60 pass, the last 10 are
 *      denied BY THE PER-IP RULE, whose shortfall is largest
 */

const BASE = process.env.TARGET_URL ?? 'http://127.0.0.1:3000';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const BURST = Number(process.env.INVARIANT_BURST ?? 200);
const LIMIT = Number(process.env.INVARIANT_LIMIT ?? 50);

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface BurstStats {
  ok: number;
  denied: number;
  unavailable: number;
  other: number;
  deniedRules: string[];
}

interface StackedBody {
  error?: string;
  rule?: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function scanDel(redis: Redis, pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}

/** Fire `n` truly concurrent requests at once — a burst, not a ramp. */
async function burst(
  path: string,
  n: number,
  headers: Record<string, string>,
): Promise<BurstStats> {
  const stats: BurstStats = { ok: 0, denied: 0, unavailable: 0, other: 0, deniedRules: [] };
  const requests = Array.from({ length: n }, () =>
    fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(15_000) }),
  );
  const responses = await Promise.all(requests);
  for (const res of responses) {
    if (res.ok) {
      stats.ok += 1;
      continue;
    }
    if (res.status === 429) {
      stats.denied += 1;
      try {
        const body = (await res.json()) as StackedBody;
        if (body?.rule) stats.deniedRules.push(body.rule);
      } catch {
        // body parse failure does not change the verdict
      }
      continue;
    }
    if (res.status === 503) stats.unavailable += 1;
    else stats.other += 1;
  }
  return stats;
}

async function sequential(
  path: string,
  n: number,
  headers: Record<string, string>,
): Promise<BurstStats> {
  const stats: BurstStats = { ok: 0, denied: 0, unavailable: 0, other: 0, deniedRules: [] };
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.ok) stats.ok += 1;
    else if (res.status === 429) {
      stats.denied += 1;
      try {
        const body = (await res.json()) as StackedBody;
        if (body?.rule) stats.deniedRules.push(body.rule);
      } catch {
        // ignore
      }
    } else if (res.status === 503) stats.unavailable += 1;
    else stats.other += 1;
  }
  return stats;
}

function check(result: CaseResult[], name: string, ok: boolean, detail: string): void {
  result.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

async function main(): Promise<void> {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  const results: CaseResult[] = [];

  // Sanity: the demo must be up before any case fires.
  try {
    const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`status ${health.status}`);
  } catch (err) {
    console.error(`Demo app at ${BASE} is not reachable (${(err as Error).message}).`);
    console.error('Start it first:  npm run dev   (and Redis:  docker compose up -d redis)');
    redis.disconnect();
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Case 1 — token bucket: bucket starts full, admits exactly `capacity`.
  // -------------------------------------------------------------------------
  {
    const cleared = await scanDel(redis, 'throttle:lt-bucket:*');
    const stats = await burst('/api/lt/bucket', BURST, {});
    check(
      results,
      'token-bucket burst',
      stats.ok === LIMIT,
      `${stats.ok}/${LIMIT} admitted from ${BURST} concurrent (expected exactly ${LIMIT}); denied=${stats.denied}, 503=${stats.unavailable}, keysCleared=${cleared}`,
    );
  }

  // -------------------------------------------------------------------------
  // Case 2 — sliding window: exact trim + count under concurrency.
  // -------------------------------------------------------------------------
  {
    await scanDel(redis, 'throttle:lt-window:*');
    const stats = await burst('/api/lt/window', BURST, {});
    check(
      results,
      'sliding-window burst',
      stats.ok === LIMIT,
      `${stats.ok}/${LIMIT} admitted from ${BURST} concurrent (expected exactly ${LIMIT}); denied=${stats.denied}, 503=${stats.unavailable}`,
    );
  }

  // -------------------------------------------------------------------------
  // Case 3 — zero limit: every request denied.
  // -------------------------------------------------------------------------
  {
    await scanDel(redis, 'throttle:lt-zero:*');
    const stats = await burst('/api/lt/zero', 50, {});
    check(
      results,
      'zero-limit burst',
      stats.ok === 0 && stats.denied === 50,
      `admitted=${stats.ok} (expected 0), denied=${stats.denied}/50`,
    );
  }

  // -------------------------------------------------------------------------
  // Case 4 — stacked all-or-nothing under a burst.
  // Rule A (lt-stack-a, perApiKey) never exhausts; rule B (lt-stack-b,
  // perUser) trips at 50. After the burst, A must hold exactly
  // capacity − successes: charged once per success, never for a denial.
  // -------------------------------------------------------------------------
  {
    const runId = `inv4-${Date.now()}`;
    const headers = { 'x-api-key': runId, 'x-user-id': runId };
    const stats = await burst('/api/lt/stacked', BURST, headers);
    const keyA = `throttle:lt-stack-a:apikey:${sha256(runId)}`;
    const tokens = Number((await redis.hget(keyA, 'tokens')) ?? 'NaN');
    const expected = 100_000 - stats.ok;
    const chargedHonesty = Math.abs(tokens - expected) <= 1; // ±1 token of refill slack
    check(
      results,
      'stacked burst admits exactly the limit',
      stats.ok === LIMIT,
      `${stats.ok}/${LIMIT} admitted from ${BURST} concurrent; denied=${stats.denied}`,
    );
    check(
      results,
      'stacked rule A charged exactly once per success',
      Number.isFinite(tokens) && chargedHonesty,
      `rule A tokens=${tokens}, expected≈${expected} (capacity − successes)`,
    );
  }

  // -------------------------------------------------------------------------
  // Case 5 — all-or-nothing when rule B is already exhausted.
  // 50 sequential admits fill rule B exactly; 10 further concurrent requests
  // must ALL be denied, and rule A's counter must not move for them.
  // -------------------------------------------------------------------------
  {
    const runId = `inv5-${Date.now()}`;
    const headers = { 'x-api-key': runId, 'x-user-id': runId };
    const fill = await sequential('/api/lt/stacked', LIMIT, headers);
    const deniedBurst = await burst('/api/lt/stacked', 10, headers);
    const keyA = `throttle:lt-stack-a:apikey:${sha256(runId)}`;
    const tokens = Number((await redis.hget(keyA, 'tokens')) ?? 'NaN');
    const expected = 100_000 - fill.ok; // the 10 denials must have charged nothing
    check(
      results,
      'stacked denial charges nothing (all-or-nothing)',
      fill.ok === LIMIT &&
        deniedBurst.ok === 0 &&
        Number.isFinite(tokens) &&
        Math.abs(tokens - expected) <= 1,
      `fill=${fill.ok}/${LIMIT}, secondBurstOk=${deniedBurst.ok}/10 (expected 0), rule A tokens=${tokens}, expected≈${expected}`,
    );
  }

  // -------------------------------------------------------------------------
  // Case 6 — report-worst (DECISIONS §10 worked example).
  // perIp (anonymous, 60/min) + perUser (authenticated, bucket 100 @ 10/s).
  // One user fires 70 sequential requests: per-user is fine (70 < 100),
  // per-IP blows at 61..70 → the 429 must name the per-IP rule.
  // -------------------------------------------------------------------------
  {
    await scanDel(redis, 'throttle:anonymous:ip:*');
    const headers = { 'x-user-id': `inv6-${Date.now()}` };
    const stats = await sequential('/api/stacked', 70, headers);
    const worstNamed = stats.deniedRules.filter((r) => r === 'anonymous:ip').length;
    check(
      results,
      'report-worst names the most-over-its-limit rule',
      stats.ok === 60 && stats.denied === 10 && worstNamed === 10,
      `ok=${stats.ok}/60, denied=${stats.denied}/10, rule named "anonymous:ip" on ${worstNamed}/${stats.denied} denials`,
    );
  }

  await redis.quit();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(
    failed.length === 0
      ? `INVARIANT HELD — 0 violations across ${results.length} cases. (TARGET_URL=${BASE})`
      : `INVARIANT VIOLATED — ${failed.length}/${results.length} cases failed.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
