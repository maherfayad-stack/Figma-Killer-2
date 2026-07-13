import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * P1 acceptance-demo harness (BOUNDARIES: thin dev harness under
 * packages/canvas/). Serves `dev/index.html` + `main.tsx`, which mounts
 * the real `StudioCanvas` against a real daemon (`pnpm demo:daemon`,
 * separately). `root` points at this directory so the harness has its
 * own tiny `index.html` distinct from any future `apps/studio` entry.
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5555,
    strictPort: true,
    host: '127.0.0.1',
  },
});
