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
 * 3. **Not a lock against writes.** A codemod that lands while `fn` runs is
 *    picked up by the NEXT call's sync — the same staleness window a fresh
 *    `Project` had, since neither watches the disk. Writes go through their
 *    own `projectWriteLock.ts`.
 *
 * Process-scoped, no eviction — the same posture as `pageParseCache.ts` and
 * `studioLoadMemo.ts`. A project whose files all disappear keeps an empty
 * `Project`; a `bun --watch` restart drops everything.
 */
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Project } from 'ts-morph'
import { createWorkspaceProject, listWorkspaceSourceFiles, resetParserCaches } from '@core/page-parser'

interface WorkspaceProjectEntry {
  project: Project
  /** Absolute file path → the `size:mtimeMs` it had when the `Project` last read it. */
  stamps: Map<string, string>
  /** The tail of the per-directory queue — every `withWorkspaceProject` call chains behind it. */
  queue: Promise<unknown>
}

const entries = new Map<string, WorkspaceProjectEntry>()

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
    if (stamp !== null) stamps.set(abs, stamp)
  }
  return stamps
}

function createEntry(dir: string): WorkspaceProjectEntry {
  // Stamp BEFORE the build reads the files: a write that lands during the
  // build then shows as a moved stamp on the next sync instead of being
  // recorded as the text the build never saw.
  const stamps = stampAll(dir)
  return { project: createWorkspaceProject(dir), stamps, queue: Promise.resolve() }
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
  const root = `${resolve(dir)}${join('/')}`
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
export function withWorkspaceProject<T>(dir: string, fn: (project: Project) => Promise<T>): Promise<T> {
  const key = resolve(dir)
  let entry = entries.get(key)
  if (!entry) {
    entry = createEntry(key)
    entries.set(key, entry)
    // Freshly built: already in step with the disk, nothing to sync.
    const run = entry.queue.then(() => fn(entry!.project))
    entry.queue = run.catch(() => undefined)
    return run
  }
  const kept = entry
  const run = kept.queue.then(() => {
    syncWithDisk(kept, key)
    return fn(kept.project)
  })
  kept.queue = run.catch(() => undefined)
  return run
}

/** Test-only: drop every kept `Project` so one test's workspace cannot leak into the next. */
export function clearWorkspaceProjects(): void {
  entries.clear()
}
