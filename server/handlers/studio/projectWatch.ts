/**
 * projectWatch — one debounced file watcher per open project, and the ONE
 * place Studio learns that a project's files changed on disk (P1-D, closes
 * ERR-19's detection half).
 *
 * Before this, nothing watched the files. The board re-read a file only after
 * Studio's own writes and the agent's MCP writes, so an edit made in VS Code,
 * a `git pull`, or the Claude CLI's own Edit tool left the canvas showing the
 * old file — and every `line:col` id it held below the change named a
 * different element (WB-1).
 *
 * ## What a subscriber gets
 *
 * Batches of {@link ProjectChange}: a workspace-relative POSIX file path,
 * whether it still exists, and WHO changed it — `studio` or `outside`. Every
 * change is reported, Studio's own included, with the origin attached rather
 * than the studio ones filtered out, because the two consumers want opposite
 * things:
 *
 *   - the board's live reload (`server/ai/mcp/outsideEditReload.ts`) acts only
 *     on `outside` changes — Studio's own writes are already followed by the
 *     writer's own resync, and a second reload would race it;
 *   - PERF-8's `/load` invalidation (P6-B, `projectChangeFeed.ts`) needs EVERY change, its own
 *     writes first of all, to drop a memoised load without walking and
 *     statting the whole tree on every load.
 *
 * `overflow: true` means the watch itself failed (the directory went away, the
 * OS refused the handle) and later changes may go unseen. A subscriber must
 * treat it as "everything may have changed" and should not rely on this
 * watcher for that project any more.
 *
 * ## An event is a hint; the snapshot is the truth
 *
 * `fs.watch` is not a reliable list of what changed. Measured on Windows under
 * Bun 1.3: a burst of four writes across three directories delivered TWO
 * events — `pages` and `src`, directory names — and none of the four files;
 * modifying one existing file delivered only its parent directory. Other
 * platforms send duplicates, and temp-file names around an editor's atomic
 * save. So no event is trusted to NAME anything. Each one only says "look",
 * and looking means comparing a snapshot of every watched file's
 * `size:mtime` with the one taken before. A burst costs one walk of the
 * project's own files (excluded directories are never entered) —
 * {@link QUIET_MS} after its last event, and never later than
 * {@link MAX_BATCH_WAIT_MS} after its first.
 *
 * ## Who changed it
 *
 * Studio's writes all run inside the project write lock, and the lock keeps a
 * record of its holds (`projectWriteLock.ts`'s `studioWriteSessionCovers`). A
 * change is Studio's when the file's `mtime` — stamped when the bytes landed,
 * not when anyone noticed — falls inside one of them. A deleted file has no
 * `mtime`, so the moment the burst began is used instead, with a wider slack.
 * Being wrong costs little either way: see that function's doc.
 *
 * ## What is never reported
 *
 *   - anything under `EXCLUDED_WORKSPACE_DIR_NAMES` (`.studio`, `.git`,
 *     `node_modules`, `dist`, `.next`, `.turbo`) at any depth — with ONE
 *     exception, `.studio/canvas/` at the project root: the free canvas keeps
 *     its layer modules there, and an outside edit to one must reload it
 *     (`docs/audits/2026-09-23-studio-audit/10-free-canvas.md` §6.3 and §10);
 *   - editor and tool scratch files (`.swp`, `~`, `.#lock`, JetBrains'
 *     `___jb_tmp___`, vim's `4913` probe, `.crswap`, `.DS_Store`), which come
 *     and go around every save and are never app source;
 *   - symlinks, which are never followed — the same rule every workspace walk
 *     keeps, so nothing outside the project is ever statted.
 *
 * ## Windows, macOS, Linux
 *
 * `fs.watch` recursive is one native handle on Windows and macOS. On Linux it
 * is emulated with one inotify watch per directory — `node_modules` included,
 * which exhausts the inotify limit on a real project — so there each watched
 * directory gets its own non-recursive handle, and the set is reconciled with
 * the snapshot's directories after every walk.
 *
 * One OS watcher per project however many subscribe; the last unsubscribe
 * closes it. Keyed by the project's REAL path, like the write lock, so a
 * symlinked spelling of the same project shares one watcher.
 */
import { CANVAS_LAYER_DIR } from '@core/studio-board'
import { existsSync, readdirSync, realpathSync, statSync, watch, type Dirent, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { EXCLUDED_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { studioWriteSessionCovers, studioWroteSince } from './projectWriteLock'

export type ProjectChangeOrigin = 'studio' | 'outside'

export interface ProjectChange {
  /** Workspace-relative, `/`-separated file path. */
  rel: string
  /** `false` when the file is gone (deleted, or renamed away). */
  exists: boolean
  origin: ProjectChangeOrigin
}

export interface ProjectChangeBatch {
  changes: ProjectChange[]
  /** The watch failed — see this module's doc. */
  overflow: boolean
}

export type ProjectChangeListener = (batch: ProjectChangeBatch) => void

/** A burst is looked at this long after its last event. */
export const QUIET_MS = 150
/** …and never later than this after its first, however long it runs. */
export const MAX_BATCH_WAIT_MS = 1_000

/** Slack around a write session for a file whose `mtime` is known — clock granularity only. */
const MTIME_SLACK_MS = 50
/** Slack for a deleted file, judged by when its burst began — which trails the delete by the delivery delay. */
const BURST_START_SLACK_MS = 500

/** Past this many files the snapshot stops growing and the batch reports `overflow` — a tree that size is not one app. */
const MAX_SNAPSHOT_FILES = 20_000

/** How the tree is watched. `auto` picks by platform — see this module's doc; tests force either. */
export type ProjectWatchStrategy = 'auto' | 'recursive' | 'per-directory'

const SCRATCH_FILE = /(\.sw[a-p]x?$)|(~$)|(^\.#)|(___jb_(tmp|old)___$)|(^4913$)|(\.crswap$)|(^\.DS_Store$)/i

/** The one directory under an excluded one that is still app content (P5-G — spelled once, in `@core/studio-board`). */
const STUDIO_CANVAS_DIR = CANVAS_LAYER_DIR

/** Whether a change to the FILE at `rel` is reported at all — see this module's doc. */
export function isWatchedProjectPath(rel: string): boolean {
  if (rel === '') return false
  const segments = rel.split('/')
  if (SCRATCH_FILE.test(segments[segments.length - 1]!)) return false
  const underCanvas = rel.startsWith(`${STUDIO_CANVAS_DIR}/`)
  return !segments.slice(underCanvas ? 2 : 0, -1).some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))
}

/** Whether the walk enters the DIRECTORY at `rel`. `.studio` is entered only to reach `.studio/canvas`. */
function isWalkedDirectory(rel: string): boolean {
  if (rel === '.studio' || rel === STUDIO_CANVAS_DIR) return true
  const underCanvas = rel.startsWith(`${STUDIO_CANVAS_DIR}/`)
  return !rel
    .split('/')
    .slice(underCanvas ? 2 : 0)
    .some((segment) => EXCLUDED_WORKSPACE_DIR_NAMES.has(segment))
}

interface Snapshot {
  /** File rel → `size:mtimeMs`. */
  files: Map<string, string>
  /** File rel → mtimeMs, for attributing a change. */
  mtimes: Map<string, number>
  /** Every walked directory rel, `''` for the root. */
  dirs: Set<string>
  truncated: boolean
}

function scan(root: string): Snapshot {
  const snapshot: Snapshot = { files: new Map(), mtimes: new Map(), dirs: new Set(), truncated: false }
  const walk = (rel: string): void => {
    snapshot.dirs.add(rel)
    let entries: Dirent[]
    try {
      entries = readdirSync(rel === '' ? root : join(root, ...rel.split('/')), { withFileTypes: true })
    } catch (_err) {
      return // vanished mid-walk — its files simply read as gone
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (isWalkedDirectory(childRel)) walk(childRel)
        continue
      }
      if (!entry.isFile() || !isWatchedProjectPath(childRel)) continue
      if (snapshot.files.size >= MAX_SNAPSHOT_FILES) {
        snapshot.truncated = true
        return
      }
      try {
        const stat = statSync(join(root, ...childRel.split('/')))
        snapshot.files.set(childRel, `${stat.size}:${stat.mtimeMs}`)
        snapshot.mtimes.set(childRel, stat.mtimeMs)
      } catch (_err) {
        // Deleted between the listing and the stat: absent from this snapshot.
      }
    }
  }
  walk('')
  return snapshot
}

interface ProjectWatch {
  root: string
  listeners: Set<ProjectChangeListener>
  snapshot: Snapshot
  /** Wall-clock ms at which {@link snapshot}'s walk BEGAN — anything written after it may be missing from it. */
  scannedAt: number
  /** Reconcile the OS handles with the directories the last walk found (per-directory strategy only). */
  reconcile: (dirs: ReadonlySet<string>) => void
  close: () => void
  overflow: boolean
  burstStartedAt: number | null
  timer: ReturnType<typeof setTimeout> | null
}

const watches = new Map<string, ProjectWatch>()

/**
 * `resolve(dir)` → the real root its watch was started on, while subscribed.
 * `settleProjectChanges` runs before every load (P6-B's memo), and a
 * `realpathSync` there was a third of a warm load's own work on Windows.
 */
const rootByDir = new Map<string, string>()

function realRoot(dir: string): string {
  const resolved = resolve(dir)
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved
  } catch (_err) {
    return resolved // unreadable — watching it will fail and report overflow
  }
}

function diff(pw: ProjectWatch, before: Snapshot, after: Snapshot, burstStartedAt: number): ProjectChange[] {
  const changes: ProjectChange[] = []
  for (const [rel, signature] of after.files) {
    if (before.files.get(rel) === signature) continue
    const mtime = after.mtimes.get(rel)!
    changes.push({ rel, exists: true, origin: studioWriteSessionCovers(pw.root, mtime, MTIME_SLACK_MS) ? 'studio' : 'outside' })
  }
  for (const rel of before.files.keys()) {
    if (after.files.has(rel)) continue
    const origin = studioWriteSessionCovers(pw.root, burstStartedAt, BURST_START_SLACK_MS) ? 'studio' : 'outside'
    changes.push({ rel, exists: false, origin })
  }
  return changes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

function flush(pw: ProjectWatch): void {
  if (pw.timer) clearTimeout(pw.timer)
  pw.timer = null
  const burstStartedAt = pw.burstStartedAt ?? Date.now()
  pw.burstStartedAt = null
  const scannedAt = Date.now()
  const next = scan(pw.root)
  const changes = diff(pw, pw.snapshot, next, burstStartedAt)
  pw.snapshot = next
  pw.scannedAt = scannedAt
  pw.reconcile(next.dirs)
  const overflow = pw.overflow || next.truncated
  pw.overflow = false
  if (changes.length === 0 && !overflow) return
  const batch: ProjectChangeBatch = { changes, overflow }
  for (const listener of [...pw.listeners]) {
    try {
      listener(batch)
    } catch (err) {
      console.error('[studio:projectWatch]', err)
    }
  }
}

/** Something happened somewhere under the project — look soon. See this module's doc for why the event's own path is not trusted. */
function noteEvent(pw: ProjectWatch): void {
  const now = Date.now()
  pw.burstStartedAt ??= now
  if (pw.timer) clearTimeout(pw.timer)
  const wait = Math.max(0, Math.min(QUIET_MS, pw.burstStartedAt + MAX_BATCH_WAIT_MS - now))
  pw.timer = setTimeout(() => flush(pw), wait)
}

function noteFailure(pw: ProjectWatch, err: unknown): void {
  console.error('[studio:projectWatch] watch failed; reporting an unknown change:', err)
  pw.overflow = true
  noteEvent(pw)
}

/** Windows/macOS: one native recursive handle. */
function watchRecursive(pw: ProjectWatch): void {
  const watcher = watch(pw.root, { recursive: true }, () => noteEvent(pw))
  watcher.on('error', (err) => noteFailure(pw, err))
  pw.close = () => watcher.close()
}

/** Linux: one non-recursive handle per walked directory, kept in step with the snapshot. */
function watchPerDirectory(pw: ProjectWatch): void {
  const watchers = new Map<string, FSWatcher>()
  const open = (rel: string): void => {
    try {
      const watcher = watch(rel === '' ? pw.root : join(pw.root, ...rel.split('/')), () => noteEvent(pw))
      watcher.on('error', (err) => {
        watcher.close()
        watchers.delete(rel)
        if (rel === '') noteFailure(pw, err)
        else noteEvent(pw) // a subdirectory went away: the next walk says what with
      })
      watchers.set(rel, watcher)
    } catch (err) {
      if (rel === '') noteFailure(pw, err)
    }
  }
  pw.reconcile = (dirs) => {
    for (const [rel, watcher] of watchers) {
      if (dirs.has(rel)) continue
      watcher.close()
      watchers.delete(rel)
    }
    // A directory that appeared since the last walk: its files are already in
    // this walk's snapshot (and so in this batch), and from now on it is
    // watched itself.
    for (const rel of dirs) if (!watchers.has(rel)) open(rel)
  }
  pw.close = () => {
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }
  pw.reconcile(pw.snapshot.dirs)
}

function startWatch(root: string, strategy: ProjectWatchStrategy): ProjectWatch {
  const scannedAt = Date.now()
  const pw: ProjectWatch = {
    root,
    listeners: new Set(),
    snapshot: scan(root),
    scannedAt,
    reconcile: () => {},
    close: () => {},
    overflow: false,
    burstStartedAt: null,
    timer: null,
  }
  try {
    if (strategy === 'per-directory' || (strategy === 'auto' && process.platform === 'linux')) watchPerDirectory(pw)
    else watchRecursive(pw)
  } catch (err) {
    noteFailure(pw, err)
  }
  return pw
}

/**
 * Hear about every change under `dir` until the returned function is called.
 * The first subscriber starts the project's one watcher (and walks the tree
 * once for its snapshot); the last one to leave closes it. `dir` must already
 * be a validated project directory — this watches a path, it does not vouch
 * for one.
 */
export function subscribeProjectChanges(
  dir: string,
  listener: ProjectChangeListener,
  options: { strategy?: ProjectWatchStrategy } = {},
): () => void {
  const root = realRoot(dir)
  let pw = watches.get(root)
  if (!pw) {
    pw = startWatch(root, options.strategy ?? 'auto')
    watches.set(root, pw)
  }
  rootByDir.set(resolve(dir), root)
  pw.listeners.add(listener)
  const owned = pw
  let subscribed = true
  return () => {
    if (!subscribed) return
    subscribed = false
    owned.listeners.delete(listener)
    if (owned.listeners.size > 0) return
    if (owned.timer) clearTimeout(owned.timer)
    owned.close()
    if (watches.get(root) === owned) watches.delete(root)
    for (const [key, value] of rootByDir) if (value === root) rootByDir.delete(key)
  }
}

/**
 * Bring every subscriber of `dir`'s watcher up to date NOW, synchronously,
 * when the snapshot may not reflect the disk — so a caller about to trust
 * "no batch arrived, so nothing changed" (the `/load` memo, P6-B) is not
 * trusting a debounce. The snapshot is re-walked, and the resulting batch
 * delivered to every listener before this returns, when:
 *
 *   - a burst is pending (an event arrived and its {@link QUIET_MS} have not
 *     run out), or the watch failed and has not reported it yet;
 *   - Studio held a write session that ended after the last walk began
 *     (`projectWriteLock.ts`'s `studioWroteSince`) — a save is followed by the
 *     board's own resync sooner than the debounce would report the save;
 *   - the last walk is older than `maxSnapshotAgeMs` — the backstop for an
 *     event `fs.watch` dropped outright, which bounds how long such a change
 *     can go unseen.
 *
 * Returns `false` when `dir` has no watcher at all, so the caller knows it
 * has nothing to trust.
 */
export function settleProjectChanges(dir: string, options: { maxSnapshotAgeMs: number }): boolean {
  const pw = watches.get(rootByDir.get(resolve(dir)) ?? realRoot(dir))
  if (!pw) return false
  const stale =
    pw.timer !== null ||
    pw.overflow ||
    studioWroteSince(pw.root, pw.scannedAt) ||
    Date.now() - pw.scannedAt > options.maxSnapshotAgeMs
  if (stale) flush(pw)
  return true
}

/** Whether `dir` has a live watcher. Test/diagnostic only. */
export function isProjectWatched(dir: string): boolean {
  return watches.has(realRoot(dir))
}
