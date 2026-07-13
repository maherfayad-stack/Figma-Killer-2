import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { allocatePort, isPortFree } from './port-pool.js';
import { startViteServer, type ViteServerHandle } from './vite-orchestrator.js';

/**
 * Real Vite dev server orchestration — the core of playbook §4/P1 step 2.
 * Uses the repo's own `files/demo` fixture (created by `pnpm create-file
 * demo`, a standalone install per the playbook §4/P0 pitfall), so this
 * proves the daemon can actually boot a real, unmodified file-folder's
 * dev server — not a stand-in. This fixture is read-only from this test's
 * point of view; nothing here writes into `files/demo`.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'files', 'demo');

describe('startViteServer (real vite, files/demo fixture)', () => {
  let handle: ViteServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it(
    'boots a real vite dev server bound to 127.0.0.1 and serves both frames (incl. the Arabic-content Pricing frame)',
    async () => {
      const port = await allocatePort(59950);
      handle = await startViteServer({ cwd: DEMO_ROOT, port });

      expect(handle.host).toBe('127.0.0.1');
      expect(handle.url).toBe(`http://127.0.0.1:${port}`);
      expect(handle.pid).toBeGreaterThan(0);

      const heroRes = await fetch(`${handle.url}/?frame=Hero`);
      expect(heroRes.status).toBe(200);
      const heroHtml = await heroRes.text();
      expect(heroHtml).toContain('<div id="root">');

      // Pricing.tsx is the Arabic/RTL fixture frame (playbook §5.9) —
      // serving it successfully is part of the daemon's Arabic-content
      // acceptance evidence, even though the index.html shell itself
      // doesn't inline the Arabic text (React renders it client-side).
      const pricingRes = await fetch(`${handle.url}/?frame=Pricing`);
      expect(pricingRes.status).toBe(200);

      const sourceRes = await fetch(`${handle.url}/src/frames/Pricing.tsx`);
      expect(sourceRes.status).toBe(200);
      const source = await sourceRes.text();
      expect(source).toContain('خطط الأسعار');
    },
    30_000,
  );

  it('stop() actually terminates the child process and frees the port', async () => {
    const port = await allocatePort(59960);
    handle = await startViteServer({ cwd: DEMO_ROOT, port });

    expect(await isPortFree(port)).toBe(false);
    await handle.stop();
    handle = undefined;

    expect(await isPortFree(port)).toBe(true);
  }, 30_000);
});
