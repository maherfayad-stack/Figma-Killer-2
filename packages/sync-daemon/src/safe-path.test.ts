import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveContainedPath } from './safe-path.js';

/**
 * AUDIT-6 BLOCKER regression coverage (playbook §5.8): the shared
 * containment helper that both `daemon.ts`'s `resolveFileFolderForOp` and
 * `op-apply.ts`'s `applyCanvasOpToDisk` call before any read/write derived
 * from a `CanvasOp`'s (attacker-controlled) uid relPath.
 */
describe('resolveContainedPath', () => {
  const root = '/tmp/ccs-safe-path-root';

  it('accepts a plain in-folder relPath and resolves it against the root', () => {
    const result = resolveContainedPath(root, 'src/frames/Hero.tsx');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absPath).toBe(join(root, 'src/frames/Hero.tsx'));
  });

  it('accepts a relPath whose internal .. segments cancel out and stay inside the root', () => {
    const result = resolveContainedPath(root, 'src/../src/frames/Hero.tsx');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absPath).toBe(join(root, 'src/frames/Hero.tsx'));
  });

  it('rejects the AUDIT-6 proven traversal shape (../../outside-victim/target.tsx)', () => {
    const result = resolveContainedPath(root, '../../outside-victim/target.tsx');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes the file-folder root/);
  });

  it('rejects a single-level .. that escapes the root', () => {
    const result = resolveContainedPath(root, '../sibling.tsx');
    expect(result.ok).toBe(false);
  });

  it('rejects an absolute POSIX relPath', () => {
    const result = resolveContainedPath(root, '/etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/absolute relPath is not allowed/);
  });

  it('rejects an empty relPath', () => {
    const result = resolveContainedPath(root, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty or malformed relPath/);
  });

  it('rejects a whitespace-only relPath', () => {
    expect(resolveContainedPath(root, '   ').ok).toBe(false);
  });

  it('rejects a relPath equal to the literal string ".." with nothing after it', () => {
    expect(resolveContainedPath(root, '..').ok).toBe(false);
  });
});

/**
 * AUDIT-6b BLOCKER regression coverage: the lexical check alone doesn't
 * follow symlinks, so a symlink segment that PRE-EXISTS inside a
 * file-folder root but points OUTSIDE it defeated the old
 * `startsWith(root + sep)` check — PROVEN LIVE (a crafted `set-text` op
 * addressed a path through such a symlink and rewrote a file outside the
 * root). These tests exercise the realpath-based containment layer
 * directly against a REAL filesystem (mkdtemp roots — which on macOS sit
 * behind their own symlink, `/tmp` -> `/private/tmp` — since the string
 * fixture (`root` above) can't exercise real symlink resolution).
 */
describe('resolveContainedPath — symlink-based containment (AUDIT-6b)', () => {
  let realRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    realRoot = await mkdtemp(join(tmpdir(), 'ccs-safe-path-symlink-'));
    await mkdir(join(realRoot, 'src', 'frames'), { recursive: true });
    await writeFile(join(realRoot, 'src', 'frames', 'Hero.tsx'), 'export default function Hero() { return null; }\n', 'utf8');
    outsideDir = await mkdtemp(join(tmpdir(), 'ccs-safe-path-outside-'));
    await writeFile(join(outsideDir, 'victim.tsx'), 'export default function Victim() { return null; }\n', 'utf8');
  });

  afterEach(async () => {
    await rm(realRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('accepts a real, existing in-root file even though the mkdtemp root itself is behind a symlink (macOS /tmp -> /private/tmp)', () => {
    const result = resolveContainedPath(realRoot, 'src/frames/Hero.tsx');
    expect(result.ok).toBe(true);
  });

  it('accepts a not-yet-existing target (file about to be created) inside a real root — ancestor-walk case', () => {
    const result = resolveContainedPath(realRoot, 'src/frames/NewFrame.tsx');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absPath).toBe(join(realRoot, 'src/frames/NewFrame.tsx'));
  });

  it('rejects a relPath addressed THROUGH a pre-existing symlink inside the root that points outside it', async () => {
    const symlinkPath = join(realRoot, 'src', 'frames', 'shortcut');
    await symlink(outsideDir, symlinkPath, 'dir');
    try {
      const result = resolveContainedPath(realRoot, 'src/frames/shortcut/victim.tsx');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/escapes the file-folder root via a symlink/);
    } finally {
      await rm(symlinkPath, { force: true });
    }
  });

  it('rejects (fail-closed) when the relPath itself is a broken symlink inside the root', async () => {
    const brokenLink = join(realRoot, 'src', 'frames', 'broken.tsx');
    await symlink(join(outsideDir, 'does-not-exist.tsx'), brokenLink, 'file');
    try {
      const result = resolveContainedPath(realRoot, 'src/frames/broken.tsx');
      expect(result.ok).toBe(false);
    } finally {
      await rm(brokenLink, { force: true });
    }
  });

  it('still rejects the plain lexical .. traversal against a real root (belt-and-suspenders with the lexical check)', () => {
    const result = resolveContainedPath(realRoot, '../outside-victim.tsx');
    expect(result.ok).toBe(false);
  });
});
