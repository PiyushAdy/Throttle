import autocannon from 'autocannon';
import { arch, cpus, platform } from 'node:os';
import Redis from 'ioredis';

/**
 * The benchmark instrument (DECISIONS §14, PLAN Phase 6).
 *
 * autocannon produces the README table: sustained RPS, latency percentiles,
 * total requests, and non-2xx counts. A benchmark that only reports
 * throughput can be fast and wrong — pair this with invariant.ts, which
 * proves correctness.
 *
 * Usage:
 *   TARGET_URL=http://127.0.0.1:3000 npm run bench
 *   BENCH_DURATION=15 BENCH_CONNECTIONS=50 npm run bench
 *
 * 429 responses are counted in Non-2xx by design — on the throttled demo
 * routes they mean the limiter is doing its job at saturation. The
 * `/api/lt/bench` row is effectively unthrottled and shows raw middleware +
 * script overhead.
 */

interface RouteSpec {
  path: string;
  method: 'GET' | 'POST';
  body?: string;
}

const BASE = process.env.TARGET_URL ?? 'http://127.0.0.1:3000';
const DURATION = Number(process.env.BENCH_DURATION ?? 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 100);

const HEADERS: Record<string, string> = {
  'x-user-id': 'bench-user',
  'x-api-key': 'bench-api-key',
  'content-type': 'application/json',
};

const DEFAULT_ROUTES: RouteSpec[] = [
  { path: '/api/lt/bench', method: 'GET' },
  { path: '/api/public', method: 'GET' },
  { path: '/api/me', method: 'GET' },
  {
    path: '/api/search',
    method: 'POST',
    body: JSON.stringify({ q: 'distributed rate limiting', results: 30 }),
  },
  { path: '/api/stacked', method: 'GET' },
];

function parseRoutes(raw: string | undefined): RouteSpec[] {
  if (!raw) return DEFAULT_ROUTES;
  return raw.split(',').map((p) => ({ path: p.trim(), method: 'GET' as const }));
}

async function redisVersion(): Promise<string | null> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    const info = await client.info('server');
    const line = info.split('\n').find((l) => l.startsWith('redis_version:'));
    return line ? line.split(':')[1].trim() : null;
  } catch {
    return null;
  } finally {
    client.disconnect();
  }
}

async function runOne(spec: RouteSpec): Promise<autocannon.Result> {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url: `${BASE}${spec.path}`,
        method: spec.method,
        body: spec.body,
        headers: HEADERS,
        duration: DURATION,
        connections: CONNECTIONS,
        pipelining: 1,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      },
    );
  });
}

async function main(): Promise<void> {
  const routes = parseRoutes(process.env.BENCH_ROUTES);
  console.log(
    `autocannon benchmark — ${CONNECTIONS} connections, ${DURATION}s per route, target ${BASE}`,
  );
  console.log('');
  console.log('| Route | Method | Avg RPS | p50 (ms) | p99 (ms) | Total | Non-2xx |');
  console.log('|---|---|---:|---:|---:|---:|---:|');

  for (const spec of routes) {
    const result = await runOne(spec);
    const rps = Math.round(result.requests.average);
    const p50 = result.latency.p50.toFixed(1);
    const p99 = result.latency.p99.toFixed(1);
    const total = result.requests.total;
    const non2xx = result.non2xx;
    console.log(
      `| \`${spec.path}\` | ${spec.method} | ${rps} | ${p50} | ${p99} | ${total} | ${non2xx} |`,
    );
  }

  const rv = await redisVersion();
  console.log('');
  console.log(
    JSON.stringify({
      machine: `${platform()} ${arch()} — ${cpus().length} vCPU`,
      redisVersion: rv,
      connections: CONNECTIONS,
      durationSec: DURATION,
      note: 'Numbers are machine-dependent — always quote machine, Redis version, and mode alongside them (DECISIONS §14).',
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
