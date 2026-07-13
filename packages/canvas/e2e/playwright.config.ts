import { defineConfig } from '@playwright/test';

/**
 * P1 acceptance e2e (playbook §5.10, DoD: "at least one Playwright e2e
 * driving the real canvas against the real daemon"). No `webServer` block
 * here — `tests/acceptance.spec.ts` boots the real sync-daemon and the
 * dev-harness Vite server itself in `beforeAll` (same discipline as
 * `packages/sync-daemon/src/e2e.demo.test.ts`: this file IS the demo, not
 * just a test wrapping one), so it controls the exact lifecycle needed to
 * mutate/restore `files/demo` fixtures around the real thing.
 *
 * Run: `pnpm --filter @ccs/canvas run test:e2e`
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
