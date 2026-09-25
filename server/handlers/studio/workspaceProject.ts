/**
 * workspaceProject — ONE ts-morph `Project` per project directory, kept while
 * the project is loaded and brought back in step with the disk before every
 * use.
 *
 * ## Why
 *
 * `loadStudioPages` used to build a fresh `createWorkspaceProject(dir)` on
 * every call. Measured on the owner's own three-page project: a load right
 * after one structural write — the resync behind every ⌘D, insert and
 * component drop — cost **1.5–2.0 s**, and a CPU profile put 85 % of it in
 * ts-morph and the TypeScript binder: re-globbing and re-parsing every source
 * file, re-binding the whole program the first time an import's target is
 * asked for (`getModuleSpecifierSourceFile` is type-checker-backed — see
 * `@core/studio-sync`'s `entryStylesheetCache.ts`), and re-walking every file
 * to find a context provider. None of that work depends on the one file that
 * changed. With the `Project` kept, a load after one edit re-parses that one
 * file, TypeScript reuses every other file's binding (`oldProgram`
 * structural reuse), and the same resync measures in the low hundreds of
 * milliseconds.
 *
 * ## The contract: `withWorkspaceProject(dir, fn)`
 *
 * 1. **Synced before `fn` runs — from the change feed, not a walk (P6-B).**
 *    The loaded project's `ProjectChangeFeed` (`loadedProjects.ts`) says
 *    which files the project watcher saw change since the last sync, from
 *    every origin; only those are re-stamped. A moved `size:mtimeMs` re-reads
 *    the file (remove + add, so every node the old text owned is genuinely
 *    gone), a new source file is added, a vanished one removed. When the feed
 *    cannot say (the watch overflowed or failed, or this is the first use),
 *    every file `listWorkspaceSourceFiles(dir)` reports is stamped instead —
 *    the walk this used to do on every call, now the fallback. Any in-memory
 *    file somebody created on the shared `Project` (`project.createSourceFile`)
 *    is removed either way. When anything changed, `resetParserCaches`
 *    empties the parser's cross-file memos, because a value cached against an
 *    unchanged file may have been read through the file that moved.
 * 2. **The feed is trusted for speed, never for a page.** A watcher reports
 *    a moment late, and on Windows it drops events in bursts (P1-D). So the
 *    handle `fn` receives carries {@link WorkspaceProjectHandle.resyncStale}:
 *    after a parse, the load hands it every file the parse read, and it
 *    re-stamps exactly those, re-reads any the feed has not caught up with,
 *    and says so — the load then parses again rather than cache a page built
 *    from text that is no longer on disk (`studioPageLoad.ts`).
 * 3. **Serialized per directory.** Callers queue: a sync while another
 *    caller's parse is mid-flight would forget nodes under it (ts-morph
 *    throws "node was removed or forgotten"), so one `fn` finishes before the
 *    next sync starts.
 * 4. **Rebuilt when `tsconfig.json` moves.** The tsconfig is read once, in
 *    `createWorkspaceProject`, and decides path-alias resolution for every
 *    file — a sync cannot patch that in. So a moved stamp on it (edited,
 *    created, deleted) rebuilds the whole `Project`. That is also how a
 *    tsconfig that stopped parsing (WB-23) becomes a `tsconfig-unreadable`
 *    warning mid-session, and how fixing it brings the aliases back without a
 *    restart. The warnings the current `Project` was built with ride on the
 *    handle.
 * 5. **Not a lock against writes.** Writes go through `projectWriteLock.ts`;
 *    one that lands while `fn` runs is picked up by the next sync.
 *
 * Kept while the project is in `loadedProjects.ts`' least-recently-used list
 * and forgotten with it, so a server that opened ten projects no longer keeps
 * ten `Project`s.
 */
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Project } from 'ts-morph'
import {
  createWorkspaceProject,
  isWorkspaceSourceFilePath,
  listWorkspaceSourceFiles,
  resetParserCaches,
  type WorkspaceProjectWarning,
} from '@core/page-parser'
import { fileStamp, MISSING } from './loadDigest'
import { onLoadedProjectEvicted, retainLoadedProject, type LoadedProject } from './loadedProjects'

/** What `withWorkspaceProject` hands its callback. */
export interface WorkspaceProjectHandle {
  project: Project
  /** What `createWorkspaceProject` had to give up building `project` — a `tsconfig-unreadable`, today. */
  warnings: readonly WorkspaceProjectWarning[]
  /**
   * Re-stamps each of `absFiles` that is (or should be) one of the `Project`'s
   * workspace source files, re-reading any whose text on disk moved since the
   * `Project` read it. `true` when anything had to be re-read — the caller's
   * result was built from text that is gone. See the module doc's rule 2.
   */
  resyncStale: (absFiles: Iterable<string>) => boolean
  /**
   * The stamp of the version of `absFile` the `Project` holds — `missing`
   * for a source file it does not hold — or `undefined` when `absFile` is not
   * a workspace source file at all (a JSON dictionary, an image, a file
   * outside the project). The parse cache's race rule compares it with the
   * disk (`pageParseCache.ts`).
   */
  recordedStamp: (absFile: string) => string | undefined
}

interface WorkspaceProjectState {
  project: Project
  warnings: readonly WorkspaceProjectWarning[]
  /** `tsconfig.json`'s stamp when `project` was built — see the module doc's rule 4. */
  tsconfigStamp: string
  /**
   * The `Project`'s own spelling of each workspace file → the stamp it had
   * when the `Project` last read it. Keyed by `projectPath`, never by a
   * `join()`ed path: on Windows the two differ in separator, and a key the
   * `Project` cannot recognise made every in-memory file look like a stamped
   * workspace file's stranger — or, worse, a stamped file look foreign.
   */
  stamps: Map<string, string>
  /** The change-feed position this `Project` is in step with. */
  cursor: number
}

/** One project's kept state, and the queue every `withWorkspaceProject` call on it chains behind. `state` is built by the first call to reach the front of the queue. */
interface Slot {
  state: WorkspaceProjectState | null
  queue: Promise<unknown>
}

const slots = new Map<string, Slot>()
onLoadedProjectEvicted((key) => slots.delete(key))

/**
 * The path as ts-morph spells it: forward slashes on every platform
 * (`C:/Users/…` on Windows). `SourceFile.getFilePath()` returns this form, so
 * it is the only key both halves of a sync can compare on.
 */
function projectPath(absFile: string): string {
  return absFile.split(sep).join('/')
}

function tsconfigStampOf(dir: string): string {
  return fileStamp(join(dir, 'tsconfig.json'))
}

function stampAll(dir: string): Map<string, string> {
  const stamps = new Map<string, string>()
  for (const relPath of listWorkspaceSourceFiles(dir)) {
    const abs = join(dir, ...relPath.split('/'))
    const stamp = fileStamp(abs)
    if (stamp !== MISSING) stamps.set(projectPath(abs), stamp)
  }
  return stamps
}

/** A freshly built `Project` and everything recorded about it. */
function buildProject(dir: string, cursor: number): WorkspaceProjectState {
  // Stamp BEFORE the build reads the files: a write that lands during the
  // build then shows as a moved stamp on the next sync instead of being
  // recorded as the text the build never saw.
  const stamps = stampAll(dir)
  const tsconfigStamp = tsconfigStampOf(dir)
  const warnings: WorkspaceProjectWarning[] = []
  return { project: createWorkspaceProject(dir, warnings), warnings, tsconfigStamp, stamps, cursor }
}

/**
 * Brings ONE file in step with the disk: `abs` is the platform spelling,
 * `stamp` its stamp now. Returns whether the `Project` changed.
 */
function syncFile(entry: WorkspaceProjectState, abs: string, stamp: string): boolean {
  const key = projectPath(abs)
  if (entry.stamps.get(key) === stamp) return false
  const existing = entry.project.getSourceFile(key)
  if (existing) entry.project.removeSourceFile(existing)
  if (stamp === MISSING) {
    const hadIt = entry.stamps.delete(key)
    return hadIt || existing !== undefined
  }
  entry.project.addSourceFileAtPath(abs)
  entry.stamps.set(key, stamp)
  return true
}

/** The workspace-relative POSIX path of `abs` when it is one of the `Project`'s source files by rule, else `null`. */
function sourceRelPath(dir: string, abs: string): string | null {
  const native = relative(dir, abs)
  if (isAbsolute(native)) return null // another drive — not under `dir` at all
  const rel = native.split(sep).join('/')
  return isWorkspaceSourceFilePath(rel) ? rel : null
}

/** Full sync: every source file stamped — the fallback when the change feed cannot say what moved. */
function syncAll(entry: WorkspaceProjectState, dir: string): boolean {
  const current = stampAll(dir)
  let changed = false
  for (const [key, stamp] of current) {
    if (syncFile(entry, key.split('/').join(sep), stamp)) changed = true
  }
  for (const key of [...entry.stamps.keys()]) {
    if (!current.has(key) && syncFile(entry, key.split('/').join(sep), MISSING)) changed = true
  }
  return changed
}

/** Incremental sync: only the paths the change feed reported. */
function syncReported(entry: WorkspaceProjectState, dir: string, rels: ReadonlySet<string>): boolean {
  let changed = false
  for (const rel of rels) {
    if (!isWorkspaceSourceFilePath(rel)) continue
    const abs = join(dir, ...rel.split('/'))
    if (syncFile(entry, abs, fileStamp(abs))) changed = true
  }
  return changed
}

/**
 * Anything else the `Project` holds that is not a stamped workspace file: an
 * in-memory file a previous caller created on it. Files ts-morph pulled in
 * through module resolution live outside the workspace (`node_modules`, a lib
 * `.d.ts`) and are left alone — evicting them would only force the program to
 * resolve them again.
 */
function dropForeignFiles(entry: WorkspaceProjectState, dir: string): boolean {
  const root = `${projectPath(resolve(dir))}/`
  let changed = false
  for (const sourceFile of entry.project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath()
    if (entry.stamps.has(filePath)) continue
    if (!filePath.startsWith(root) || filePath.includes('/node_modules/')) continue
    entry.project.removeSourceFile(sourceFile)
    changed = true
  }
  return changed
}

async function syncWithDisk(entry: WorkspaceProjectState, dir: string, loadedProject: LoadedProject): Promise<void> {
  await loadedProject.changes.settle()
  const cursor = loadedProject.changes.cursor()
  if (tsconfigStampOf(dir) !== entry.tsconfigStamp) {
    Object.assign(entry, buildProject(dir, cursor))
    resetParserCaches()
    return
  }
  const reported = loadedProject.changes.changesSince(entry.cursor)
  let changed = reported === null ? syncAll(entry, dir) : syncReported(entry, dir, reported)
  if (dropForeignFiles(entry, dir)) changed = true
  entry.cursor = cursor
  if (changed) resetParserCaches()
}

function handleFor(entry: WorkspaceProjectState, dir: string): WorkspaceProjectHandle {
  return {
    project: entry.project,
    warnings: entry.warnings,
    resyncStale: (absFiles) => {
      let changed = false
      for (const abs of absFiles) {
        if (sourceRelPath(dir, abs) === null) continue
        if (syncFile(entry, abs, fileStamp(abs))) changed = true
      }
      if (changed) resetParserCaches()
      return changed
    },
    recordedStamp: (abs) => (sourceRelPath(dir, abs) === null ? undefined : entry.stamps.get(projectPath(abs)) ?? MISSING),
  }
}

/**
 * Runs `fn` with `dir`'s kept `Project`, synced to the disk and exclusive to
 * `fn` until it settles. See the module doc for the contract.
 */
export function withWorkspaceProject<T>(dir: string, fn: (workspace: WorkspaceProjectHandle) => Promise<T>): Promise<T> {
  const key = resolve(dir)
  const { project: loadedProject, release } = retainLoadedProject(key)
  let slot = slots.get(key)
  if (!slot) {
    slot = { state: null, queue: Promise.resolve() }
    slots.set(key, slot)
  }
  const kept = slot
  const run = kept.queue.then(async () => {
    if (kept.state === null) {
      await loadedProject.changes.settle()
      kept.state = buildProject(key, loadedProject.changes.cursor())
    } else {
      await syncWithDisk(kept.state, key, loadedProject)
    }
    return fn(handleFor(kept.state, key))
  })
  kept.queue = run.catch(() => undefined)
  return run.finally(release)
}

/** How long after a load the program is warmed — long enough for the load's own response to leave first. */
const PREWARM_DELAY_MS = 50

const prewarmPending = new Set<string>()

/**
 * P6-B — build `dir`'s TypeScript program and type checker soon, off the
 * load's critical path.
 *
 * A load whose routes all came out of the parse cache never asks the
 * `Project` an import question, so it never builds the program. The FIRST
 * gesture after it then did — its re-parse resolved one import and paid the
 * whole program plus the checker: measured 0.65 s → 2.5 s for a page edit on
 * a 40-page board and 1.1 s → 3.2 s on a 1,000-file repo, against the old
 * load that built the program up front. Building it in a queued job just
 * after the load puts that cost back where it was paid before — before the
 * gesture — without adding it to the load. It goes through the project's own
 * queue, so it never runs under a parse, and a load that arrives meanwhile
 * waits at most what the old load always paid. Once built it stays: a later
 * edit's re-parse reuses every unchanged file's binding.
 *
 * Unreferenced timer, so a one-shot process (the agent's Stop hook) exits
 * without waiting for it.
 */
export function prewarmWorkspaceProgram(dir: string): void {
  const key = resolve(dir)
  if (prewarmPending.has(key)) return
  prewarmPending.add(key)
  const timer = setTimeout(() => {
    prewarmPending.delete(key)
    if (!slots.has(key)) return // evicted meanwhile — nothing to warm
    withWorkspaceProject(key, async ({ project }) => {
      project.getTypeChecker()
    }).catch((err: unknown) => console.error('[studio:workspaceProject] program prewarm failed:', err))
  }, PREWARM_DELAY_MS)
  timer.unref?.()
}

/** Test-only: drop every kept `Project` so one test's workspace cannot leak into the next. */
export function clearWorkspaceProjects(): void {
  slots.clear()
}
