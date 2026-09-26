/**
 * shellInputStamp — what lets `ensurePrototypeShell` run once per project per
 * process, and again only when something it reads has changed.
 *
 * The shell is ensured before every `/load` (see `loadStudioPages`), and a
 * real run reads and compares every shell file — the 2 MB runtime bundle
 * included — re-reads `.studio/`, walks the pages directory and realpaths each
 * target: about 8 ms of a 25 ms warm load, spent confirming that nothing
 * changed. Its OUTPUT depends only on files, and the templates are constants
 * of the process, so "did any input change" is a stat of each input.
 *
 * ## The inputs
 *
 * Everything a run reads, by path (`shellInputPaths`): every static and
 * generated shell file (a deleted or edited one must be restored or
 * re-judged), `.studio/shell.json`, `package.json`, `.studio/meta.json`
 * (frame defaults, preview axes, locales, the pages dir), the boards file,
 * `.studio/prototype.json`, the `i18n/LanguageContext` candidates and the
 * design-system entry. The page LIST is the one input that is not a fixed
 * file: it is stamped through the pages dir and every directory under it
 * (`listWorkspaceDirectories`), whose mtime moves when a page is added,
 * removed or renamed.
 *
 * A stamp is `lstat` — size, mtime to the nanosecond, inode — so a link
 * swapped in where a shell file was is a change, never followed.
 *
 * ## Racy stamps are never trusted
 *
 * A stamp only proves the file did not change if its mtime is older than the
 * run that read it: a write landing DURING a run, or within a coarse
 * filesystem's timestamp tick (FAT's 2 s, HFS+'s 1 s), can leave the same
 * size and mtime on different bytes. So a stamp in which any input's mtime
 * falls within {@link RACY_WINDOW_MS} of the run's start is not kept, and
 * the next call runs again — git's "racily clean" rule. It costs nothing in
 * steady state: a project whose inputs are older than two seconds is stamped
 * once and answered from the stamp until one moves.
 */
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listWorkspaceDirectories } from '@core/page-parser'
import { projectPagesDir } from '../../studioProjects'
import { boardsFilePath } from '../boardGeometry'
import { designSystemEntryPath } from '../builtinDesignSystem'
import { prototypeFilePath } from '../prototypeStore'
import { studioMetaFile } from '../studioMeta'
import { languageContextPaths } from './registryFile'

/** An input modified this close to (or after) a run's start makes the run's stamp untrustworthy — see this module's doc. */
const RACY_WINDOW_MS = 2_000

/** Path -> `size:mtimeNs:ino`, or `-` for a path that is not there. */
type Stamp = ReadonlyMap<string, string>

interface StampedRun<T> {
  stamp: Stamp
  result: T
}

const lastRuns = new Map<string, StampedRun<unknown>>()

function statKey(path: string): { key: string; mtimeMs: number | null } {
  try {
    const stat = lstatSync(path, { bigint: true })
    return { key: `${stat.size}:${stat.mtimeNs}:${stat.ino}`, mtimeMs: Number(stat.mtimeMs) }
  } catch {
    return { key: '-', mtimeMs: null }
  }
}

/**
 * Every path a shell run reads, given the shell files it knows about
 * (`shellRelPaths`, workspace-relative). The pages dir is resolved here, not
 * passed in, because it comes from `.studio/meta.json` — itself an input.
 */
export function shellInputPaths(dir: string, shellRelPaths: readonly string[], manifestRelPath: string): string[] {
  const paths = [
    ...shellRelPaths.map((relPath) => join(dir, ...relPath.split('/'))),
    join(dir, ...manifestRelPath.split('/')),
    join(dir, 'package.json'),
    studioMetaFile(dir),
    boardsFilePath(dir),
    prototypeFilePath(dir),
    designSystemEntryPath(dir),
    ...languageContextPaths(dir),
  ]
  let pagesDir: string | null
  try {
    pagesDir = projectPagesDir(dir)
  } catch {
    pagesDir = null // an escaping pagesDir override: the run imports no pages, and meta.json is already stamped
  }
  if (pagesDir !== null) {
    paths.push(pagesDir)
    for (const relDir of listWorkspaceDirectories(pagesDir)) {
      if (relDir !== '') paths.push(join(pagesDir, ...relDir.split('/')))
    }
  }
  return paths
}

/** The result of the last run for `dir`, when not one of its inputs has changed since. */
export function unchangedShellRun<T>(dir: string): T | null {
  const last = lastRuns.get(resolve(dir))
  if (!last) return null
  for (const [path, key] of last.stamp) {
    if (statKey(path).key !== key) return null
  }
  return last.result as T
}

/**
 * Record a finished run: `paths` stamped as they are now, unless one of them
 * moved within {@link RACY_WINDOW_MS} of `startedAt` — then the run is
 * forgotten and the next call runs again.
 */
export function rememberShellRun<T>(dir: string, paths: readonly string[], startedAt: number, result: T): void {
  const key = resolve(dir)
  const stamp = new Map<string, string>()
  for (const path of paths) {
    const { key: statStamp, mtimeMs } = statKey(path)
    if (mtimeMs !== null && mtimeMs >= startedAt - RACY_WINDOW_MS) {
      lastRuns.delete(key)
      return
    }
    stamp.set(path, statStamp)
  }
  lastRuns.set(key, { stamp, result })
}

/** Forget the stamped run for `dir` — the next call runs for real. */
export function forgetShellRun(dir: string): void {
  lastRuns.delete(resolve(dir))
}
