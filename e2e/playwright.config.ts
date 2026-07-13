import { defineConfig } from '@playwright/test';

/**
 * P0 skeleton. `webServer` boots the file-app template standalone (the
 * P0 acceptance demo — no studio/daemon involved yet). Studio-driving e2e
 * (real canvas, real ws protocol) lands per-phase starting P1.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --dir ../templates/file-app exec vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
