/**
 * resolveWorkspacePackageEntry — `<dir>/node_modules/<pkg>`'s real entry
 * file, or `undefined` when the package isn't installed there OR when
 * resolving it would escape `dir` through a symlink. Shared by
 * `styleCompile.ts` (the parent process, checking `sass`/`postcss`/
 * `@tailwindcss/postcss` are actually installed before ever spawning a
 * subprocess) and `styleCompileWorker.ts` (the subprocess itself, resolving
 * whatever plugin packages a `postcss.config.js` names — which can only be
 * known after that config file has been executed, so this resolution step
 * has to be repeatable from inside the child too).
 *
 * Never falls back to the host admin server's own `node_modules`, and never
 * trusts a symlink at rest: a repo arrives from GitHub, git stores symlinks,
 * and an attacker-controlled `node_modules/<pkg>` entry that is actually a
 * symlink to something outside `dir` (e.g. `~/.ssh`) must not resolve — see
 * `.claude/agents/security-guard.md`'s "Paths" checklist, "containment
 * checked on the real path, after resolving symlinks." Same pattern as
 * `studioAsset.ts`'s asset-read guard and `installDeps.ts`'s workspace
 * containment check.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** True when `target`'s real (symlink-resolved) path sits at-or-under `dir`'s real path. Missing/broken targets are never contained (matches `studioAsset.ts`'s "falls through to a miss" posture). */
export function isRealpathContained(target: string, dir: string): boolean {
  const realDir = safeRealpath(dir)
  const realTarget = safeRealpath(target)
  if (!realDir || !realTarget) return false
  return realTarget === realDir || realTarget.startsWith(realDir + sep)
}

/**
 * Containment for a path that may not exist yet.
 *
 * {@link isRealpathContained} answers "is this real path inside `dir`", and a
 * path that does not exist has no real path, so it answers `false` — which is
 * correct for its callers but WRONG as a gate in front of a read, because it
 * collapses two different answers into one. A caller that reports "not a
 * readable path inside this project" then blames containment for a file that
 * is simply absent, and whoever reads that message goes looking for a
 * permissions bug that isn't there. (Observed exactly that way: an agent told
 * to read `.claude/design-system.md` in a project where the roster had not
 * regenerated yet.)
 *
 * So this walks up to the deepest ancestor that DOES exist and containment-
 * checks that. Security is unchanged, because the thing symlink checks defend
 * against is a planted link redirecting the path outside `dir`, and any such
 * link must exist to have any effect:
 *   - target exists  → identical to `isRealpathContained`.
 *   - target missing → every existing ancestor is verified inside `dir`, so
 *     no symlinked parent can carry the eventual path out, and the
 *     non-existent tail cannot itself be a link.
 * Returns false if the walk leaves `dir` entirely, so `..` (already rejected
 * syntactically upstream) has no second route in.
 */
export function isRealpathContainedAllowingMissing(target: string, dir: string): boolean {
  const realDir = safeRealpath(dir)
  if (!realDir) return false
  let current = target
  // Bounded by construction: `dirname` strictly shortens until it reaches the
  // filesystem root, where it becomes a fixed point and the loop exits.
  for (;;) {
    const real = safeRealpath(current)
    if (real !== undefined) {
      return real === realDir || real.startsWith(realDir + sep)
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * `path` with symlinks resolved on the part of it that exists, and the
 * missing tail appended unchanged. For comparing where a directory WILL be
 * before it is created (a workspace root on first boot).
 */
export function realpathAllowingMissing(path: string): string {
  let existing = resolve(path)
  const missing: string[] = []
  for (;;) {
    const real = safeRealpath(existing)
    if (real !== undefined) return missing.length === 0 ? real : join(real, ...missing)
    const parent = dirname(existing)
    if (parent === existing) return resolve(path)
    missing.unshift(basename(existing))
    existing = parent
  }
}

/**
 * The containment rule for a directory Studio is about to CREATE OR REPLACE
 * under `root` (a clone target, an archive import's target, which is cleared
 * first). Stricter than {@link isRealpathContainedAllowingMissing} in the two
 * ways a write target needs:
 *
 *   - it must sit strictly INSIDE `root`, never be `root` itself (clearing the
 *     root would delete every project), whether spelled directly or reached
 *     through a symlink that resolves to it;
 *   - a symlink at the target itself must resolve inside `root`, and a
 *     dangling one is refused outright rather than treated as "missing".
 *
 * A missing target is judged by its deepest existing ancestor, exactly as in
 * {@link isRealpathContainedAllowingMissing}. `root` must exist.
 */
export function isRealpathStrictlyInsideAllowingMissing(target: string, root: string): boolean {
  const realRoot = safeRealpath(root)
  if (!realRoot) return false
  if (resolve(target) === resolve(root)) return false
  let targetEntryExists: boolean
  try {
    lstatSync(target)
    targetEntryExists = true
  } catch {
    targetEntryExists = false
  }
  if (targetEntryExists) {
    const realTarget = safeRealpath(target)
    return realTarget !== undefined && realTarget.startsWith(realRoot + sep)
  }
  return isRealpathContainedAllowingMissing(target, root)
}

/** `<dir>/node_modules/<pkg>`'s real entry file (from its `package.json#main`, default `index.js`), symlink-containment-checked against `dir`, or `undefined` when not installed / not resolvable / escaping `dir`. */
export function resolveWorkspacePackageEntry(dir: string, pkgName: string): string | undefined {
  const pkgDir = join(dir, 'node_modules', ...pkgName.split('/'))
  const pkgJsonPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return undefined

  let mainRel = 'index.js'
  try {
    const raw: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    if (raw && typeof raw === 'object') {
      const main = (raw as Record<string, unknown>).main
      if (typeof main === 'string' && main.length > 0) mainRel = main
    }
  } catch {
    // fall back to index.js
  }

  const entry = join(pkgDir, ...mainRel.split('/'))
  if (!existsSync(entry)) return undefined
  return isRealpathContained(entry, dir) ? entry : undefined
}
