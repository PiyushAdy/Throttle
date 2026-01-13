import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThrottleConfigError } from '../../errors.js';

/**
 * Loads `throttle.lua` — the single source of truth for the rate-limit script.
 *
 * Resolution covers every layout the script can be loaded from:
 *  - running from source (`src/redis/scripts/`) via tsx/ts-node/dev,
 *  - the bundled `dist/` build, where tsup copies the .lua next to the bundle,
 *  - a `dist/redis/scripts` layout, should the entry ever move.
 */
export function loadThrottleLua(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'throttle.lua'),
    join(here, 'redis', 'scripts', 'throttle.lua'),
    join(here, '..', 'src', 'redis', 'scripts', 'throttle.lua'),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new ThrottleConfigError(`throttle.lua not found. Looked in:\n  ${candidates.join('\n  ')}`);
}
