import { defineConfig } from '@playwright/test';

/**
 * P5 acceptance e2e (playbook §4/P5, DoD: "an agent-written Playwright
 * script builds a small landing page start-to-finish using only the UI").
 * No `webServer` block — `tests/acceptance.spec.ts` boots the REAL
 * sync-daemon and the REAL `apps/studio` Vite dev server itself in
 * `beforeAll` (same discipline as `packages/canvas/e2e`), so it controls
 * the exact lifecycle needed to mutate/restore `files/demo` fixtures
 * around the real thing.
 *
 * Run: `pnpm --filter @ccs/studio run test:e2e`
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
