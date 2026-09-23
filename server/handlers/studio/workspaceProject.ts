/**
 * workspaceProject — ONE ts-morph `Project` per project directory, kept for
 * the life of the process and brought back in step with the disk before
 * every use.
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
 * 1. **Synced before `fn` runs.** Every file `listWorkspaceSourceFiles(dir)`
 *    reports is compared against the `size:mtimeMs` stamp recorded when the
 *    `Project` last saw it. A moved stamp re-reads the file (remove + add, so
 *    every node the old text owned is genuinely gone), a new file is added,
 *    a file no longer on disk is removed — and so is any in-memory file
 *    somebody created on the shared `Project` (`project.createSourceFile`),
 *    which would otherwise collide with the next caller who creates it again.
 *    When anything at all changed, `resetParserCaches` empties the parser's
 *    cross-file memos, because a value cached against an unchanged file may
 *    have been read through the file that moved.
 * 2. **Serialized per directory.** Callers queue: a sync while another
 *    caller's parse is mid-flight would forget nodes under it (ts-morph
 *    throws "node was removed or forgotten"), so one `fn` finishes before the
 *    next sync starts. Loads are the only callers and a single client already
 *    issues them one at a time; the queue is what keeps an MCP tool's
 *    concurrent load honest.
 * 3. **Rebuilt when `tsconfig.json` moves.** The tsconfig is read once, in
 *    `createWorkspaceProject`, and decides path-alias resolution for every
 *    file — a sync cannot patch that in. So a moved `size:mtimeMs` on it
 *    (edited, created, deleted) rebuilds the whole `Project`. That is also
 *    how a tsconfig that stopped parsing (WB-23) becomes a
 *    `tsconfig-unreadable` warning mid-session, and how fixing it brings the
 *    aliases back without a restart. The warnings the current `Project` was
 *    built with are handed to `fn` beside it.
 * 4. **Not a lock against writes.** A codemod that lands while `fn` runs is
 *    picked up by the NEXT call's sync — the same staleness window a fresh
 *    `Project` had, since neither watches the disk. Writes go through their
 *    own `projectWriteLock.ts`.
 *
 * Process-scoped, no eviction — the same posture as `pageParseCache.ts` and
 * `studioLoadMemo.ts`. A project whose files all disappear keeps an empty
 * `Project`; a `bun --watch` restart drops everything.
 */
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Project } from 'ts-morph'
import {
  createWorkspaceProject,
  listWorkspaceSourceFiles,
  resetParserCaches,
  type WorkspaceProjectWarning,
} from '@core/page-parser'

interface WorkspaceProjectEntry {
  project: Project
  /** What `createWorkspaceProject` had to give up building `project` — a `tsconfig-unreadable`, today. */
  warnings: readonly WorkspaceProjectWarning[]
  /** `tsconfig.json`'s `size:mtimeMs` (`null` when absent) when `project` was built — see the module doc's rule 3. */
  tsconfigStamp: string | null
  /**
   * The `Project`'s own spelling of each workspace file → the `size:mtimeMs`
   * it had when the `Project` last read it. Keyed by `projectPath`, never by a
   * `join()`ed path: on Windows the two differ in separator, and a key the
   * `Project` cannot recognise made every in-memory file look like a stamped
   * workspace file's stranger — or, worse, a stamped file look foreign.
   */
  stamps: Map<string, string>
  /** The tail of the per-directory queue — every `withWorkspaceProject` call chains behind it. */
  queue: Promise<unknown>
}

const entries = new Map<string, WorkspaceProjectEntry>()

/**
 * The path as ts-morph spells it: forward slashes on every platform
 * (`C:/Users/…` on Windows). `SourceFile.getFilePath()` returns this form, so
 * it is the only key both halves of `syncWithDisk` can compare on.
 */
function projectPath(absFile: string): string {
  return absFile.split(sep).join('/')
}

/**
 * `tsconfig.json`'s `size:mtimeMs`, or `null` when there is none. Exported for
 * the parse cache's config hash: the tsconfig decides alias resolution, so a
 * route parsed under one tsconfig is not a valid answer under another.
 */
export function workspaceTsconfigStamp(dir: string): string | null {
  return fileStamp(join(dir, 'tsconfig.json'))
}

function fileStamp(absFile: string): string | null {
  try {
    const stat = statSync(absFile)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null // gone between the walk and the stat — treated as absent
  }
}

function stampAll(dir: string): Map<string, string> {
  const stamps = new Map<string, string>()
  for (const relPath of listWorkspaceSourceFiles(dir)) {
    const abs = join(dir, ...relPath.split('/'))
    const stamp = fileStamp(abs)
    if (stamp !== null) stamps.set(projectPath(abs), stamp)
  }
  return stamps
}

/** A freshly built `Project` and everything recorded about it — see `createEntry`/`rebuildEntry`. */
function buildProject(dir: string): Omit<WorkspaceProjectEntry, 'queue'> {
  // Stamp BEFORE the build reads the files: a write that lands during the
  // build then shows as a moved stamp on the next sync instead of being
  // recorded as the text the build never saw.
  const stamps = stampAll(dir)
  const tsconfigStamp = workspaceTsconfigStamp(dir)
  const warnings: WorkspaceProjectWarning[] = []
  return { project: createWorkspaceProject(dir, warnings), warnings, tsconfigStamp, stamps }
}

function createEntry(dir: string): WorkspaceProjectEntry {
  return { ...buildProject(dir), queue: Promise.resolve() }
}

/** Rule 3: `tsconfig.json` moved, so every file's resolution may have — start over. */
function rebuildEntry(entry: WorkspaceProjectEntry, dir: string): void {
  Object.assign(entry, buildProject(dir))
  resetParserCaches()
}

/** Brings `entry.project` in step with the disk. Returns whether anything changed. */
function syncWithDisk(entry: WorkspaceProjectEntry, dir: string): boolean {
  const { project, stamps } = entry
  const current = stampAll(dir)
  let changed = false

  for (const [abs, stamp] of current) {
    if (stamps.get(abs) === stamp) continue
    const existing = project.getSourceFile(abs)
    if (existing) project.removeSourceFile(existing)
    project.addSourceFileAtPath(abs)
    stamps.set(abs, stamp)
    changed = true
  }

  for (const abs of [...stamps.keys()]) {
    if (current.has(abs)) continue
    const existing = project.getSourceFile(abs)
    if (existing) project.removeSourceFile(existing)
    stamps.delete(abs)
    changed = true
  }

  // Anything else the `Project` holds that is not a stamped workspace file:
  // an in-memory file a previous caller created on it. Files ts-morph pulled
  // in through module resolution live outside the workspace (`node_modules`,
  // a lib `.d.ts`) and are left alone — evicting them would only force the
  // program to resolve them again.
  const root = `${projectPath(resolve(dir))}/`
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath()
    if (stamps.has(filePath)) continue
    if (!filePath.startsWith(root) || filePath.includes('/node_modules/')) continue
    project.removeSourceFile(sourceFile)
    changed = true
  }

  if (changed) resetParserCaches()
  return changed
}

/**
 * Runs `fn` with `dir`'s kept `Project`, synced to the disk and exclusive to
 * `fn` until it settles. See the module doc for the contract.
 */
export function withWorkspaceProject<T>(
  dir: string,
  fn: (project: Project, warnings: readonly WorkspaceProjectWarning[]) => Promise<T>,
): Promise<T> {
  const key = resolve(dir)
  let entry = entries.get(key)
  if (!entry) {
    entry = createEntry(key)
    entries.set(key, entry)
    // Freshly built: already in step with the disk, nothing to sync.
    const run = entry.queue.then(() => fn(entry!.project, entry!.warnings))
    entry.queue = run.catch(() => undefined)
    return run
  }
  const kept = entry
  const run = kept.queue.then(() => {
    if (workspaceTsconfigStamp(key) !== kept.tsconfigStamp) rebuildEntry(kept, key)
    else syncWithDisk(kept, key)
    return fn(kept.project, kept.warnings)
  })
  kept.queue = run.catch(() => undefined)
  return run
}

/** Test-only: drop every kept `Project` so one test's workspace cannot leak into the next. */
export function clearWorkspaceProjects(): void {
  entries.clear()
}
