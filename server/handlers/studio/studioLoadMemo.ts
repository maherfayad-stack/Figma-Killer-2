/**
 * studioLoadMemo — W9-5 lever 1, reworked by P6-B (PERF-8): one real
 * `loadStudioPages` per change, and a repeat load that costs `stat`s of the
 * files the load actually read — not a walk of the whole project.
 *
 * `pageParseCache.ts` (read it first) makes the expensive half — the per-route
 * ts-morph parse and §7 evaluator pass — reusable across calls. What it does
 * NOT make reusable is everything `loadStudioPages` does AROUND those parses:
 * the `Project` sync, `compileProjectStyles`, the page/story directory walks,
 * `loadStudioStyles`' site-wide class-id registry, and the per-page
 * `parsedPageToSitePage` convert. An agent turn pays that in the live digest,
 * again in `studio_compare`, again in `studio_screenshot`/`studio_quality_check`,
 * and the board pays it on every resync — against a project that did not
 * change in between. This memo keeps the WHOLE `StudioLoadResult` per project.
 *
 * ## Validity
 *
 * Before P6-B the answer to "did anything change" was a fingerprint over every
 * source-relevant file: a walk plus a `stat` of each, synchronously, on every
 * load (27 ms on a 1,000-file repo, blocking every other request), and folded
 * into a 32-bit hash that `"Aa"`/`"BB"` could collide. Now a memo hit needs
 * ALL of these, cheapest first:
 *
 *   1. **The project watcher saw nothing relevant.** The loaded project's
 *      change feed (`projectChangeFeed.ts`, P1-D's watcher, every origin) has
 *      reported no {@link FINGERPRINTED_EXTENSIONS} file since the memo was
 *      computed — a page added or deleted, a stylesheet or `tailwind.config.ts`
 *      edited, a `package.json` dependency changed, a story file appeared.
 *      The feed is settled first (`ProjectChangeFeed.settle`): pending events
 *      are flushed, and a Studio write since the watcher last looked forces it
 *      to look now, so a save followed straight away by the board's resync is
 *      never answered from before the save.
 *   2. **Every file the result was built from is unchanged** — the stamps of
 *      every route's dependencies (`routeParse.ts`: what the parse read, and
 *      what it found missing), every stylesheet the registry read, and the
 *      tsconfig and `package.json`. This does not trust the watcher at all: a
 *      page is never served from here once a file it read has moved, even if
 *      `fs.watch` dropped the event (on Windows it drops them in bursts).
 *   3. **The route list is unchanged** — the pages directory re-listed, so a
 *      page file added a moment ago is never missing, whatever the watcher has
 *      delivered yet.
 *   4. **`.studio/meta.json` is unchanged** in every field that decides a
 *      parse — see {@link NON_PARSE_META_FIELDS}.
 *
 * When the feed cannot vouch at all (the watch failed or overflowed, P1-D's
 * rule), 1 falls back to the old whole-project fingerprint — SHA-256 now.
 *
 * What only rule 1 covers is a change to a file the load did not read and
 * that is not a route: a new component file an existing import could now
 * resolve to (the parse cache records that absence too, `routeParse.ts`), a
 * style toolchain config, a story file. The watcher reports those within
 * milliseconds; `projectChangeFeed.ts` documents the backstop for an event
 * the OS drops outright.
 *
 * ## Shared, and cloned only on request
 *
 * `loadStudioPages` hands callers `Page` objects they are free to mutate, so
 * it clones the memoized result (`structuredClone`, 31 ms of a 39 ms warm
 * load on a 40-page, 3 MB board). The `/load` route only SERIALISES the
 * result, so it reads the shared one (`loadStudioPagesShared`) and skips the
 * clone. The memo stores what it computed without cloning: the compute
 * builds fresh objects every time.
 *
 * ## Every load stores the FULL result
 *
 * A narrowed load (`options.pageIds`, the canvas's targeted reload) runs the
 * same compute and converts every route — narrowing happens on the way out,
 * by filtering `pages`. So the result it computed IS the project-wide truth,
 * and the full load that follows a canvas resync is a memo hit.
 *
 * One entry per loaded project, forgotten with it (`loadedProjects.ts`' LRU).
 *
 * ## One compute per project at a time
 *
 * A load that finds a compute of the same project already running waits for
 * it, then checks the memo like any other load (perf-17). It does not take the
 * running compute's result unchecked: that compute began earlier, and a change
 * in between must still produce a fresh one.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { canvasLayerRelPath } from '@core/studio-board'
import { listCanvasLayerIds } from './canvasLayerFiles'
import { digestOf, fileStamp, stampsUnchanged } from './loadDigest'
import { onLoadedProjectEvicted, retainLoadedProject, type LoadedProject } from './loadedProjects'
import type { StudioLoadResult } from './studioLoadContract'

/**
 * Extensions whose content can change what `loadStudioPages` returns. `svg`
 * (WB-2) because a `?raw` icon import's VALUE is the file's text.
 */
const FINGERPRINTED_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|css|scss|sass|less|json|svg)$/i

/**
 * `.studio/meta.json` fields that change WITHOUT changing a load result, and
 * must therefore be excluded from its stamp.
 *
 * `lastOpenedAt` is the whole reason this list exists. `GET /admin/api/studio/
 * load` stamps it through `recordProjectOpened` on its way in — and the board
 * calls that same route to re-sync after EVERY structural edit. Stamping the
 * file by mtime therefore guaranteed a miss on every single load, and every
 * duplicate, insert, wrap and group paid a full cold `computeStudioPages`
 * (~600 ms on a two-page project, measured) for work the previous gesture had
 * already done. The memo was correct; it was being invalidated by its own
 * reader.
 *
 * `trustAutoPromotedAt` is here for the same reason: it is a timestamp beside
 * a boolean latch, and `trustAutoPromoted` — the field that actually decides
 * anything — is NOT excluded, so the promotion itself still invalidates.
 *
 * An EXCLUDE list, not an include list, deliberately: a new parse-relevant
 * field added to `StudioMeta` is covered automatically, and only a field
 * someone consciously names here can ever be ignored.
 */
const NON_PARSE_META_FIELDS = new Set(['lastOpenedAt', 'trustAutoPromotedAt'])

/**
 * Inside `EXCLUDED_WORKSPACE_DIR_NAMES` (so neither the watcher nor
 * `listWorkspaceFiles` reports it) — but it decides pagesDir, locale,
 * framework, trust and stories, so it is compared by CONTENT (minus the fields
 * above) on every load.
 */
const META_RELATIVE_PATH = '.studio/meta.json'

/**
 * `.studio/meta.json`'s contribution: its parsed content with the fields above
 * removed, re-serialised with sorted keys so a rewrite that only reorders them
 * is not mistaken for a change. Unreadable or malformed falls back to the raw
 * bytes: a file this function cannot understand must still invalidate when it
 * changes.
 */
function metaStamp(dir: string): string {
  const absFile = join(dir, ...META_RELATIVE_PATH.split('/'))
  let raw: string
  try {
    raw = readFileSync(absFile, 'utf8')
  } catch {
    return 'missing'
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
    const stable = Object.entries(parsed as Record<string, unknown>)
      .filter(([key]) => !NON_PARSE_META_FIELDS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify(stable)
  } catch {
    return raw
  }
}

/**
 * A collision-safe signature of every file in `dir` whose content could change
 * a load result: `relPath:size:mtimeMs` for each {@link FINGERPRINTED_EXTENSIONS}
 * file `listWorkspaceFiles` walks, plus `.studio/meta.json`'s {@link metaStamp}.
 * The fallback for a project whose watcher cannot vouch — see this module's doc.
 */
export function workspaceLoadFingerprint(dir: string): string {
  const parts: string[] = []
  for (const relPath of listWorkspaceFiles(dir)) {
    if (!FINGERPRINTED_EXTENSIONS.test(relPath)) continue
    parts.push(`${relPath}:${fileStamp(join(dir, ...relPath.split('/')))}`)
  }
  parts.push(`${META_RELATIVE_PATH}:${metaStamp(dir)}`)
  // P5-G — the free canvas's layer modules live under `.studio/canvas/`, which
  // the walk above never enters, and a load returns them (`canvasLayers`). A
  // layer created, placed or edited outside Studio must invalidate like any
  // page file does, so each one is stamped explicitly, the way meta.json is.
  for (const id of listCanvasLayerIds(dir)) {
    const rel = canvasLayerRelPath(id)
    parts.push(`${rel}:${fileStamp(join(dir, ...rel.split('/')))}`)
  }
  return digestOf(parts)
}

/** What a compute hands the memo: the result, and what it was built from. */
export interface ComputedStudioLoad {
  result: StudioLoadResult
  /** The stamp of every file the result was built from, or `null` when it must not be memoized (a file moved while it was computed). */
  dependencies: ReadonlyMap<string, string> | null
}

/** How a memoized load is checked and recomputed — supplied by `studioPageLoad.ts`, which knows how the project's routes are discovered. */
export interface StudioLoadComputation {
  compute: () => Promise<ComputedStudioLoad>
  /** The project's route files as the load discovers them, joined — rule 3 of this module's doc. */
  routeListing: () => string
}

/**
 * Where a project's inputs stood when a compute began — rules 1 and 4 of this
 * module's doc, shared with every other per-project cache that must go stale
 * exactly when a load would (`tokenExtractMemo.ts`).
 */
export interface ProjectInputsMark {
  /** Change-feed position when the compute began. */
  cursor: number
  /** Present only when the feed could not vouch at compute time — the fallback. */
  fingerprint: string | null
  metaStamp: string
}

/** Mark `project`'s inputs now, before a compute reads them. The feed must have been settled first. */
export function markProjectInputs(project: LoadedProject): ProjectInputsMark {
  const cursor = project.changes.cursor()
  const fingerprint = project.changes.changesSince(cursor) === null ? workspaceLoadFingerprint(project.key) : null
  return { cursor, fingerprint, metaStamp: metaStamp(project.key) }
}

/**
 * Whether nothing that can change a load has changed since `mark`: the
 * watcher reported no {@link FINGERPRINTED_EXTENSIONS} file (or, when it cannot
 * vouch, the whole-project fingerprint is unchanged) and `.studio/meta.json`
 * is unchanged. The feed must have been settled first.
 */
export function projectInputsUnchanged(mark: ProjectInputsMark, project: LoadedProject): boolean {
  const changedSince = project.changes.changesSince(mark.cursor)
  if (changedSince === null) {
    if (mark.fingerprint === null || workspaceLoadFingerprint(project.key) !== mark.fingerprint) return false
  } else {
    for (const rel of changedSince) if (FINGERPRINTED_EXTENSIONS.test(rel)) return false
  }
  return metaStamp(project.key) === mark.metaStamp
}

interface MemoEntry {
  inputs: ProjectInputsMark
  routeListing: string
  dependencies: ReadonlyMap<string, string>
  result: StudioLoadResult
}

const memo = new Map<string, MemoEntry>()
/**
 * The compute running for a project right now, if any. Two loads of one
 * project at once — React's dev double-mount, two tabs, the board's resync
 * beside an agent's read — used to run two full computes of the same thing.
 */
const inFlight = new Map<string, Promise<ComputedStudioLoad>>()
onLoadedProjectEvicted((key) => memo.delete(key))

function isStillValid(entry: MemoEntry, project: LoadedProject, computation: StudioLoadComputation): boolean {
  return (
    projectInputsUnchanged(entry.inputs, project) &&
    stampsUnchanged(entry.dependencies) &&
    computation.routeListing() === entry.routeListing
  )
}

/**
 * `dir`'s FULL load result — the memoized one when every rule in this
 * module's doc holds, otherwise freshly computed (and memoized when it can
 * be). The SHARED object: callers must not mutate it (see this module's doc).
 */
export async function memoizedStudioLoad(dir: string, computation: StudioLoadComputation): Promise<StudioLoadResult> {
  const key = resolve(dir)
  const { project, release } = retainLoadedProject(key)
  try {
    // A load of this project already computing is WAITED FOR, then judged by
    // the same rules as any memo entry — never handed over as-is. It began
    // before this call, so a change since then must still force a compute of
    // our own; the loop re-checks after every wait for that reason.
    for (;;) {
      await project.changes.settle()
      const entry = memo.get(key)
      if (entry && isStillValid(entry, project, computation)) return entry.result
      const running = inFlight.get(key)
      if (!running) break
      await running.then(ignoreOutcome, ignoreOutcome)
    }

    // Synchronous from the check above to `inFlight.set`, so a second caller
    // cannot also find nothing running and start a second compute.
    const inputs = markProjectInputs(project)
    const routeListing = computation.routeListing()
    const run = computation.compute()
    inFlight.set(key, run)
    try {
      const { result, dependencies } = await run
      if (dependencies) memo.set(key, { inputs, routeListing, dependencies, result })
      else memo.delete(key)
      return result
    } finally {
      if (inFlight.get(key) === run) inFlight.delete(key)
    }
  } finally {
    release()
  }
}

/** A waiter only needs the compute to be over; its own outcome is decided by the memo check that follows. */
function ignoreOutcome(): void {}

/** Test-only: drop every memoized load so a test does not leak state into the next one. */
export function clearStudioLoadMemo(): void {
  memo.clear()
  inFlight.clear()
}

/** Test/diagnostic only: whether `dir` has a memoized load at all (valid or not). */
export function hasMemoizedStudioLoad(dir: string): boolean {
  return memo.has(resolve(dir))
}
