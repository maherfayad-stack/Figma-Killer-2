/**
 * `bun run dev`'s preflight — the two things a fresh checkout gets wrong.
 *
 * Both were measured on this repo (`STUDIO-FIGMA-FEEL-PLAN.md` §0, work order
 * Z7), and both used to fail in a way that pointed at the wrong culprit:
 *
 *  1. **Dependencies.** Two of the runtime dependencies are `file:` links into
 *     `vendor/` (`alm-design-system`, `pixel-art-icons`). Without a `bun
 *     install` they are simply absent, and what the developer sees is
 *     `vite build` reporting that `src/modules/alm/register.tsx` cannot
 *     resolve `alm-design-system` — a module-resolution error for a package
 *     that is sitting right there in the tree. {@link ensureDependencies}
 *     re-installs when a `file:` dependency is missing from `node_modules/`,
 *     or when `bun.lock` is newer than the stamp written after the last
 *     successful install, and says which of the two it was.
 *
 *  2. **Generated artefacts.** Four committed artefacts are produced by a
 *     `*:sync` script and gated by a matching `*-fresh` architecture test.
 *     When one drifts, `bun test` goes red — but the running app says
 *     nothing, so the drift survives until someone happens to run the full
 *     suite. {@link reportGeneratedArtefactDrift} runs the four `*:check`
 *     scripts and prints the one-line `bun run <x>:sync` that fixes each.
 *
 * The checks **never block dev.** Together they cost ~20 s (`icons:check`
 * re-derives 118 icons; `alm:check` re-hashes the vendored design system), so
 * they run concurrently with the server and Vite and report when they finish.
 * A stale artefact is worth knowing about; it is not worth 20 s of staring at
 * a blank terminal, and none of the four stops the editor from running.
 *
 * Silence means fresh. Nothing is printed when there is nothing to do —
 * a preflight that announces itself on every start is the noise this plan
 * exists to remove.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Type } from '@sinclair/typebox'
import { safeParseJson } from '../../src/core/utils/jsonValidate'
import { bunRunCommand, bunCommand } from './bunCommand'

const REPO_ROOT = resolve(import.meta.dir, '../..')

/**
 * The name of the file written after a successful `bun install`. Its mtime is
 * the "dependencies were last reconciled with the lockfile" timestamp, and it
 * lives inside `node_modules/` so that deleting `node_modules/` also
 * invalidates it.
 */
export const INSTALL_STAMP_FILENAME = '.studio-install-stamp'

/**
 * The four paths {@link installReason} reads. Passed in rather than closed
 * over so the decision can be exercised against a temp directory — the
 * rejection cases (no `node_modules/`, an unlinked `file:` dependency, a
 * moved lockfile) are the whole reason this module exists.
 */
export interface DependencyPaths {
  packageJson: string
  nodeModules: string
  lockfile: string
}

export const REPO_DEPENDENCY_PATHS: DependencyPaths = {
  packageJson: join(REPO_ROOT, 'package.json'),
  nodeModules: join(REPO_ROOT, 'node_modules'),
  lockfile: join(REPO_ROOT, 'bun.lock'),
}

/**
 * Only the two fields that decide whether an install is needed. Deliberately
 * not a mirror of the whole manifest: this reads one thing and should fail
 * loudly if `dependencies` ever stops being a string map.
 */
const PackageManifestSchema = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
})

/** The four committed artefacts with a `*:sync` producer and a `*-fresh` gate. */
export const GENERATED_ARTEFACTS = [
  { check: 'alm:check', sync: 'alm:sync', what: 'the vendored design system (dist/, tokens, the ALM manifest)' },
  { check: 'studio-runtime:check', sync: 'studio-runtime:sync', what: 'the Tier-2 studio-runtime bundles' },
  { check: 'icons:check', sync: 'icons:sync', what: 'the vendored pixel-art icons' },
  { check: 'bootstrap:check', sync: 'bootstrap:sync', what: 'the QuickJS plugin bootstrap' },
] as const

export type PreflightLog = (message: string) => void
export type PreflightFail = (message: string) => never

/**
 * Every dependency declared as a local `file:` link. These are the ones a
 * fresh checkout is missing in a way that reads as a code bug rather than a
 * setup step, because the source they point at IS in the tree.
 */
export function localFileDependencies(packageJsonPath: string): string[] {
  const parsed = safeParseJson(readFileSync(packageJsonPath, 'utf8'), PackageManifestSchema)
  if (!parsed.ok) return []
  const all = { ...parsed.value.dependencies, ...parsed.value.devDependencies }
  return Object.entries(all)
    .filter(([, version]) => version.startsWith('file:'))
    .map(([name]) => name)
}

/**
 * Why an install is needed, or `null` when it is not. Returning the reason
 * rather than a boolean is the point: the one line this prints is the whole
 * value of the check.
 */
export function installReason(paths: DependencyPaths = REPO_DEPENDENCY_PATHS): string | null {
  if (!existsSync(paths.nodeModules)) return 'node_modules/ is missing'

  for (const name of localFileDependencies(paths.packageJson)) {
    if (!existsSync(join(paths.nodeModules, name))) {
      return `node_modules/${name} is missing (it is a "file:" dependency — vendored source, still needs linking)`
    }
  }

  const stamp = join(paths.nodeModules, INSTALL_STAMP_FILENAME)
  if (!existsSync(stamp)) return 'no record of a completed install in this checkout'
  if (!existsSync(paths.lockfile)) return null
  if (statSync(paths.lockfile).mtimeMs > statSync(stamp).mtimeMs) {
    return 'bun.lock changed since the last install'
  }
  return null
}

/**
 * Installs dependencies if anything says they are out of date, and stamps the
 * result. Blocking: nothing downstream works without `node_modules/`, so this
 * is the one part of the preflight that dev waits for.
 */
function ensureDependencies(log: PreflightLog, fail: PreflightFail): void {
  const reason = installReason()
  if (!reason) return

  log(`Installing dependencies — ${reason}.`)
  const result = Bun.spawnSync(bunCommand('install'), {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    fail(`\`bun install\` exited with code ${result.exitCode}. Fix the install, then re-run \`bun run dev\`.`)
  }
  writeFileSync(join(REPO_DEPENDENCY_PATHS.nodeModules, INSTALL_STAMP_FILENAME), `${new Date().toISOString()}\n`)
}

/**
 * Runs the four `*:check` scripts in parallel and prints the one-line fix for
 * each that drifted. Resolves once all four have reported; never throws and
 * never exits, because a stale generated artefact is a thing to fix, not a
 * reason to refuse to start.
 */
export async function reportGeneratedArtefactDrift(log: PreflightLog): Promise<void> {
  const results = await Promise.all(
    GENERATED_ARTEFACTS.map(async (artefact) => {
      const child = Bun.spawn(bunRunCommand(artefact.check), {
        cwd: REPO_ROOT,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      return { artefact, exitCode: await child.exited }
    }),
  )

  for (const { artefact, exitCode } of results) {
    if (exitCode === 0) continue
    log(`${artefact.what} is stale — run \`bun run ${artefact.sync}\` (dev is running anyway).`)
  }
}

/**
 * The whole preflight, in the one line `scripts/dev.ts` calls before it spawns
 * anything. Awaits the install; leaves the freshness report running in the
 * background so it cannot delay the server.
 */
export function runDevPreflight(log: PreflightLog, fail: PreflightFail): void {
  ensureDependencies(log, fail)
  void reportGeneratedArtefactDrift(log)
}
