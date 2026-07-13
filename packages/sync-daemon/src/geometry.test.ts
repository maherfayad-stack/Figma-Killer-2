import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCanvasJson, writeCanvasJsonAtomic } from './canvas-json.js';
import { createGeometryWriter } from './geometry.js';

describe('createGeometryWriter', () => {
  let fileFolderRoot: string;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-geometry-'));
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  it('persists a geometry update into canvas.json (creates the entry if absent)', async () => {
    const writer = createGeometryWriter({ debounceMs: 10 });

    await writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 100, y: 200, w: 800, h: 600 });

    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 100, y: 200, w: 800, h: 600 }]);
  });

  it('updates an existing entry in place without disturbing others', async () => {
    await writeCanvasJsonAtomic(fileFolderRoot, {
      frames: [
        { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 },
        { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 },
      ],
      comments: [],
      zoomBookmarks: [],
    });

    const writer = createGeometryWriter({ debounceMs: 10 });
    await writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 50, y: 60, w: 700, h: 500 });

    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta.frames).toEqual([
      { framePath: 'src/frames/Hero.tsx', x: 50, y: 60, w: 700, h: 500 },
      { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 },
    ]);
  });

  it('debounces rapid updates for the same key into a single write of the final value', async () => {
    const writer = createGeometryWriter({ debounceMs: 40 });

    const p1 = writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 1, y: 1, w: 1, h: 1 });
    const p2 = writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 2, y: 2, w: 2, h: 2 });
    const p3 = writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 3, y: 3, w: 3, h: 3 });

    await Promise.all([p1, p2, p3]);

    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 3, y: 3, w: 3, h: 3 }]);
  });

  it('calls onWritten exactly once per flushed key with the resulting FrameMeta', async () => {
    const written: Array<{ root: string; framePath: string }> = [];
    const writer = createGeometryWriter({
      debounceMs: 10,
      onWritten: (root, framePath) => written.push({ root, framePath }),
    });

    await writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 1, y: 1, w: 1, h: 1 });
    await writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 2, y: 2, w: 2, h: 2 });

    expect(written).toEqual([
      { root: fileFolderRoot, framePath: 'src/frames/Hero.tsx' },
      { root: fileFolderRoot, framePath: 'src/frames/Hero.tsx' },
    ]);
  });

  it('the resulting canvas.json is still FrameMeta-valid after a geometry write', async () => {
    const writer = createGeometryWriter({ debounceMs: 10 });
    await writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 10, y: 20, w: 30, h: 40 });

    // readCanvasJson validates against the frozen FrameMeta schema and
    // throws on failure — resolving at all is the assertion.
    await expect(readCanvasJson(fileFolderRoot)).resolves.toBeDefined();
  });

  it('flushAll flushes every pending write immediately', async () => {
    const writer = createGeometryWriter({ debounceMs: 60_000 }); // would never fire on its own within the test

    const pending = writer.schedule(fileFolderRoot, 'src/frames/Hero.tsx', { x: 9, y: 9, w: 9, h: 9 });
    await writer.flushAll();
    await pending;

    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 9, y: 9, w: 9, h: 9 }]);
  });
});
