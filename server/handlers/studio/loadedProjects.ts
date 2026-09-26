/**
 * loadedProjects — the ONE least-recently-used list of projects the load path
 * keeps state for (P6-B, PERF-8).
 *
 * Three caches hold per-project state for the life of the process: the kept
 * ts-morph `Project` (`workspaceProject.ts`, the heaviest — every source file
 * parsed and bound), the memoized load result (`studioLoadMemo.ts`), and the
 * in-memory tier of the parse cache (`pageParseCache.ts`). None of them had an
 * eviction policy, so a server that opened ten projects kept ten `Project`s
 * forever. They now share this list: the {@link MAX_LOADED_PROJECTS} most
 * recently loaded projects stay, and the moment one falls off, every cache
 * forgets it together (each registers with {@link onLoadedProjectEvicted}).
 * Nothing is lost that cannot be rebuilt — the parse cache's disk tier brings
 * a forgotten project's parses back without re-running them.
 *
 * Each loaded project also owns the one {@link ProjectChangeFeed} its caches
 * read — the load path's single subscription to the project watcher, closed
 * when the project is evicted.
 *
 * A project in use (a load or a `withWorkspaceProject` callback in flight) is
 * never evicted out from under its caller: {@link retainLoadedProject} pins it
 * until released, and eviction skips pinned projects — the list may briefly
 * exceed its bound rather than drop state a running load is about to store.
 *
 * Keyed by `path.resolve(dir)`, the spelling every load-path cache uses.
 */
import { resolve } from 'node:path'
import { ProjectChangeFeed } from './projectChangeFeed'

/** How many projects the load path keeps warm. Two open tabs plus an agent reading a third is the realistic peak. */
export const MAX_LOADED_PROJECTS = 4

export interface LoadedProject {
  /** `path.resolve(dir)`. */
  readonly key: string
  readonly changes: ProjectChangeFeed
}

interface Entry extends LoadedProject {
  pins: number
}

/** Map insertion order is recency order: a touch deletes and re-inserts. */
const loaded = new Map<string, Entry>()
const evictionListeners: Array<(key: string) => void> = []

/** Called with a project's key whenever it is evicted (or cleared) — each cache drops its state for that key. */
export function onLoadedProjectEvicted(listener: (key: string) => void): void {
  evictionListeners.push(listener)
}

function forget(entry: Entry): void {
  loaded.delete(entry.key)
  entry.changes.close()
  for (const listener of evictionListeners) listener(entry.key)
}

function evictBeyondBound(): void {
  for (const entry of [...loaded.values()]) {
    if (loaded.size <= MAX_LOADED_PROJECTS) return
    if (entry.pins === 0) forget(entry)
  }
}

/**
 * `dir`'s loaded-project record, created (and its watcher subscribed) on first
 * use, marked most recently used, and pinned against eviction until the
 * returned `release` is called.
 */
export function retainLoadedProject(dir: string): { project: LoadedProject; release: () => void } {
  const key = resolve(dir)
  let entry = loaded.get(key)
  if (entry) loaded.delete(key)
  else entry = { key, changes: new ProjectChangeFeed(key), pins: 0 }
  loaded.set(key, entry)
  entry.pins += 1
  evictBeyondBound()
  const pinned = entry
  let released = false
  return {
    project: pinned,
    release: () => {
      if (released) return
      released = true
      pinned.pins -= 1
      evictBeyondBound()
    },
  }
}

/** Whether `dir` is currently loaded. Test/diagnostic only. */
export function isProjectLoaded(dir: string): boolean {
  return loaded.has(resolve(dir))
}

/** Test-only: forget every project, closing its watcher subscription and clearing every cache's state for it. */
export function clearLoadedProjects(): void {
  for (const entry of [...loaded.values()]) forget(entry)
}
