import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { allocatePort } from './port-pool.js';
import { startViteServer, type ViteServerHandle } from './vite-orchestrator.js';
import { writeStudioViteConfig } from './studio-vite-config.js';

/**
 * The P0 standalone contract (playbook §4/P0 pitfall, restated by the
 * ADR-0016 addendum for P2): `templates/file-app` (and every `files/<name>`
 * generated from it) must have ZERO `@ccs/*` dependencies, and standalone
 * `pnpm dev` (no studio env/config) must serve byte-identically to P0 — no
 * `data-uid`, no bridge — regardless of anything P2 WS-A built. This test
 * proves BOTH halves for real, not by inspection alone:
 *  1. `templates/file-app/package.json` has zero `@ccs/*` deps.
 *  2. A real Vite dev server, booted the exact same way the daemon boots
 *     it in NON-studio mode (`startViteServer` with no `studioConfigPath`),
 *     serves HTML/source with no `data-uid` attribute anywhere and no
 *     bridge injected.
 *
 * As a bonus (not required by the acceptance bullet, but the strongest
 * possible evidence the studio-mode wiring actually works rather than just
 * "typechecks"), a second real boot WITH a daemon-generated studio config
 * confirms the opposite: `data-uid` present + bridge script injected —
 * proving the plain boot's cleanliness isn't just "the feature doesn't
 * work at all."
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'files', 'demo');
const TEMPLATE_PACKAGE_JSON = join(REPO_ROOT, 'templates', 'file-app', 'package.json');

describe('P0 standalone contract (templates/file-app + files/<name>)', () => {
  it('templates/file-app/package.json has zero @ccs/* dependencies', async () => {
    const pkg = JSON.parse(await readFile(TEMPLATE_PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const allDepNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    const ccsDeps = allDepNames.filter((name) => name.startsWith('@ccs/'));
    expect(ccsDeps).toEqual([]);
  });
});

describe('studio-mode boot vs. standalone boot (real Vite dev servers)', () => {
  let handle: ViteServerHandle | undefined;
  let tempProjectRoot: string | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
    if (tempProjectRoot) {
      await rm(tempProjectRoot, { recursive: true, force: true });
      tempProjectRoot = undefined;
    }
  });

  it('standalone boot (no studioConfigPath) serves no data-uid anywhere and injects no bridge', async () => {
    const port = await allocatePort(59970);
    handle = await startViteServer({ cwd: DEMO_ROOT, port });

    const heroHtml = await (await fetch(`${handle.url}/?frame=Hero`)).text();
    expect(heroHtml).not.toContain('data-uid');
    expect(heroHtml).not.toContain('installBridge');

    const heroSource = await (await fetch(`${handle.url}/src/frames/Hero.tsx`)).text();
    expect(heroSource).not.toContain('data-uid');
  }, 30_000);

  it('studio-mode boot (daemon-generated config) injects data-uid on transformed source and the bridge script in HTML', async () => {
    tempProjectRoot = await mkdtemp(join(tmpdir(), 'ccs-studio-boot-'));
    const studioConfigPath = await writeStudioViteConfig({
      projectRoot: tempProjectRoot,
      fileFolderRoot: DEMO_ROOT,
      fileFolderName: 'demo',
    });

    const port = await allocatePort(59980);
    handle = await startViteServer({ cwd: DEMO_ROOT, port, studioConfigPath });

    const heroHtml = await (await fetch(`${handle.url}/?frame=Hero`)).text();
    expect(heroHtml).toContain('installBridge');
    expect(heroHtml).toContain('/@fs/');

    // Our plugin runs `enforce: 'pre'`, tagging raw JSX before
    // @vitejs/plugin-react compiles it to `_jsxDEV(tag, props, ...)`
    // calls — so by the time the dev server serves this module, the tag
    // survives as a `"data-uid": "..."` PROPERTY in the props object
    // literal (which React then renders as a real DOM attribute at
    // runtime), not as raw-JSX `data-uid="..."` attribute syntax.
    const heroSource = await (await fetch(`${handle.url}/src/frames/Hero.tsx`)).text();
    expect(heroSource).toContain('"data-uid": "src/frames/Hero.tsx:');
  }, 30_000);
});
