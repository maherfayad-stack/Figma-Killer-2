/**
 * projectWriteLock — one writer at a time, per project directory.
 *
 * ## The failure this exists to stop
 *
 * Studio mutates a project's working tree from several independent places: a
 * canvas save (`studioWriteback.ts`), a page scaffold (`pageScaffold.ts`), a
 * dependency install (`installDeps.ts`), and every git verb
 * (`gitOperations.ts`). Each one individually is careful. Together they are
 * not, because a git verb is a SEQUENCE of subprocesses with real `await`
 * points between them:
 *
 *   git add -- pages/Home.tsx        ← the file the user ticked
 *   …                                ← a canvas save lands here and rewrites it
 *   git commit -- pages/Home.tsx     ← commits content nobody reviewed
 *
 * Nothing in git or in the writeback prevents that: JavaScript's single thread
 * makes each synchronous writeback atomic, but it happily runs one *between*
 * two awaits of an async git verb. The observable symptoms are a commit whose
 * diff does not match what the panel showed, and — when two git verbs overlap
 * — git's own `index.lock` error surfacing as a 500 with a filesystem path in
 * it.
 *
 * So: every mutation of a project's files takes this lock, and the git verbs
 * hold it across their whole sequence.
 *
 * ## The rules
 *
 * - **Keyed by the REAL path.** `realpathSync` first, so two directories that
 *   are the same project through a symlink share one lock rather than
 *   silently getting two. A path that does not exist yet falls back to the
 *   resolved form — there is nothing to serialize against anyway.
 * - **FIFO.** Ownership is handed directly to the longest-waiting caller on
 *   release, never re-contended. A save queued behind a push does not lose its
 *   place to a save that arrived later.
 * - **Waiting is bounded only if the caller asks.** `waitMs` is undefined by
 *   default, meaning "wait as long as it takes" — that is what a canvas save
 *   wants, because the user's alternative to waiting is losing the edit. A git
 *   verb passes {@link GIT_LOCK_WAIT_MS} and turns the resulting
 *   {@link ProjectWriteLockBusyError} into a `409 { code: 'busy' }`: a person
 *   who clicked Commit would rather read "the project is busy, try again" in
 *   five seconds than watch a spinner for the length of a `bun install`.
 * - **Reentrant.** A locked operation that calls another locked operation runs
 *   it inline instead of deadlocking on itself. The held keys travel with the
 *   async context (`AsyncLocalStorage`), so this works across `await`s and
 *   through subprocess waits — verified, not assumed.
 *
 * ## What deliberately does NOT take it
 *
 * Reads. `git status`, `git diff`, `git log`, and the branch list mutate
 * nothing, and the Version control panel reads status after every action — if
 * a read could answer `busy`, a two-minute `bun install` would turn the whole
 * panel into an error state for two minutes. A read that catches a tree
 * mid-save reports a file as changed a moment early, which is exactly what it
 * is.
 *
 * ## The lock is also how Studio recognises its own writes (P1-D)
 *
 * Every hold of the lock is a WRITE SESSION, and the last minute of them is
 * kept per project ({@link studioWriteSessionCovers}). `projectWatch.ts`'s
 * file watcher asks whether a changed file's `mtime` falls inside one: if it
 * does, Studio wrote that file and the board already knows; if not, someone
 * else did (VS Code, `git pull`, the agent's own Edit tool) and the board has
 * to re-read it. A file's `mtime` is stamped when the bytes land, so the
 * answer does not depend on when the OS delivers the watch event — which is
 * always AFTER a synchronous save has released the lock, so "is it locked
 * right now?" could never answer the question.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * How long a git verb waits for another writer before reporting `busy`.
 *
 * Five seconds is chosen against what is actually holding the lock: a canvas
 * save is tens of milliseconds, so a real save is never long enough to trip
 * this — only a dependency install or another git verb is, and both are
 * things the user would rather be told about than wait behind.
 */
export const GIT_LOCK_WAIT_MS = 5_000

/** Thrown by {@link withProjectWriteLock} when `waitMs` elapses with another writer still holding the lock. Carries no path — callers map it to `409 { code: 'busy' }`. */
export class ProjectWriteLockBusyError extends Error {
  readonly code = 'busy'
  constructor() {
    super('Another change to this project is still being written. Try again in a moment.')
    this.name = 'ProjectWriteLockBusyError'
  }
}

interface Waiter {
  /** Called with ownership already transferred — see `release`. */
  grant: () => void
  /** A waiter whose `waitMs` elapsed. Left in the queue and skipped on release rather than spliced out mid-iteration. */
  cancelled: boolean
}

interface LockEntry {
  locked: boolean
  waiters: Waiter[]
}

const locks = new Map<string, LockEntry>()

/** One hold of the lock; `end` is `null` while it is still held. Wall-clock ms — the clock file `mtime`s are stamped with. */
interface WriteSession {
  start: number
  end: number | null
}

/** How long a finished write session is remembered. A watch event arrives in milliseconds; a minute is generous, and bounds the list. */
const WRITE_SESSION_MEMORY_MS = 60_000

/** Recent and open write sessions, per lock key — see this module's doc. */
const writeSessions = new Map<string, WriteSession[]>()

function openWriteSession(key: string): WriteSession {
  const now = Date.now()
  const kept = (writeSessions.get(key) ?? []).filter((s) => s.end === null || now - s.end <= WRITE_SESSION_MEMORY_MS)
  const session: WriteSession = { start: now, end: null }
  kept.push(session)
  writeSessions.set(key, kept)
  return session
}

/**
 * Keys held by the CURRENT async context. Reentrancy is the difference
 * between `pushCurrentBranch` being able to call `readGitStatus` and the
 * server deadlocking on itself the first time someone clicks Push.
 */
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>()

/** The real path, so a symlinked project cannot acquire a second lock on the same directory. */
function lockKey(dirInput: string): string {
  const resolved = resolve(dirInput)
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved
  } catch {
    return resolved
  }
}

function acquire(key: string, waitMs: number | undefined): Promise<void> {
  let entry = locks.get(key)
  if (!entry) {
    entry = { locked: false, waiters: [] }
    locks.set(key, entry)
  }
  if (!entry.locked) {
    entry.locked = true
    return Promise.resolve()
  }

  const queue = entry.waiters
  return new Promise<void>((grantResolve, grantReject) => {
    const waiter: Waiter = { grant: grantResolve, cancelled: false }
    queue.push(waiter)
    if (waitMs === undefined) return

    // Deliberately NOT `unref`ed: under Bun an unreferenced timer is not
    // guaranteed to fire when it is the only thing the loop is waiting on, and
    // a `busy` answer that never arrives is the exact hang this bound exists
    // to prevent. The timer is bounded by `waitMs` anyway, so it can delay a
    // shutdown by at most that.
    const timer = setTimeout(() => {
      waiter.cancelled = true
      grantReject(new ProjectWriteLockBusyError())
    }, waitMs)
    waiter.grant = () => {
      clearTimeout(timer)
      grantResolve()
    }
  })
}

/** Hands ownership to the next live waiter, or drops the entry entirely when nobody is queued. */
function release(key: string): void {
  const entry = locks.get(key)
  if (!entry) return
  while (entry.waiters.length > 0) {
    const next = entry.waiters.shift()
    if (!next || next.cancelled) continue
    // `locked` stays true: ownership moves straight to this waiter, so a
    // caller that arrives between now and its continuation cannot jump it.
    next.grant()
    return
  }
  entry.locked = false
  locks.delete(key)
}

/**
 * Runs `fn` with exclusive write access to `dir`.
 *
 * Pass `waitMs` to bound the wait — `GIT_LOCK_WAIT_MS` for a git verb, nothing
 * at all for a save. A reentrant call (this async context already holds the
 * lock for the same real path) runs `fn` inline and never waits.
 */
export async function withProjectWriteLock<T>(
  dir: string,
  fn: () => T | Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  const key = lockKey(dir)
  const held = heldKeys.getStore()
  if (held?.has(key)) return fn()

  await acquire(key, options.waitMs)
  const nested = new Set(held ?? [])
  nested.add(key)
  const session = openWriteSession(key)
  try {
    return await heldKeys.run(nested, fn)
  } finally {
    session.end = Date.now()
    release(key)
  }
}

/**
 * Whether Studio was writing to `dir` at wall-clock time `atMs`: inside one of
 * its lock holds, widened by `slackMs` on both sides. `projectWatch.ts` asks
 * this with a changed file's `mtime` (or, for a file that is gone, the moment
 * its event arrived) to tell Studio's own writes from everyone else's — see
 * this module's doc.
 *
 * The slack absorbs clock granularity: on Windows a file's `mtime` reads a
 * millisecond EARLIER than a `Date.now()` taken just before the write. Being
 * wrong is cheap in both directions — a Studio write read as an outside one
 * costs one redundant re-read of the board, and an outside write that lands
 * inside the slack of a Studio write is left to the element identity guard,
 * which still refuses or re-finds any edit aimed at what it moved.
 */
export function studioWriteSessionCovers(dir: string, atMs: number, slackMs: number): boolean {
  const now = Date.now()
  for (const session of writeSessions.get(lockKey(dir)) ?? []) {
    if (atMs >= session.start - slackMs && atMs <= (session.end ?? now) + slackMs) return true
  }
  return false
}

/**
 * Whether Studio has held (or still holds) a write session on the project at
 * `realRoot` that ended at or after wall-clock `sinceMs` — i.e. whether Studio
 * may have written something a scan taken at `sinceMs` did not see.
 * `projectWatch.ts`'s `settleProjectChanges` asks this before a load trusts
 * the watcher's snapshot: a Studio write is followed straight away by the
 * board's own resync, faster than the watcher's debounce would report it
 * (P6-B).
 *
 * `realRoot` must already be the project's real path (the watcher's root —
 * what {@link lockKey} would return). This runs before every load, and the
 * `realpathSync` inside `lockKey` was a quarter of a warm load's memo check.
 */
export function studioWroteSince(realRoot: string, sinceMs: number): boolean {
  for (const session of writeSessions.get(realRoot) ?? []) {
    if (session.end === null || session.end >= sinceMs) return true
  }
  return false
}

/** `true` when someone is currently writing to this project. Test/diagnostic only — never a precondition, because the answer is stale the instant it is read. */
export function isProjectWriteLocked(dir: string): boolean {
  return locks.get(lockKey(dir))?.locked === true
}
