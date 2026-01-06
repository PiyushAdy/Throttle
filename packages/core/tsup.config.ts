import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build with .d.ts (DECISIONS §2 / §15).
 *
 * `throttle.lua` is the single source of truth for the script — `onSuccess`
 * copies it next to the bundle so `loader.ts` can read it at runtime from
 * whichever output format is loaded.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  target: 'es2022',
  async onSuccess() {
    cpSync(
      new URL('./src/redis/scripts/throttle.lua', import.meta.url),
      new URL('./dist/throttle.lua', import.meta.url),
    );
  },
});
