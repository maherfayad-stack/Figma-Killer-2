import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameMetaSchema } from '@ccs/protocol';
import { duplicateFrameOnDisk } from './duplicate-frame.js';
import { readCanvasJson, writeCanvasJsonAtomic } from './canvas-json.js';

const FRAMES_REGISTRY_FIXTURE = `import type { ComponentType } from 'react';
import Hero from './frames/Hero.js';

export const frames: Record<string, ComponentType> = {
  Hero,
};

export function getFrame(name: string | null): ComponentType | null {
  if (!name) return null;
  return frames[name] ?? null;
}
`;

const HERO_SOURCE = `export default function Hero() {
  return (
    <section className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Hero</h1>
    </section>
  );
}
`;

describe('duplicateFrameOnDisk', () => {
  let fileFolderRoot: string;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-duplicate-frame-'));
    await mkdir(join(fileFolderRoot, 'src', 'frames'), { recursive: true });
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  async function seedRegistry(): Promise<void> {
    await writeFile(join(fileFolderRoot, 'src', 'frames.ts'), FRAMES_REGISTRY_FIXTURE, 'utf8');
    await writeFile(join(fileFolderRoot, 'src', 'frames', 'Hero.tsx'), HERO_SOURCE, 'utf8');
  }

  it('copies the source content byte-for-byte into a uniquely-named frame', async () => {
    await seedRegistry();
    await writeCanvasJsonAtomic(fileFolderRoot, {
      frames: [{ framePath: 'src/frames/Hero.tsx', x: 100, y: 50, w: 1440, h: 900 }],
      comments: [],
      zoomBookmarks: [],
    });

    const result = await duplicateFrameOnDisk(fileFolderRoot, 'Hero');
    expect(result).toEqual({ newName: 'HeroCopy', framePath: 'src/frames/HeroCopy.tsx' });

    const copiedSource = await readFile(join(fileFolderRoot, 'src', 'frames', 'HeroCopy.tsx'), 'utf8');
    expect(copiedSource).toBe(HERO_SOURCE); // pure content copy — see module doc

    const registry = await readFile(join(fileFolderRoot, 'src', 'frames.ts'), 'utf8');
    expect(registry).toContain("import HeroCopy from './frames/HeroCopy.js';");
    expect(registry).toContain('  Hero,\n  HeroCopy,');
  });

  it('appends a canvas.json entry offset +40/+40 from the source, same w/h', async () => {
    await seedRegistry();
    await writeCanvasJsonAtomic(fileFolderRoot, {
      frames: [{ framePath: 'src/frames/Hero.tsx', x: 100, y: 50, w: 1440, h: 900 }],
      comments: [],
      zoomBookmarks: [],
    });

    await duplicateFrameOnDisk(fileFolderRoot, 'Hero');

    const meta = await readCanvasJson(fileFolderRoot);
    expect(FrameMetaSchema.safeParse(meta).success).toBe(true);
    const entry = meta.frames.find((f) => f.framePath === 'src/frames/HeroCopy.tsx');
    expect(entry).toEqual({ framePath: 'src/frames/HeroCopy.tsx', x: 140, y: 90, w: 1440, h: 900 });
    // the source entry itself is untouched
    expect(meta.frames.find((f) => f.framePath === 'src/frames/Hero.tsx')).toEqual({
      framePath: 'src/frames/Hero.tsx',
      x: 100,
      y: 50,
      w: 1440,
      h: 900,
    });
  });

  it('falls back to a default-offset entry when the source has no canvas.json geometry yet', async () => {
    await seedRegistry(); // canvas.json starts empty (no writeCanvasJsonAtomic call)
    const result = await duplicateFrameOnDisk(fileFolderRoot, 'Hero');
    const meta = await readCanvasJson(fileFolderRoot);
    const entry = meta.frames.find((f) => f.framePath === result.framePath);
    expect(entry).toEqual({ framePath: 'src/frames/HeroCopy.tsx', x: 40, y: 40, w: 1440, h: 900 });
  });

  it('never collides: HeroCopy, then HeroCopy2, then HeroCopy3, ...', async () => {
    await seedRegistry(); // canvas.json starts empty — Hero itself has no entry yet
    const first = await duplicateFrameOnDisk(fileFolderRoot, 'Hero');
    const second = await duplicateFrameOnDisk(fileFolderRoot, 'Hero');
    const third = await duplicateFrameOnDisk(fileFolderRoot, 'Hero');
    expect(first.newName).toBe('HeroCopy');
    expect(second.newName).toBe('HeroCopy2');
    expect(third.newName).toBe('HeroCopy3');

    const meta = await readCanvasJson(fileFolderRoot);
    const names = meta.frames.map((f) => f.framePath).sort();
    expect(names).toEqual(
      ['src/frames/HeroCopy.tsx', 'src/frames/HeroCopy2.tsx', 'src/frames/HeroCopy3.tsx'].sort(),
    );
  });

  it('honors an explicit, available requestedNewName instead of auto-picking one', async () => {
    await seedRegistry();
    const result = await duplicateFrameOnDisk(fileFolderRoot, 'Hero', 'HeroAlt');
    expect(result).toEqual({ newName: 'HeroAlt', framePath: 'src/frames/HeroAlt.tsx' });
    const copiedSource = await readFile(join(fileFolderRoot, 'src', 'frames', 'HeroAlt.tsx'), 'utf8');
    expect(copiedSource).toBe(HERO_SOURCE);
  });

  it('rejects an explicit requestedNewName that already exists on disk', async () => {
    await seedRegistry();
    await writeFile(join(fileFolderRoot, 'src', 'frames', 'Taken.tsx'), 'export default function Taken() { return null; }\n', 'utf8');
    await expect(duplicateFrameOnDisk(fileFolderRoot, 'Hero', 'Taken')).rejects.toThrow(/already exists/);
  });

  it('rejects an unknown source frame (no .tsx on disk) without writing anything', async () => {
    await seedRegistry();
    await expect(duplicateFrameOnDisk(fileFolderRoot, 'Ghost')).rejects.toThrow(/unknown source frame/);
    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta.frames).toHaveLength(0);
  });

  it('rejects a non-PascalCase source name', async () => {
    await seedRegistry();
    await expect(duplicateFrameOnDisk(fileFolderRoot, 'not-pascal')).rejects.toThrow(/invalid source frame name/);
  });

  it('rejects a path-traversal source name without escaping src/frames/', async () => {
    await seedRegistry();
    await expect(duplicateFrameOnDisk(fileFolderRoot, '../../etc/passwd')).rejects.toThrow(/invalid source frame name/);
    await expect(duplicateFrameOnDisk(fileFolderRoot, '../Escape')).rejects.toThrow(/invalid source frame name/);
  });

  it('rejects a path-traversal requestedNewName', async () => {
    await seedRegistry();
    await expect(duplicateFrameOnDisk(fileFolderRoot, 'Hero', '../Escape')).rejects.toThrow(/invalid new frame name/);
  });

  it('rejects (via patchFramesRegistry) a name already registered even if its file is missing', async () => {
    await seedRegistry();
    // register a name in src/frames.ts without ever writing its .tsx —
    // simulates a registry/disk inconsistency the "refuse rather than
    // guess" discipline must still catch even though pickUniqueName only
    // checks disk existence.
    const registry = await readFile(join(fileFolderRoot, 'src', 'frames.ts'), 'utf8');
    const withGhost = registry
      .replace("import Hero from './frames/Hero.js';", "import Hero from './frames/Hero.js';\nimport HeroCopy from './frames/HeroCopy.js';")
      .replace('  Hero,\n', '  Hero,\n  HeroCopy,\n');
    await writeFile(join(fileFolderRoot, 'src', 'frames.ts'), withGhost, 'utf8');

    await expect(duplicateFrameOnDisk(fileFolderRoot, 'Hero', 'HeroCopy')).rejects.toThrow(/already registered/);
  });

  it('all three artifacts land together and atomically: registry + canvas.json + source file agree', async () => {
    await seedRegistry();
    await duplicateFrameOnDisk(fileFolderRoot, 'Hero');

    const registry = await readFile(join(fileFolderRoot, 'src', 'frames.ts'), 'utf8');
    const meta = await readCanvasJson(fileFolderRoot);
    expect(registry).toContain('HeroCopy');
    expect(meta.frames.some((f) => f.framePath === 'src/frames/HeroCopy.tsx')).toBe(true);
    const source = await readFile(join(fileFolderRoot, 'src', 'frames', 'HeroCopy.tsx'), 'utf8');
    expect(source).toBe(HERO_SOURCE);
  });
});
