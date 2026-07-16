import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeStudioViteConfig } from './studio-vite-config.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEMO_ROOT = join(REPO_ROOT, 'files', 'demo');

describe('writeStudioViteConfig', () => {
  let tempProjectRoot: string | undefined;

  afterEach(async () => {
    if (tempProjectRoot) {
      await rm(tempProjectRoot, { recursive: true, force: true });
      tempProjectRoot = undefined;
    }
  });

  it('writes the generated config under <projectRoot>/.studio/vite/, never inside the file-folder', async () => {
    tempProjectRoot = await mkdtemp(join(tmpdir(), 'ccs-studio-vite-config-'));

    const configPath = await writeStudioViteConfig({
      projectRoot: tempProjectRoot,
      fileFolderRoot: DEMO_ROOT,
      fileFolderName: 'demo',
    });

    expect(configPath).toBe(join(tempProjectRoot, '.studio', 'vite', 'demo.studio-config.mjs'));
    expect(configPath.startsWith(DEMO_ROOT)).toBe(false);
  });

  it('embeds absolute paths (not bare specifiers) for @ccs/vite-plugin-source-uid, @ccs/bridge, vite, and the user config', async () => {
    tempProjectRoot = await mkdtemp(join(tmpdir(), 'ccs-studio-vite-config-'));

    const configPath = await writeStudioViteConfig({
      projectRoot: tempProjectRoot,
      fileFolderRoot: DEMO_ROOT,
      fileFolderName: 'demo',
    });
    const content = await readFile(configPath, 'utf8');

    expect(content).not.toMatch(/from ["']@ccs\/(vite-plugin-source-uid|bridge)["']/);
    expect(content).toMatch(/vite-plugin-source-uid[\\/]src[\\/]index\.ts/);
    expect(content).toMatch(/bridge[\\/]src[\\/]index\.ts/);
    expect(content).toContain(join(DEMO_ROOT, 'vite.config.ts'));
    expect(content).toContain('mergeConfig(userConfig, studioOverlay)');
    expect(content).toContain('sourceUidPlugin({ enabled: true })');
    expect(content).toContain('/@fs/');
    expect(content).toContain('installBridge();');
  });

  it('widens server.fs.allow to the resolved package directories', async () => {
    tempProjectRoot = await mkdtemp(join(tmpdir(), 'ccs-studio-vite-config-'));
    const configPath = await writeStudioViteConfig({
      projectRoot: tempProjectRoot,
      fileFolderRoot: DEMO_ROOT,
      fileFolderName: 'demo',
    });
    const content = await readFile(configPath, 'utf8');
    expect(content).toMatch(/fs:\s*{[\s\S]*?allow:\s*\[/);
  });

  it('§6 blocker #1: aliases the bare "design-system" specifier to the built dist so an inserted DS component resolves', async () => {
    tempProjectRoot = await mkdtemp(join(tmpdir(), 'ccs-studio-vite-config-'));
    const configPath = await writeStudioViteConfig({
      projectRoot: tempProjectRoot,
      fileFolderRoot: DEMO_ROOT,
      fileFolderName: 'demo',
    });
    const content = await readFile(configPath, 'utf8');
    const expectedIndexJs = join(tempProjectRoot, 'design-system', 'dist', 'index.js');
    const expectedIndexCss = join(tempProjectRoot, 'design-system', 'dist', 'index.css');
    const expectedDistDir = join(tempProjectRoot, 'design-system', 'dist');

    // resolve.alias present with both entries, derived from THIS call's
    // projectRoot — never hardcoded, never accepted from wire input.
    expect(content).toMatch(/resolve:\s*{[\s\S]*?alias:\s*{/);
    expect(content).toContain(`'design-system': ${JSON.stringify(expectedIndexJs)}`);
    expect(content).toContain(`'design-system/dist/index.css': ${JSON.stringify(expectedIndexCss)}`);
    // the CSS alias (more specific) must be registered before the bare
    // "design-system" alias, or the bare entry could shadow it.
    expect(content.indexOf('design-system/dist/index.css')).toBeLessThan(
      content.lastIndexOf("'design-system':"),
    );

    // server.fs.allow additionally includes the DS dist dir so Vite serves it.
    expect(content).toContain(JSON.stringify(expectedDistDir));
  });
});
