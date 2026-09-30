import { defineConfig } from '@playwright/test'
import {
  E2E_ADMIN_ORIGIN,
  E2E_CMS_PORT,
  E2E_PUBLIC_ORIGIN,
  E2E_VITE_MODE,
  E2E_VITE_PORT,
  E2E_WORKSPACE_DIR,
} from './scripts/lib/e2eStack'
import { OWNER_STATE_FILE } from './tests/e2e/helpers/constants'

// The specs read these back out of the environment through
// `tests/e2e/helpers/constants.ts`. Stamping them here (rather than leaving each
// spec to re-derive a default) is what lets a whole run move to another port
// with one variable: the runner, its workers, and the `webServer` below then all
// name the same origins.
process.env.E2E_ADMIN_BASE_URL = E2E_ADMIN_ORIGIN
process.env.E2E_PUBLIC_BASE_URL = E2E_PUBLIC_ORIGIN
process.env.E2E_WORKSPACE_DIR = E2E_WORKSPACE_DIR

const LOCAL_TRACE = process.env.E2E_TRACE === '1'
const LOCAL_VIDEO = process.env.E2E_VIDEO === '1'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: '.tmp/playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '.tmp/playwright-report' }],
  ],
  use: {
    baseURL: E2E_ADMIN_ORIGIN,
    screenshot: 'only-on-failure',
    // The full single-worker suite keeps every open SSE request in a trace.
    // Recording every local test can therefore consume gigabytes before the
    // worker finishes and discards passing artifacts. Keep local capture opt-in;
    // CI records only the first retry, where an artifact is actionable.
    trace: process.env.CI ? 'on-first-retry' : LOCAL_TRACE ? 'retain-on-failure' : 'off',
    video: process.env.CI ? 'on-first-retry' : LOCAL_VIDEO ? 'retain-on-failure' : 'off',
  },
  // The disposable DB is set up once per run, so first-run setup runs in its own
  // `setup` project; every spec then reuses the shared owner session it saved.
  //
  // The former `dashboard-preflight` and `personas` projects were removed with the
  // CMS-only specs they existed for (clean-install dashboard facts, and throwaway
  // accounts for destructive self-management tests). The specs that remain are
  // Studio-relevant — shell navigation, canvas/visual builder, pages, preview,
  // files/deps, perf, a11y, reliability — and each owns whatever fixtures it needs.
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: 'e2e',
      testMatch: '**/*.e2e.ts',
      dependencies: ['setup'],
      use: { storageState: OWNER_STATE_FILE },
    },
  ],
  webServer: {
    command: 'bun run e2e:dev',
    // `/admin`, not `/`. `vite.config.ts` proxies `/` into the CMS's
    // public-site renderer, which on a just-created database takes seconds and
    // depends on state nothing here controls; `/admin` is the editor's own
    // `index.html`, served by Vite, and is where every spec goes first anyway.
    // The stack script probes the same URL before it reports itself up.
    url: `${E2E_ADMIN_ORIGIN}/admin`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    // Everything the stack cannot guess from its own defaults, and the one
    // thing that is not a default at all:
    //
    // `VITE_ALLOWED_ORIGIN` is the CSRF origin allowlist entry
    // (`server/auth/security.ts`'s `DEV_ORIGIN_ALLOWLIST`). That list hardcodes
    // 5173/5174 on both hosts, so the DEFAULT ports have always worked and any
    // other port made first-run setup die on "Forbidden: invalid origin" —
    // which every agent running an isolated stack then rediscovered by hand.
    // The config knows which origin the browser will send, so it states it.
    //
    // NOTE for `E2E_REUSE_SERVER=1`: none of this reaches a stack you started
    // yourself. Export the same variables in that shell — or just use the
    // defaults, which need nothing.
    env: {
      E2E_VITE_MODE,
      E2E_VITE_PORT,
      E2E_CMS_PORT,
      E2E_WORKSPACE_DIR,
      VITE_ALLOWED_ORIGIN: E2E_ADMIN_ORIGIN,
    },
    // A ceiling, not a delay: it costs nothing when the stack boots normally
    // (2-5s warm). It has to clear `scripts/e2e-dev.ts`'s own boot supervision —
    // three attempts, each allowed 180s to reach `listen()` for a cold
    // dependency pre-bundle — so that a stack which genuinely cannot start
    // reports the supervisor's own explanation rather than this bare timeout.
    timeout: 600_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 500 },
    // Relayed into the run's output, which is the only way a boot failure is
    // readable rather than a bare timeout. `scripts/lib/stackChild.ts` explains
    // why these pipes used to hang Vite on Windows, and what the stack does
    // about it now.
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
