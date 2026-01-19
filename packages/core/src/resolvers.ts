import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { MissingIdentityError } from './errors.js';

/**
 * Pluggable key resolvers (DECISIONS §7).
 *
 * A resolver is a function `(req) => string` returning the bucket identity.
 * Authentication is explicitly out of scope — resolvers read what is already
 * on the request; the library never issues or validates credentials.
 *
 * The perUser resolver fails loudly when identity is absent (DECISIONS §7:
 * "must fail loudly in development, not silently degrade to a shared
 * bucket"). A missing identity is a wiring mistake and becomes a 500.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id?: string; [key: string]: unknown };
    }
  }
}

export interface Resolver {
  (req: Request): string;
  readonly name: string;
}

function makeResolver(name: string, fn: (req: Request) => string): Resolver {
  const resolver = fn as Resolver;
  // Function.name is non-writable at runtime — define it explicitly so the
  // tag shows up in rule scopes and structured logs.
  Object.defineProperty(resolver, 'name', { value: name, configurable: true });
  return resolver;
}

/** Identity = req.ip. Depends on Express `trust proxy` being configured honestly (D5). */
export const perIp: Resolver = makeResolver('ip', (req) => {
  const ip = req.ip ?? req.socket.remoteAddress;
  if (!ip) {
    throw new MissingIdentityError(
      'ip',
      'req.ip was empty. Configure Express "trust proxy" so client IPs resolve.',
    );
  }
  return ip;
});

/** Identity = req.user.id, populated by upstream auth middleware. */
export const perUser: Resolver = makeResolver('user', (req) => {
  const id = req.user?.id;
  if (!id) {
    throw new MissingIdentityError(
      'user',
      "req.user.id is missing. Authentication is out of scope for the limiter — populate req.user upstream (see the demo's fakeAuth for a shim) or pick another resolver.",
    );
  }
  return String(id);
});

/**
 * Identity = sha256(x-api-key). RAW KEYS NEVER REACH REDIS — a Redis dump or
 * a MONITOR session never exposes live credentials (DECISIONS §7).
 */
export const perApiKey: Resolver = makeResolver('apikey', (req) => {
  const raw = req.header('x-api-key');
  if (!raw) {
    throw new MissingIdentityError('apikey', 'the "x-api-key" header is absent');
  }
  return createHash('sha256').update(raw).digest('hex');
});
