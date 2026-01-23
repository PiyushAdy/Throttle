import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import {
  createThrottle,
  perApiKey,
  perIp,
  perUser,
  resolveFailMode,
  type CostInput,
} from '@throttle/core';
import { fakeAuth } from './fakeAuth.js';
import { tiers } from './tiers.js';

/**
 * Throttle demo service (PLAN Phase 5).
 *
 * Every sample route is reachable from a URL, so the behaviors the README
 * claims — tiers, dynamic cost, stacked rules, report-worst — can be poked
 * with curl. Denials log one structured line each: rule, key scope (API keys
 * are already hashed by their resolver), and cost. That log is this app's
 * whole observability story; make it readable.
 */

const PORT = Number(process.env.PORT ?? 3000);
const failMode = resolveFailMode(process.env.THROTTLE_FAIL_MODE);

const app = express();
app.disable('x-powered-by');
// D5: perIp is only as honest as this setting.
app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
app.use(express.json());
app.use(fakeAuth);

const throttle = createThrottle({
  tiers,
  failMode,
  breaker: {
    threshold: Number(process.env.THROTTLE_BREAKER_THRESHOLD ?? 5),
    cooldownMs: Number(process.env.THROTTLE_BREAKER_COOLDOWN_MS ?? 10_000),
    halfOpenMaxProbes: Number(process.env.THROTTLE_BREAKER_HALF_OPEN_PROBES ?? 1),
  },
});

/** Dynamic cost (DECISIONS §4): POST /search fans out to ~1 backend per 10 results. */
const searchCost: CostInput = (req: Request) => {
  const body = req.body as { results?: unknown } | undefined;
  const raw = Number(body?.results ?? req.query.results ?? 0);
  const results = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return 1 + Math.min(4, Math.floor(results / 10)); // 1..5
};

const ok = (route: string, extra: Record<string, unknown> = {}) => {
  return (_req: Request, res: Response): void => {
    res.json({ ok: true, route, ts: new Date().toISOString(), ...extra });
  };
};

app.get('/', (_req, res) => {
  res.json({
    service: 'throttle-demo',
    routes: {
      'GET /api/public': 'anonymous tier — sliding window 60/min, per-IP, cost 1',
      'GET /api/me': 'authenticated tier — token bucket 100 @ 10/s, per-user (x-user-id header)',
      'POST /api/search':
        'authenticated tier, per-user, DYNAMIC cost 1..5 scaling with body.results',
      'POST /api/internal':
        'apiKey tier — token bucket 1000 @ 100/s, per-API-key (x-api-key header, hashed)',
      'GET /api/stacked':
        'TWO stacked rules (anonymous per-IP + authenticated per-user) — report-worst',
      'GET /api/lt/bucket': 'load-test: token bucket, capacity 50, no refill during a burst',
      'GET /api/lt/window': 'load-test: sliding window, limit 50 / 1m',
      'GET /api/lt/zero': 'load-test: limit 0 — every request denied',
      'GET /api/lt/stacked': 'load-test: stacked pair for the all-or-nothing proof',
      'GET /api/lt/bench': 'load-test: effectively unthrottled clean-throughput row',
      'GET /health': 'liveness + Redis client status',
    },
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, redis: throttle.store.status(), failMode });
});

app.get('/api/public', throttle('anonymous', { by: perIp }), ok('/api/public'));

app.get('/api/me', throttle('authenticated', { by: perUser }), ok('/api/me'));

app.post(
  '/api/search',
  throttle('authenticated', { by: perUser, cost: searchCost }),
  (req, res) => {
    const body = req.body as { results?: unknown } | undefined;
    const raw = Number(body?.results ?? req.query.results ?? 0);
    const results = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    res.json({ ok: true, route: '/api/search', results, ts: new Date().toISOString() });
  },
);

app.post('/api/internal', throttle('apiKey', { by: perApiKey }), ok('/api/internal'));

app.get(
  '/api/stacked',
  throttle([
    { tier: 'anonymous', by: perIp },
    { tier: 'authenticated', by: perUser },
  ]),
  ok('/api/stacked'),
);

// --- load-test routes (packages/load-test) ---------------------------------

app.get('/api/lt/bucket', throttle('lt-bucket', { by: perIp }), ok('/api/lt/bucket'));
app.get('/api/lt/window', throttle('lt-window', { by: perIp }), ok('/api/lt/window'));
app.get('/api/lt/zero', throttle('lt-zero', { by: perIp }), ok('/api/lt/zero'));
app.get(
  '/api/lt/stacked',
  throttle([
    { tier: 'lt-stack-a', by: perApiKey },
    { tier: 'lt-stack-b', by: perUser },
  ]),
  ok('/api/lt/stacked'),
);
app.get('/api/lt/bench', throttle('bench-throughput', { by: perIp }), ok('/api/lt/bench'));

// Identity/cost wiring mistakes fail loudly as 500s (DECISIONS §7); anything
// else unexpected is a generic 500. Redis outages never reach here — the
// middleware already turned them into fast 503s (§13).
app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: 'internal_error', message });
});

const server = app.listen(PORT, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: 'demo_listening',
      port: PORT,
      failMode,
    }),
  );
});

const shutdown = (signal: string): void => {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'shutdown', signal }),
  );
  server.close(async () => {
    await throttle.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
