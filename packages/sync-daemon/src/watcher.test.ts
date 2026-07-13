import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@ccs/protocol';
import { watchCanvasJson, watchDesignSystem, watchFrameFiles, type WatchHandle } from './watcher.js';

describe('watchFrameFiles / watchCanvasJson / watchDesignSystem', () => {
  let projectRoot: string;
  let fileFolderRoot: string;
  const openHandles: WatchHandle[] = [];

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ccs-watch-'));
    fileFolderRoot = join(projectRoot, 'files', 'demo');
    await mkdir(join(fileFolderRoot, 'src', 'frames'), { recursive: true });
    await mkdir(join(fileFolderRoot, '.studio'), { recursive: true });
    await writeFile(
      join(fileFolderRoot, '.studio', 'canvas.json'),
      JSON.stringify({ frames: [], comments: [], zoomBookmarks: [] }),
    );
  });

  afterEach(async () => {
    for (const h of openHandles) await h.close();
    openHandles.length = 0;
    await rm(projectRoot, { recursive: true, force: true });
  });

  function collect(): { events: DaemonEvent[]; emit: (e: DaemonEvent) => void } {
    const events: DaemonEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  it('emits file-changed when a new frame file is added', async () => {
    const { events, emit } = collect();
    openHandles.push(watchFrameFiles(projectRoot, fileFolderRoot, emit));

    await writeFile(
      join(fileFolderRoot, 'src', 'frames', 'NewFrame.tsx'),
      'export default function NewFrame() { return null; }\n',
    );

    await vi.waitFor(() => {
      expect(events).toContainEqual({ t: 'file-changed', file: 'files/demo/src/frames/NewFrame.tsx' });
    }, { timeout: 3000, interval: 30 });
  });

  it('emits file-changed and hmr-update when an existing frame file is edited', async () => {
    await writeFile(
      join(fileFolderRoot, 'src', 'frames', 'Hero.tsx'),
      'export default function Hero() { return null; }\n',
    );

    const { events, emit } = collect();
    openHandles.push(watchFrameFiles(projectRoot, fileFolderRoot, emit));

    await writeFile(
      join(fileFolderRoot, 'src', 'frames', 'Hero.tsx'),
      'export default function Hero() { return "edited"; }\n',
    );

    await vi.waitFor(() => {
      expect(events).toContainEqual({ t: 'file-changed', file: 'files/demo/src/frames/Hero.tsx' });
      expect(events).toContainEqual({ t: 'hmr-update', file: 'files/demo/src/frames/Hero.tsx' });
    }, { timeout: 3000, interval: 30 });
  });

  it('emits file-changed when a frame file is removed', async () => {
    await writeFile(
      join(fileFolderRoot, 'src', 'frames', 'ToDelete.tsx'),
      'export default function ToDelete() { return null; }\n',
    );

    const { events, emit } = collect();
    openHandles.push(watchFrameFiles(projectRoot, fileFolderRoot, emit));
    // Let chokidar finish its initial directory scan before deleting —
    // otherwise it may not yet know "ToDelete.tsx" exists to watch it for
    // removal (ignoreInitial only suppresses the initial add *events*, it
    // doesn't skip the scan that has to happen before unlink detection
    // works).
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { unlink } = await import('node:fs/promises');
    await unlink(join(fileFolderRoot, 'src', 'frames', 'ToDelete.tsx'));

    await vi.waitFor(() => {
      expect(events).toContainEqual({ t: 'file-changed', file: 'files/demo/src/frames/ToDelete.tsx' });
    }, { timeout: 3000, interval: 30 });
  });

  it('emits file-changed when .studio/canvas.json is edited externally', async () => {
    const { events, emit } = collect();
    openHandles.push(watchCanvasJson(projectRoot, fileFolderRoot, emit));

    await writeFile(
      join(fileFolderRoot, '.studio', 'canvas.json'),
      JSON.stringify({
        frames: [{ framePath: 'src/frames/Hero.tsx', x: 1, y: 1, w: 100, h: 100 }],
        comments: [],
        zoomBookmarks: [],
      }),
    );

    await vi.waitFor(() => {
      expect(events).toContainEqual({ t: 'file-changed', file: 'files/demo/.studio/canvas.json' });
    }, { timeout: 3000, interval: 30 });
  });

  it('emits tokens-changed / components-changed on design-system changes', async () => {
    await mkdir(join(projectRoot, 'design-system', 'tokens'), { recursive: true });
    await mkdir(join(projectRoot, 'design-system', 'components', 'Button'), { recursive: true });

    const { events, emit } = collect();
    openHandles.push(watchDesignSystem(projectRoot, emit));
    // Same readiness discipline as the unlink test above: let chokidar
    // finish its initial recursive scan of design-system/ before writing,
    // otherwise the very first write can race the scan and be missed.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await writeFile(join(projectRoot, 'design-system', 'tokens', 'tokens.json'), '{}');
    await writeFile(
      join(projectRoot, 'design-system', 'components', 'Button', 'Button.tsx'),
      'export default function Button() { return null; }\n',
    );

    await vi.waitFor(() => {
      expect(events).toContainEqual({ t: 'tokens-changed' });
      expect(events).toContainEqual({ t: 'components-changed' });
    }, { timeout: 3000, interval: 30 });
  });
});
