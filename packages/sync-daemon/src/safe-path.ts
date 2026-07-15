import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * safe-path.ts — the single shared fs-write-boundary containment check
 * (AUDIT-6 BLOCKER fix, playbook §5.8; AUDIT-6b BLOCKER fix, symlink
 * containment). `NodeUid`'s relPath half (`packages/protocol/src/uid.ts`,
 * FROZEN) is attacker-controlled: it arrives over the control-ws inside a
 * `CanvasOp` sent by whatever client is connected, and nothing upstream
 * validates that it stays inside the targeted file-folder's root before
 * being joined into an absolute filesystem path. A relPath containing
 * `..` segments (e.g. `../../outside-victim/target.tsx`) or an absolute
 * path (`/etc/passwd`) can otherwise escape the sandbox entirely —
 * PROVEN LIVE by AUDIT-6 (a crafted `set-text` op wrote outside the
 * file-folder root).
 *
 * AUDIT-6b found that the lexical check alone is insufficient: `path.resolve`
 * does NOT follow symlinks, so a symlink segment that pre-exists INSIDE the
 * file-folder root but points OUTSIDE it defeats the `startsWith(root+sep)`
 * check — the real fs read/write then follows the link and escapes the
 * sandbox. PROVEN LIVE: a symlink `src/frames/shortcut` -> an outside dir,
 * addressed by a crafted uid, rewrote a file outside the root. This is
 * reachable in practice (not exotic) because pnpm projects are
 * symlink-heavy (`node_modules/.pnpm`) and the e2e fixture itself symlinks
 * node_modules into the served root — an attacker only needs to ADDRESS a
 * pre-existing symlink, not create one. The fix below adds a realpath-based
 * containment check ON TOP of the lexical check: the REAL (symlink-resolved)
 * target path must stay within the REAL (symlink-resolved) root.
 *
 * This is the ONE place that decides whether a relPath is safe to resolve
 * against a file-folder root; every call site that turns a `CanvasOp`'s
 * uid into a real filesystem path — `daemon.ts`'s `resolveFileFolderForOp`
 * (both the explicit-`fileFolder` branch and the disk-search fallback) and
 * `op-apply.ts`'s `applyCanvasOpToDisk` (the actual read/write boundary) —
 * MUST call this before touching disk. Do not reimplement this check
 * inline elsewhere.
 */

export interface SafePathOk {
  ok: true;
  absPath: string;
}
export interface SafePathRejected {
  ok: false;
  reason: string;
}
export type SafePathResult = SafePathOk | SafePathRejected;

/**
 * Resolves `target` to its REAL (symlink-free) form.
 *
 * Uses `lstatSync` (which does NOT follow the final symlink) rather than
 * `existsSync` (which follows symlinks and swallows EVERY error, including
 * permission errors, as "doesn't exist") to tell apart two very different
 * situations:
 *
 *  - A dirent genuinely does NOT exist at `target` at all (`lstatSync`
 *    throws ENOENT) — the common case for a file about to be CREATED.
 *    Walk UP to the nearest EXISTING ancestor directory, realpath THAT,
 *    and rejoin the non-existent tail segments lexically (they can't
 *    themselves contain symlinks, because they don't exist yet). This
 *    still correctly resolves any symlink earlier in the chain.
 *
 *  - A dirent DOES exist at `target` (`lstatSync` succeeds — it may be a
 *    real file/dir, or a symlink, possibly a BROKEN one) but
 *    `realpathSync` fails to fully resolve it, or `lstatSync`/`realpathSync`
 *    fail for any OTHER reason (permission denied, symlink loop). This is
 *    a hard failure — throws, and callers MUST treat it as fail-closed
 *    REJECTION, never falling through to a write. (AUDIT-6b: a broken
 *    symlink must not be silently treated as "not created yet".)
 */
function realpathNearestExisting(target: string): string {
  try {
    lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err; // permission or other lstat failure — fail closed
    }
    const parent = dirname(target);
    if (parent === target) {
      throw err; // reached the filesystem root and it's still ENOENT
    }
    const realParent = realpathNearestExisting(parent);
    return join(realParent, basename(target));
  }
  // A dirent exists at `target` — resolve it fully. Throws if it's a
  // broken symlink or otherwise unresolvable; that propagates up as a
  // hard failure, by design.
  return realpathSync(target);
}

/**
 * Resolves `relPath` against `root` and asserts the result stays INSIDE
 * `root` — rejects `..`-traversal that escapes the root, absolute
 * relPaths, and empty/blank relPaths. `root` itself is always trusted
 * (a daemon-configured file-folder root, never attacker input); only
 * `relPath` is untrusted.
 *
 * Two layers of containment, both required (AUDIT-6b):
 *  1. LEXICAL — `path.resolve` + prefix check. Cheap, rejects the common
 *     cases, and is the only signal available once we've decided NOT to
 *     touch the filesystem for paths that don't exist yet.
 *  2. REAL (symlink-resolved) — `root` and the resolved `absPath` are both
 *     realpath'd (walking up to the nearest existing ancestor when the
 *     target doesn't exist yet) and the REAL target must stay within the
 *     REAL root. This is what catches a symlink segment that pre-exists
 *     inside `root` but points outside it. Both sides are realpath'd
 *     (not just the target) because on macOS `root` itself is frequently
 *     behind a symlink (`/tmp` -> `/private/tmp`, `/var` -> `/private/var`
 *     — where `mkdtemp` fixtures live) — comparing a realpath'd target
 *     against a lexical root would false-reject legitimate ops.
 */
export function resolveContainedPath(root: string, relPath: string): SafePathResult {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return { ok: false, reason: 'empty or malformed relPath' };
  }
  if (isAbsolute(relPath)) {
    return { ok: false, reason: `absolute relPath is not allowed: "${relPath}"` };
  }

  const resolvedRoot = resolve(root);
  const absPath = resolve(resolvedRoot, relPath);

  if (absPath !== resolvedRoot && !absPath.startsWith(resolvedRoot + sep)) {
    return { ok: false, reason: `relPath escapes the file-folder root: "${relPath}"` };
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathNearestExisting(resolvedRoot);
    realTarget = realpathNearestExisting(absPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `failed to resolve real (symlink-free) path for containment check: ${message}`,
    };
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return {
      ok: false,
      reason: `relPath escapes the file-folder root via a symlink: "${relPath}"`,
    };
  }

  return { ok: true, absPath };
}
