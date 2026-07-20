import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Sub-workstream 2b (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) dev harness
 * for the new plain-React `Canvas`/`FrameShape` engine — same shape as
 * `dev/vite.config.ts` (root here, react plugin, fixed port), but a
 * separate config/port so this harness can run alongside the existing
 * tldraw-backed `demo:harness` (port 5555) without a conflict.
 * `dev/custom-engine-harness.html` is the entry (not `dev/index.html`,
 * which stays the P1/tldraw harness's own entry).
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5556,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    rollupOptions: {
      input: 'custom-engine-harness.html',
    },
  },
});
