import { defineConfig } from 'vitest/config';

/**
 * `packages/canvas` has TWO kinds of `*.spec.ts`/`*.test.ts`-shaped files
 * that must never be mixed up:
 *  - `src/**\/*.test.ts` — real vitest unit tests (pure-logic modules, DoD
 *    requirement).
 *  - `e2e/tests/**\/*.spec.ts` — Playwright tests (own runner, own config
 *    at `e2e/playwright.config.ts`, run via `pnpm run test:e2e`).
 * Without this exclude, vitest's default glob picks up the Playwright
 * spec too and fails immediately (`test.describe.configure()` isn't
 * valid outside the Playwright test runner).
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'e2e/**', 'dev/**'],
  },
});
