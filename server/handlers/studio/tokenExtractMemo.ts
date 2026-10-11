/**
 * tokenExtractMemo — the token extraction runs again only when something it
 * reads has changed (P6-B finding 3, perf-17).
 *
 * Every project open ends with `POST /admin/api/studio/tokens` (the client's
 * `adoptLoadedFramework`, after the load). It re-ran the whole extraction —
 * `compileProjectStyles` plus up to six token sources, 150–180 ms of server
 * CPU on the 40-page board and 550–590 ms on a 1,000-file repo — on every
 * open, warm or not, for a project that had not changed since the last one.
 *
 * ## What the extraction reads, and what says it changed
 *
 * - **The project's own files** — its stylesheets (compiled at Tier 0, or by
 *   the toolchain at Tier 1), a Tailwind config, `.scss` files, a theme file,
 *   the `design-system/` folder. Exactly the files a load depends on, so the
 *   load memo's own rule decides: the project watcher reported none of them
 *   (or its fingerprint fallback is unchanged) and `.studio/meta.json` — which
 *   carries the trust tier Tier-1 compilation depends on — is unchanged
 *   (`studioLoadMemo.ts`'s {@link projectInputsUnchanged}).
 * - **Installed packages** — `vendor-css` and the installed-package source
 *   read `node_modules`, which the watcher never enters. An install or an
 *   upgrade rewrites the app root's lockfile (and npm's
 *   `node_modules/.package-lock.json`); adding a package adds a
 *   `node_modules` entry. Those are stamped at compute time and compared.
 *   A hand edit inside an installed package's CSS is not seen by the memo;
 *   the panel's "Re-scan tokens" (`rescan`) extracts regardless.
 * - **Studio's own copy of the built-in design system** — part of Studio, so
 *   it cannot change while this process runs.
 *
 * One entry per loaded project, forgotten with it (`loadedProjects.ts`' LRU),
 * like the load memo.
 */
import { join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { fileStamp, MISSING } from './loadDigest'
import { onLoadedProjectEvicted, retainLoadedProject } from './loadedProjects'
import { markProjectInputs, projectInputsUnchanged, type ProjectInputsMark } from './studioLoadMemo'

/** The files an install or upgrade rewrites, relative to the app root. */
const INSTALL_STAMP_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'node_modules/.package-lock.json',
  'node_modules/.modules.yaml',
]

/** `node_modules`' own mtime: an entry added or removed at its top level. */
function directoryStamp(absDir: string): string {
  try {
    const stat = statSync(absDir)
    return stat.isDirectory() ? `dir:${stat.mtimeMs}` : MISSING
  } catch (_err) {
    return MISSING // no node_modules at all is a state too
  }
}

function installStamp(appRootAbs: string): string {
  const parts = INSTALL_STAMP_FILES.map((rel) => `${rel}:${fileStamp(join(appRootAbs, ...rel.split('/')))}`)
  parts.push(`node_modules/:${directoryStamp(join(appRootAbs, 'node_modules'))}`)
  return parts.join('|')
}

interface MemoEntry<T> {
  inputs: ProjectInputsMark
  appRootAbs: string
  installStamp: string
  result: T
}

const memo = new Map<string, MemoEntry<unknown>>()
onLoadedProjectEvicted((key) => memo.delete(key))

/**
 * `extract()`'s result for `dir` — the memoized one while nothing it reads
 * has changed (see this module's doc), otherwise freshly extracted and kept.
 * `appRootAbs` is the project's app root, where its packages are installed.
 */
export async function memoizedTokenExtraction<T>(dir: string, appRootAbs: () => string, extract: () => Promise<T>): Promise<T> {
  const key = resolve(dir)
  const { project, release } = retainLoadedProject(key)
  try {
    await project.changes.settle()
    const entry = memo.get(key) as MemoEntry<T> | undefined
    if (entry && projectInputsUnchanged(entry.inputs, project) && installStamp(entry.appRootAbs) === entry.installStamp) {
      return entry.result
    }
    const inputs = markProjectInputs(project)
    const root = appRootAbs()
    const stamp = installStamp(root)
    const result = await extract()
    memo.set(key, { inputs, appRootAbs: root, installStamp: stamp, result })
    return result
  } finally {
    release()
  }
}

/** Forget `dir`'s extraction, so the next one runs — the panel's explicit "Re-scan tokens". */
export function clearTokenExtractMemoFor(dir: string): void {
  memo.delete(resolve(dir))
}

/** Test-only: forget every memoized extraction. */
export function clearTokenExtractMemo(): void {
  memo.clear()
}
