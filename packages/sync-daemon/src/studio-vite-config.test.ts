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
});
