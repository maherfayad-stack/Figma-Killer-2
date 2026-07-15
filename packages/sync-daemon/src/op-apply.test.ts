import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanvasOp, NodeUid } from '@ccs/protocol';
import { applyCanvasOpToDisk, applyForwardOpToDisk, applyInverseOpToDisk, relPathFromCanvasOp, summarizeCanvasOp } from './op-apply.js';
import { SelfWriteTracker } from './self-write-tracker.js';

const REL = 'src/frames/Hero.tsx';
const SOURCE = `export default function Hero() {
  return (
    <div>
      <h1>Title</h1>
      {[1, 2].map((i) => (
        <span key={i}>{i}</span>
      ))}
    </div>
  );
}
`;

function uid(astPath: string): NodeUid {
  return `${REL}:${astPath}` as NodeUid;
}

describe('applyCanvasOpToDisk', () => {
  let fileFolderRoot: string;
  let absFile: string;
  let tracker: SelfWriteTracker;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-opapply-'));
    absFile = join(fileFolderRoot, REL);
    await mkdir(join(fileFolderRoot, 'src', 'frames'), { recursive: true });
    await writeFile(absFile, SOURCE, 'utf8');
    tracker = new SelfWriteTracker();
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  it('applies a set-text op, writes the file, and returns the pre-image inverse', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.0'), text: 'Updated' };
    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newText).toContain('Updated');
    expect(result.extra.inverseOp).toEqual({ t: 'set-text', uid: uid('d0.0'), text: 'Title' });

    const onDisk = await readFile(absFile, 'utf8');
    expect(onDisk).toBe(result.newText);
  });

  it('marks the self-write tracker right before writing', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.0'), text: 'Updated' };
    expect(tracker.consume(absFile)).toBe(false);
    await applyCanvasOpToDisk(fileFolderRoot, op, tracker);
    expect(tracker.consume(absFile)).toBe(true);
  });

  it('rejects an op targeting a dynamic (data-dynamic) node with "dynamic-locked" and leaves the file untouched', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.1'), text: 'nope' };
    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^dynamic-locked:/);

    const onDisk = await readFile(absFile, 'utf8');
    expect(onDisk).toBe(SOURCE);
    expect(tracker.consume(absFile)).toBe(false); // never marked — nothing was written
  });

  it('rejects an op whose uid does not resolve with "uid-not-found" and leaves the file untouched', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d99.zzz'), text: 'nope' };
    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^uid-not-found:/);
    expect(await readFile(absFile, 'utf8')).toBe(SOURCE);
  });

  it('concurrent-edit guard: re-applies against a fresh read when the file changed once during the op, and still succeeds', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.0'), text: 'Updated' };
    let calls = 0;
    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker, async () => {
      calls++;
      if (calls === 1) {
        // Simulate an external (IDE) edit landing between snapshot and
        // write — an unrelated but syntactically valid change elsewhere
        // in the file so the SECOND attempt's re-read + re-apply still
        // resolves the same uid.
        await writeFile(absFile, SOURCE.replace('Title', 'Title-external-edit'), 'utf8');
      }
    });

    expect(calls).toBe(2); // first attempt detected the mismatch, retried once
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The retry re-read the EXTERNAL edit and applied set-text on top of
    // it — never silently discarding the external change.
    expect(result.newText).toContain('Updated');
  });

  it('concurrent-edit guard: rejects with "file changed, retry" (never clobbering) when the file keeps changing', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.0'), text: 'Updated' };
    let calls = 0;
    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker, async () => {
      calls++;
      await writeFile(absFile, SOURCE.replace('Title', `Title-external-edit-${calls}`), 'utf8');
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('file changed, retry');

    // The daemon must NEVER clobber the external edit — the last external
    // write (from the second attempt's onAfterCompute) must survive.
    const onDisk = await readFile(absFile, 'utf8');
    expect(onDisk).toContain('Title-external-edit-2');
    expect(tracker.consume(absFile)).toBe(false); // no write ever happened
  });
});

describe('applyInverseOpToDisk / applyForwardOpToDisk (undo/redo primitives)', () => {
  let fileFolderRoot: string;
  let absFile: string;
  let tracker: SelfWriteTracker;

  beforeEach(async () => {
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-opapply-undo-'));
    absFile = join(fileFolderRoot, REL);
    await mkdir(join(fileFolderRoot, 'src', 'frames'), { recursive: true });
    await writeFile(absFile, SOURCE, 'utf8');
    tracker = new SelfWriteTracker();
  });

  afterEach(async () => {
    await rm(fileFolderRoot, { recursive: true, force: true });
  });

  it('undo (applyInverseOpToDisk) then redo (applyForwardOpToDisk) round-trips byte-identically', async () => {
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.0'), text: 'Updated' };
    const applied = await applyCanvasOpToDisk(fileFolderRoot, op, tracker);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const postImage = applied.newText;

    const undone = await applyInverseOpToDisk(absFile, applied.extra.inverseOp, tracker);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.newText).toBe(SOURCE); // byte-identical to the pre-image

    const redone = await applyForwardOpToDisk(absFile, op, tracker);
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.newText).toBe(postImage); // byte-identical to the original post-image
  });
});

describe('applyCanvasOpToDisk — symlink-mediated sandbox escape (AUDIT-6b)', () => {
  let fileFolderRoot: string;
  let outsideDir: string;
  let outsideFile: string;
  let symlinkPath: string;
  let tracker: SelfWriteTracker;

  const VICTIM_SOURCE = `export default function Victim() {
  return (
    <div>
      <h1>Untouched</h1>
    </div>
  );
}
`;

  beforeEach(async () => {
    // fileFolderRoot mirrors every other suite here: a REAL mkdtemp root,
    // which on macOS sits under /var/folders/... -> a symlink chain from
    // /tmp -> /private/tmp (or /var -> /private/var). This is deliberate:
    // it's the same shape that must NOT false-reject (root itself is
    // "behind a symlink") while a symlink segment INSIDE the root that
    // points OUTSIDE it must still be rejected.
    fileFolderRoot = await mkdtemp(join(tmpdir(), 'ccs-opapply-symlink-'));
    await mkdir(join(fileFolderRoot, 'src', 'frames'), { recursive: true });
    await writeFile(join(fileFolderRoot, 'src', 'frames', 'Hero.tsx'), SOURCE, 'utf8');

    // A directory OUTSIDE the file-folder root, holding the "victim" file
    // the attack targets — analogous to AUDIT-6b's live probe.
    outsideDir = await mkdtemp(join(tmpdir(), 'ccs-opapply-outside-'));
    outsideFile = join(outsideDir, 'victim.tsx');
    await writeFile(outsideFile, VICTIM_SOURCE, 'utf8');

    // Symlink segment that PRE-EXISTS inside the root and points outside
    // it — `src/frames/shortcut` -> outsideDir. No op creates this; it's
    // the attacker addressing a pre-existing symlink (pnpm-project-shaped
    // reachability per AUDIT-6b), which is exactly what's being tested.
    symlinkPath = join(fileFolderRoot, 'src', 'frames', 'shortcut');
    await symlink(outsideDir, symlinkPath, 'dir');

    tracker = new SelfWriteTracker();
  });

  afterEach(async () => {
    // Clean up the symlink FIRST (rm on a directory tree does not follow
    // symlinks into their targets, but be explicit and defensive — a
    // leaked symlink pointing outside the repo is itself a hazard) then
    // both temp roots.
    await rm(symlinkPath, { force: true });
    await rm(fileFolderRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('rejects a set-text op whose relPath is addressed THROUGH the symlink, and leaves the outside file unchanged', async () => {
    const relPath = 'src/frames/shortcut/victim.tsx';
    const op: CanvasOp = { t: 'set-text', uid: `${relPath}:d0.0` as NodeUid, text: 'PWNED' };

    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/escapes the file-folder root via a symlink/);

    const onDisk = await readFile(outsideFile, 'utf8');
    expect(onDisk).toBe(VICTIM_SOURCE); // untouched — the escape did NOT happen
    expect(tracker.consume(outsideFile)).toBe(false); // no write was ever marked
  });

  it('still allows a legit real frame file under the same (mkdtemp, symlink-behind) root', async () => {
    // Guards against a false-reject: the root itself lives behind a
    // symlink (macOS /tmp -> /private/tmp), so a naive "realpath the
    // target only" implementation would wrongly reject every real file
    // here too. Both sides must be realpath'd for this to pass.
    const op: CanvasOp = { t: 'set-text', uid: uid('d0.0'), text: 'Updated' };
    const absFile = join(fileFolderRoot, REL);

    const result = await applyCanvasOpToDisk(fileFolderRoot, op, tracker);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newText).toContain('Updated');
    expect(await readFile(absFile, 'utf8')).toBe(result.newText);
  });
});

describe('relPathFromCanvasOp / summarizeCanvasOp', () => {
  it('extracts the file-folder-relative path from every op shape', () => {
    expect(relPathFromCanvasOp({ t: 'set-text', uid: uid('d0'), text: 'x' })).toBe(REL);
    expect(relPathFromCanvasOp({ t: 'insert-node', parentUid: uid('d0'), index: 0, source: { kind: 'element', tag: 'div' } })).toBe(REL);
    expect(relPathFromCanvasOp({ t: 'wrap-node', uids: [uid('d0.0')], wrapper: { tag: 'div', classes: 'flex' } })).toBe(REL);
  });

  it('produces a non-empty human-readable summary for every op kind', () => {
    const ops: CanvasOp[] = [
      { t: 'set-text', uid: uid('d0'), text: 'x' },
      { t: 'set-prop', uid: uid('d0'), name: 'title', value: 'x' },
      { t: 'set-classes', uid: uid('d0'), add: ['flex'], remove: [] },
      { t: 'insert-node', parentUid: uid('d0'), index: 0, source: { kind: 'element', tag: 'div' } },
      { t: 'delete-node', uid: uid('d0.0') },
      { t: 'move-node', uid: uid('d0.0'), newParentUid: uid('d0'), index: 0 },
      { t: 'wrap-node', uids: [uid('d0.0')], wrapper: { tag: 'div', classes: 'flex' } },
    ];
    for (const op of ops) {
      expect(summarizeCanvasOp(op).length).toBeGreaterThan(0);
    }
  });
});
