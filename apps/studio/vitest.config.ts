import { defineConfig } from 'vitest/config';

/**
 * `apps/studio` has TWO kinds of `*.spec.ts`/`*.test.ts`-shaped files that
 * must never be mixed up: `src/**\/*.test.ts` (real vitest unit tests) vs
 * `e2e/tests/**\/*.spec.ts` (Playwright, own runner, `pnpm run test:e2e`).
 * Without this exclude, vitest's default glob picks up the Playwright spec
 * too and fails immediately (`test.describe.configure()` isn't valid
 * outside the Playwright test runner) — same fix `packages/canvas` needed.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'e2e/**'],
  },
});
