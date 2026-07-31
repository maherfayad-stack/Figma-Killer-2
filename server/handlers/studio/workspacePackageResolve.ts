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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

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
