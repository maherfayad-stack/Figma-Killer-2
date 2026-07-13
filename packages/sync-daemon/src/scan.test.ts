import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProject } from './scan.js';

describe('scanProject', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ccs-scan-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function makeFileFolder(name: string, frameFiles: string[]): Promise<void> {
    const framesDir = join(projectRoot, 'files', name, 'src', 'frames');
    await mkdir(framesDir, { recursive: true });
    for (const frameFile of frameFiles) {
      await writeFile(join(framesDir, frameFile), 'export default function X() { return null; }\n');
    }
  }

  it('returns an empty array when there is no files/ directory yet', async () => {
    expect(await scanProject(projectRoot)).toEqual([]);
  });

  it('finds every .tsx frame under files/*/src/frames/', async () => {
    await makeFileFolder('demo', ['Hero.tsx', 'Pricing.tsx']);

    const result = await scanProject(projectRoot);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('demo');
    expect(result[0]?.frames.map((f) => f.name)).toEqual(['Hero', 'Pricing']);
    expect(result[0]?.frames.map((f) => f.framePath)).toEqual([
      'src/frames/Hero.tsx',
      'src/frames/Pricing.tsx',
    ]);
  });

  it('handles multiple file-folders, sorted deterministically by name', async () => {
    await makeFileFolder('zeta', ['A.tsx']);
    await makeFileFolder('alpha', ['B.tsx']);

    const result = await scanProject(projectRoot);

    expect(result.map((f) => f.name)).toEqual(['alpha', 'zeta']);
  });

  it('returns a file-folder with an empty frames array when src/frames/ has no .tsx files', async () => {
    await mkdir(join(projectRoot, 'files', 'empty', 'src', 'frames'), { recursive: true });

    const result = await scanProject(projectRoot);

    expect(result).toHaveLength(1);
    expect(result[0]?.frames).toEqual([]);
  });

  it('ignores non-.tsx files and dotfiles under files/', async () => {
    await makeFileFolder('demo', ['Hero.tsx']);
    await writeFile(join(projectRoot, 'files', 'demo', 'src', 'frames', 'notes.md'), 'x');
    await writeFile(join(projectRoot, 'files', '.last-file'), 'demo');

    const result = await scanProject(projectRoot);

    expect(result).toHaveLength(1);
    expect(result[0]?.frames.map((f) => f.name)).toEqual(['Hero']);
  });

  it('handles Arabic-named frame files byte-exact (playbook §5.9)', async () => {
    await makeFileFolder('demo', ['الأسعار.tsx']);

    const result = await scanProject(projectRoot);

    expect(result[0]?.frames.map((f) => f.name)).toEqual(['الأسعار']);
    expect(result[0]?.frames.map((f) => f.framePath)).toEqual(['src/frames/الأسعار.tsx']);
  });
});
