import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameMetaSchema } from '@ccs/protocol';
import { createFrameOnDisk } from './create-frame.js';
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

describe('createFrameOnDisk', () => {
  let fileFolderRoot: string;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-create-frame-'));
    await mkdir(join(fileFolderRoot, 'src', 'frames'), { recursive: true });
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  async function seedRegistry(): Promise<void> {
    await writeFile(join(fileFolderRoot, 'src', 'frames.ts'), FRAMES_REGISTRY_FIXTURE, 'utf8');
    await writeFile(
      join(fileFolderRoot, 'src', 'frames', 'Hero.tsx'),
      'export default function Hero() { return null; }\n',
      'utf8',
    );
  }

  it('writes the frame source, patches the registry, and appends a FrameMeta-valid canvas.json entry, atomically', async () => {
    await seedRegistry();

    const result = await createFrameOnDisk(fileFolderRoot, 'Testimonials');
    expect(result).toEqual({ framePath: 'src/frames/Testimonials.tsx' });

    const source = await readFile(join(fileFolderRoot, 'src', 'frames', 'Testimonials.tsx'), 'utf8');
    expect(source).toContain('export default function Testimonials()');

    const registry = await readFile(join(fileFolderRoot, 'src', 'frames.ts'), 'utf8');
    expect(registry).toContain("import Testimonials from './frames/Testimonials.js';");
    expect(registry).toContain('  Hero,\n  Testimonials,');

    const meta = await readCanvasJson(fileFolderRoot);
    expect(FrameMetaSchema.safeParse(meta).success).toBe(true);
    const entry = meta.frames.find((f) => f.framePath === 'src/frames/Testimonials.tsx');
    // canvas.json starts empty in this fixture (no pre-existing entries),
    // independent of src/frames.ts already having Hero registered — the
    // cascade is keyed off canvas.json's own frames[], not the registry.
    expect(entry).toEqual({ framePath: 'src/frames/Testimonials.tsx', x: 0, y: 0, w: 1440, h: 900 });
  });

  it('all three artifacts land together: registry + canvas.json agree on the new frame after the call', async () => {
    await seedRegistry();
    await createFrameOnDisk(fileFolderRoot, 'Alpha');

    const registry = await readFile(join(fileFolderRoot, 'src', 'frames.ts'), 'utf8');
    const meta = await readCanvasJson(fileFolderRoot);
    expect(registry).toContain('Alpha');
    expect(meta.frames.some((f) => f.framePath === 'src/frames/Alpha.tsx')).toBe(true);
  });

  it('rejects an invalid (non-PascalCase) name without writing anything', async () => {
    await seedRegistry();
    await expect(createFrameOnDisk(fileFolderRoot, 'not-pascal')).rejects.toThrow(/invalid frame name/);

    const meta = await readCanvasJson(fileFolderRoot);
    expect(meta.frames).toHaveLength(0);
  });

  it('rejects a path-traversal name without escaping src/frames/', async () => {
    await seedRegistry();
    await expect(createFrameOnDisk(fileFolderRoot, '../../etc/passwd')).rejects.toThrow(/invalid frame name/);
    await expect(createFrameOnDisk(fileFolderRoot, '../Escape')).rejects.toThrow(/invalid frame name/);

    // nothing escaped the file-folder root
    await expect(readFile(join(fileFolderRoot, '..', 'etc', 'passwd'), 'utf8')).rejects.toThrow();
  });

  it('rejects a duplicate frame name already registered in src/frames.ts', async () => {
    await seedRegistry();
    await createFrameOnDisk(fileFolderRoot, 'Testimonials');
    await expect(createFrameOnDisk(fileFolderRoot, 'Testimonials')).rejects.toThrow(/already/);
  });

  it('rejects a name whose source file already exists on disk even if not yet registered', async () => {
    await seedRegistry();
    await writeFile(join(fileFolderRoot, 'src', 'frames', 'Orphan.tsx'), 'export default function Orphan() { return null; }\n', 'utf8');

    await expect(createFrameOnDisk(fileFolderRoot, 'Orphan')).rejects.toThrow(/already exists/);
  });

  it('cascades geometry past whatever canvas.json already has, even if the registry disagrees', async () => {
    await seedRegistry();
    const existing = await readCanvasJson(fileFolderRoot);
    await writeCanvasJsonAtomic(fileFolderRoot, {
      ...existing,
      frames: [
        { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 },
        { framePath: 'src/frames/Ghost.tsx', x: 1600, y: 0, w: 1440, h: 900 },
      ],
    });

    const result = await createFrameOnDisk(fileFolderRoot, 'Beta');
    const meta = await readCanvasJson(fileFolderRoot);
    const entry = meta.frames.find((f) => f.framePath === result.framePath);
    expect(entry).toEqual({ framePath: 'src/frames/Beta.tsx', x: 3200, y: 0, w: 1440, h: 900 });
  });
});
