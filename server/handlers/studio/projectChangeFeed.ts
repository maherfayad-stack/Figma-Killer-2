/**
 * projectChangeFeed — the load path's subscription to `projectWatch.ts`: which
 * files changed since a given moment, as a journal the load's caches read at
 * their own pace (P6-B, PERF-8).
 *
 * Before this, "did anything change since I last looked" was answered by
 * walking and statting the whole project — twice per load (`studioLoadMemo`'s
 * fingerprint, then `workspaceProject`'s sync), on the server's event loop,
 * on every load, including the resync after every canvas gesture. P1-D's
 * watcher already knows the answer; this is the adapter that lets the load
 * ask it.
 *
 * ## How a consumer uses it
 *
 * `cursor()` before the work, `changesSince(cursor)` the next time: the set of
 * workspace-relative paths the watcher reported in between, EVERY origin —
 * Studio's own writes first of all. `null` means "unknown": the watch failed
 * or overflowed at some point, or the journal no longer reaches back that far.
 * A consumer must treat `null` as "anything may have changed" and verify the
 * slow way. After an overflow the feed never trusts its watcher again — P1-D's
 * rule — so every later answer is `null` too.
 *
 * ## `settle()` — the watcher is a debounce; a load cannot wait for one
 *
 * An event takes a moment to arrive and {@link QUIET_MS} more to be reported.
 * `settle()` closes that gap from the reader's side before any answer is
 * read: it lets two turns of the event loop pass (measured on Windows under
 * Bun 1.3: a write's event is delivered after the SECOND `setImmediate`, 50
 * out of 50 times), then has `projectWatch.ts` re-walk at once when an event
 * is pending, when Studio wrote after the last walk, or when that walk is
 * older than {@link MAX_SNAPSHOT_AGE_MS}. The last is the backstop for an
 * event the OS dropped outright; it bounds how long such a change can go
 * unseen rather than pretending it cannot happen. It is also why no
 * consumer serves a PAGE on this feed's word alone — see `studioLoadMemo.ts`
 * and `pageParseCache.ts` for what each re-verifies itself.
 */
import { settleProjectChanges, subscribeProjectChanges, type ProjectChangeBatch } from './projectWatch'

/** How old the watcher's snapshot may be before a settle re-walks regardless — see this module's doc. */
export const MAX_SNAPSHOT_AGE_MS = 10_000

/** Batches kept. A consumer further behind than this reads `null` and verifies the slow way. */
const JOURNAL_LENGTH = 256

interface JournalEntry {
  seq: number
  rels: readonly string[]
}

export class ProjectChangeFeed {
  private seq = 0
  private readonly journal: JournalEntry[] = []
  /** Set once the watch has failed or overflowed; never cleared — see this module's doc. */
  private untrustedSince: number | null = null
  private readonly unsubscribe: () => void
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    this.unsubscribe = subscribeProjectChanges(dir, (batch) => this.record(batch))
  }

  private record(batch: ProjectChangeBatch): void {
    this.seq += 1
    if (batch.overflow) this.untrustedSince ??= this.seq
    this.journal.push({ seq: this.seq, rels: batch.changes.map((change) => change.rel) })
    if (this.journal.length > JOURNAL_LENGTH) this.journal.shift()
  }

  /** Waits for in-flight events, then makes the watcher report anything it has not yet. See this module's doc. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    if (!settleProjectChanges(this.dir, { maxSnapshotAgeMs: MAX_SNAPSHOT_AGE_MS })) this.untrustedSince ??= this.seq + 1
  }

  /** The position a later {@link changesSince} counts from. */
  cursor(): number {
    return this.seq
  }

  /** Every path reported after `cursor`, or `null` when that cannot be known. */
  changesSince(cursor: number): ReadonlySet<string> | null {
    if (this.untrustedSince !== null) return null
    if (cursor === this.seq) return new Set()
    const oldest = this.journal[0]
    if (!oldest || oldest.seq > cursor + 1) return null
    const rels = new Set<string>()
    for (const entry of this.journal) {
      if (entry.seq > cursor) for (const rel of entry.rels) rels.add(rel)
    }
    return rels
  }

  close(): void {
    this.unsubscribe()
  }
}
