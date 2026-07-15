import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { ApplyOpError, applyInverseOp, applyOp, invertOp, type InverseOp } from '@ccs/ast-engine';
import type { CanvasOp } from '@ccs/protocol';
import { hashContent } from './content-hash.js';
import { resolveContainedPath } from './safe-path.js';
import type { SelfWriteTracker } from './self-write-tracker.js';

/**
 * The P3 write-through path (playbook §4/P3, ADR-0018 items 1/9/10):
 * read → applyOp (ast-engine, pure/sync) → concurrent-edit guard →
 * atomic write. This module is the ONLY place in the daemon that calls
 * into `@ccs/ast-engine`, so the concurrency/atomicity discipline lives
 * in one spot shared by canvas-op apply, undo, and redo.
 */

const MAX_CONCURRENT_EDIT_RETRIES = 1;

export interface WriteThroughSuccess<TExtra> {
  ok: true;
  newText: string;
  extra: TExtra;
}
export interface WriteThroughFailure {
  ok: false;
  reason: string;
}
export type WriteThroughResult<TExtra> = WriteThroughSuccess<TExtra> | WriteThroughFailure;

async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = dirname(absPath);
  const tmp = join(
    dir,
    `.${basename(absPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, absPath);
}

/**
 * Shared read → compute → concurrent-edit-guard → atomic-write skeleton.
 * `compute` is a PURE function of the currently-on-disk source text (it
 * may itself throw `ApplyOpError`, which is propagated as a rejection
 * rather than a thrown exception here so callers never need a try/catch
 * around every call site).
 *
 * Concurrent-IDE-edit guard (playbook §4/P3 pitfall #3, ADR-0018 item
 * 10): snapshots the file's hash right after reading, then re-reads and
 * re-hashes immediately before writing. If they differ, some other
 * process (the user's IDE, git, etc.) touched the file while this op was
 * being computed — the daemon re-reads and re-computes ONCE against the
 * fresh content; if it STILL doesn't match on the retry (another writer
 * is actively racing), it gives up and rejects with "file changed, retry"
 * rather than risk clobbering an external edit. Called from inside the
 * per-file `FileOpQueue` task, so the only possible racer is external to
 * the daemon (queue serialization already rules out two daemon-issued
 * ops racing each other on the same file).
 */
export async function writeThroughGuarded<TExtra>(
  absPath: string,
  selfWriteTracker: SelfWriteTracker,
  compute: (sourceText: string) => { newText: string; extra: TExtra },
  /** TEST-ONLY seam: awaited right after `compute` finishes and before the
   * pre-write re-read, so tests can deterministically simulate an
   * external write landing in that exact window (real callers never pass
   * this — production races are timing-dependent, not injectable). */
  onAfterCompute?: () => Promise<void>,
): Promise<WriteThroughResult<TExtra>> {
  for (let attempt = 0; attempt <= MAX_CONCURRENT_EDIT_RETRIES; attempt++) {
    let sourceText: string;
    try {
      sourceText = await readFile(absPath, 'utf8');
    } catch (err) {
      return { ok: false, reason: `cannot read "${absPath}": ${(err as Error).message}` };
    }
    const hashBefore = hashContent(sourceText);

    let computed: { newText: string; extra: TExtra };
    try {
      computed = compute(sourceText);
    } catch (err) {
      if (err instanceof ApplyOpError) return { ok: false, reason: `${err.code}: ${err.message}` };
      throw err;
    }

    if (onAfterCompute) await onAfterCompute();

    let currentOnDisk: string;
    try {
      currentOnDisk = await readFile(absPath, 'utf8');
    } catch (err) {
      return { ok: false, reason: `cannot read "${absPath}": ${(err as Error).message}` };
    }
    if (hashContent(currentOnDisk) !== hashBefore) {
      if (attempt < MAX_CONCURRENT_EDIT_RETRIES) continue; // re-read + re-apply against the fresh content
      return { ok: false, reason: 'file changed, retry' };
    }

    selfWriteTracker.markWritten(absPath); // mark BEFORE writing, right at the point of truth
    await atomicWriteFile(absPath, computed.newText);
    return { ok: true, newText: computed.newText, extra: computed.extra };
  }
  return { ok: false, reason: 'file changed, retry' };
}

// ---- canvas-op forward apply ---------------------------------------------

export function relPathFromCanvasOp(op: CanvasOp): string {
  let uid: string;
  switch (op.t) {
    case 'set-text':
    case 'set-prop':
    case 'set-classes':
    case 'delete-node':
    case 'move-node':
      uid = op.uid;
      break;
    case 'insert-node':
      uid = op.parentUid;
      break;
    case 'wrap-node':
      uid = op.uids[0]!;
      break;
  }
  const idx = uid.indexOf('.tsx:');
  return idx === -1 ? uid : uid.slice(0, idx + 4);
}

export interface ApplyCanvasOpExtra {
  uidRemap: Record<string, string>;
  inverseOp: InverseOp;
}

/**
 * Applies one `CanvasOp` to the file it targets (resolved by the caller
 * to `fileFolderRoot` + the op's NodeUid relPath). Computes the inverse
 * against the pre-image (ADR-0018 item 9) — both `applyOp`/`invertOp` are
 * pure parses of the SAME immutable `sourceText`, so which one runs first
 * cannot change either result. Order is still deliberate: `applyOp` runs
 * FIRST so an op that `applyOp` itself would refuse (e.g. `dynamic-locked`
 * — the §0 contract's own gate) surfaces THAT reason to the caller/UI,
 * rather than a possibly-less-informative failure from `invertOp` on the
 * same node (e.g. "original body is not plain text" — true, but not the
 * real reason the op is rejected). `invertOp` only runs once `applyOp`
 * has already proven the op is acceptable.
 */
export async function applyCanvasOpToDisk(
  fileFolderRoot: string,
  op: CanvasOp,
  selfWriteTracker: SelfWriteTracker,
  /** TEST-ONLY seam, forwarded to `writeThroughGuarded` — see its doc. */
  onAfterCompute?: () => Promise<void>,
): Promise<WriteThroughResult<ApplyCanvasOpExtra> & { absFilePath: string; relPath: string }> {
  const relPath = relPathFromCanvasOp(op);
  // AUDIT-6 BLOCKER fix (playbook §5.8): this is the actual fs-write
  // boundary, so it re-validates containment via the shared
  // `resolveContainedPath` (`safe-path.ts`) itself rather than trusting
  // that the caller (`daemon.ts`'s `resolveFileFolderForOp`) already did —
  // defense in depth for any future/test call site that reaches this
  // function directly. A `..`-traversal or absolute relPath is rejected
  // HERE, before `writeThroughGuarded` ever reads or writes anything.
  const safe = resolveContainedPath(fileFolderRoot, relPath);
  if (!safe.ok) {
    return { ok: false, reason: `invalid path: ${safe.reason}`, absFilePath: fileFolderRoot, relPath };
  }
  const absFilePath = safe.absPath;

  const result = await writeThroughGuarded(
    absFilePath,
    selfWriteTracker,
    (sourceText) => {
      const applied = applyOp(sourceText, op);
      const inverseOp = invertOp(sourceText, op);
      return { newText: applied.newText, extra: { uidRemap: applied.uidRemap, inverseOp } };
    },
    onAfterCompute,
  );

  return { ...result, absFilePath, relPath };
}

// ---- undo / redo apply ----------------------------------------------------

export interface ApplyInverseExtra {
  uidRemap: Record<string, string>;
}

/** Applies a previously-computed `InverseOp` (the daemon's undo path). */
export async function applyInverseOpToDisk(
  absFilePath: string,
  inverseOp: InverseOp,
  selfWriteTracker: SelfWriteTracker,
): Promise<WriteThroughResult<ApplyInverseExtra>> {
  return writeThroughGuarded(absFilePath, selfWriteTracker, (sourceText) => {
    const applied = applyInverseOp(sourceText, inverseOp);
    return { newText: applied.newText, extra: { uidRemap: applied.uidRemap } };
  });
}

/** Re-applies the original forward op (the daemon's redo path). */
export async function applyForwardOpToDisk(
  absFilePath: string,
  forwardOp: CanvasOp,
  selfWriteTracker: SelfWriteTracker,
): Promise<WriteThroughResult<ApplyInverseExtra>> {
  return writeThroughGuarded(absFilePath, selfWriteTracker, (sourceText) => {
    const applied = applyOp(sourceText, forwardOp);
    return { newText: applied.newText, extra: { uidRemap: applied.uidRemap } };
  });
}

/** Human-readable one-line summary for git checkpoint commit messages. */
export function summarizeCanvasOp(op: CanvasOp): string {
  switch (op.t) {
    case 'set-text':
      return `set-text ${op.uid}`;
    case 'set-prop':
      return `set-prop ${op.name} on ${op.uid}`;
    case 'set-classes':
      return `set-classes ${op.uid}`;
    case 'insert-node':
      return `insert-node into ${op.parentUid}`;
    case 'delete-node':
      return `delete-node ${op.uid}`;
    case 'move-node':
      return `move-node ${op.uid}`;
    case 'wrap-node':
      return `wrap-node ${op.uids.join(',')}`;
  }
}
