import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrameMeta } from '@ccs/protocol';
import {
  frameMetaEquals,
  readCanvasJson,
  reconcileCanvasJson,
  syncFrameEntries,
  writeCanvasJsonAtomic,
} from './canvas-json.js';
import type { FrameFile } from './scan.js';

function frameFile(framePath: string, name = framePath): FrameFile {
  return { name, framePath, absPath: `/abs/${framePath}` };
}

describe('readCanvasJson / writeCanvasJsonAtomic', () => {
  let fileFolderRoot: string;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-canvas-json-'));
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  it('returns an empty, valid FrameMeta when canvas.json does not exist', async () => {
    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta).toEqual({ frames: [], comments: [], zoomBookmarks: [] });
  });

  it('round-trips a valid FrameMeta through an atomic write', async () => {
    const meta: FrameMeta = {
      frames: [{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 }],
      comments: [],
      zoomBookmarks: [],
    };

    await writeCanvasJsonAtomic(fileFolderRoot, meta);
    const read = await readCanvasJson(fileFolderRoot);

    expect(read).toEqual(meta);
  });

  it('leaves no leftover .tmp files after an atomic write', async () => {
    await writeCanvasJsonAtomic(fileFolderRoot, { frames: [], comments: [], zoomBookmarks: [] });

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(fileFolderRoot, '.studio'));

    expect(entries).toEqual(['canvas.json']);
  });

  it('rejects writing a FrameMeta that fails schema validation', async () => {
    const invalid = { frames: [], comments: [], zoomBookmarks: [], extra: true } as unknown as FrameMeta;
    await expect(writeCanvasJsonAtomic(fileFolderRoot, invalid)).rejects.toThrow();
  });

  it('throws (does not silently coerce) when the file on disk fails FrameMeta validation', async () => {
    await mkdir(join(fileFolderRoot, '.studio'), { recursive: true });
    await writeFile(
      join(fileFolderRoot, '.studio', 'canvas.json'),
      JSON.stringify({ frames: [{ framePath: 'x', x: 0 }], comments: [], zoomBookmarks: [] }),
    );

    await expect(readCanvasJson(fileFolderRoot)).rejects.toThrow(/FrameMeta validation/);
  });

  it('throws on malformed JSON rather than coercing', async () => {
    await mkdir(join(fileFolderRoot, '.studio'), { recursive: true });
    await writeFile(join(fileFolderRoot, '.studio', 'canvas.json'), '{not json');

    await expect(readCanvasJson(fileFolderRoot)).rejects.toThrow(/not valid JSON/);
  });

  it('preserves an Arabic comment text byte-exact through the round-trip (playbook §5.9)', async () => {
    const meta: FrameMeta = {
      frames: [],
      comments: [
        {
          id: 'c1',
          frameName: 'Pricing',
          x: 10,
          y: 20,
          text: 'خطط الأسعار — راجع هذا القسم',
          resolved: false,
          createdAt: '2026-07-13T00:00:00.000Z',
        },
      ],
      zoomBookmarks: [],
    };

    await writeCanvasJsonAtomic(fileFolderRoot, meta);
    const read = await readCanvasJson(fileFolderRoot);
    const raw = await readFile(join(fileFolderRoot, '.studio', 'canvas.json'), 'utf8');

    expect(read).toEqual(meta);
    expect(raw).toContain('خطط الأسعار — راجع هذا القسم');
  });
});

describe('syncFrameEntries', () => {
  it('adds a default-positioned entry for a newly discovered frame', () => {
    const meta: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };
    const result = syncFrameEntries(meta, [frameFile('src/frames/Hero.tsx', 'Hero')]);

    expect(result.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 }]);
  });

  it('cascades default positions for multiple newly discovered frames', () => {
    const meta: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };
    const result = syncFrameEntries(meta, [
      frameFile('src/frames/Hero.tsx', 'Hero'),
      frameFile('src/frames/Pricing.tsx', 'Pricing'),
    ]);

    expect(result.frames).toEqual([
      { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 },
      { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 },
    ]);
  });

  it('preserves an existing entry position for a frame that still exists on disk', () => {
    const meta: FrameMeta = {
      frames: [{ framePath: 'src/frames/Hero.tsx', x: 42, y: 99, w: 500, h: 400 }],
      comments: [],
      zoomBookmarks: [],
    };
    const result = syncFrameEntries(meta, [frameFile('src/frames/Hero.tsx', 'Hero')]);

    expect(result.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 42, y: 99, w: 500, h: 400 }]);
  });

  it('drops an entry whose frame file no longer exists on disk', () => {
    const meta: FrameMeta = {
      frames: [
        { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 },
        { framePath: 'src/frames/Deleted.tsx', x: 1600, y: 0, w: 1440, h: 900 },
      ],
      comments: [],
      zoomBookmarks: [],
    };
    const result = syncFrameEntries(meta, [frameFile('src/frames/Hero.tsx', 'Hero')]);

    expect(result.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 }]);
  });

  it('passes comments/zoomBookmarks through untouched', () => {
    const meta: FrameMeta = {
      frames: [],
      comments: [
        { id: 'c1', frameName: 'Hero', x: 1, y: 2, text: 'hi', resolved: false, createdAt: 'now' },
      ],
      zoomBookmarks: [{ id: 'z1', name: 'default', x: 0, y: 0, zoom: 1 }],
    };
    const result = syncFrameEntries(meta, []);

    expect(result.comments).toEqual(meta.comments);
    expect(result.zoomBookmarks).toEqual(meta.zoomBookmarks);
  });
});

describe('frameMetaEquals', () => {
  it('is true for structurally identical FrameMeta', () => {
    const a: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };
    const b: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };
    expect(frameMetaEquals(a, b)).toBe(true);
  });

  it('is false when frames differ', () => {
    const a: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };
    const b: FrameMeta = {
      frames: [{ framePath: 'x', x: 0, y: 0, w: 1, h: 1 }],
      comments: [],
      zoomBookmarks: [],
    };
    expect(frameMetaEquals(a, b)).toBe(false);
  });
});

describe('reconcileCanvasJson', () => {
  let fileFolderRoot: string;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-reconcile-'));
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  it('writes a fresh canvas.json when the file-folder has none yet', async () => {
    const reconciled = await reconcileCanvasJson(fileFolderRoot, [frameFile('src/frames/Hero.tsx', 'Hero')]);

    expect(reconciled.frames).toEqual([{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 }]);
    const read = await readCanvasJson(fileFolderRoot);
    expect(read).toEqual(reconciled);
  });

  it('does not rewrite the file when nothing changed', async () => {
    await reconcileCanvasJson(fileFolderRoot, [frameFile('src/frames/Hero.tsx', 'Hero')]);
    const { stat } = await import('node:fs/promises');
    const before = await stat(join(fileFolderRoot, '.studio', 'canvas.json'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await reconcileCanvasJson(fileFolderRoot, [frameFile('src/frames/Hero.tsx', 'Hero')]);
    const after = await stat(join(fileFolderRoot, '.studio', 'canvas.json'));

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
