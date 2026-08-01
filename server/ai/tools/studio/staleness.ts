/**
 * The staleness rule (WS-12 §2.2) — "the harness's single most important
 * job". `studio_apply_edits`/`studio_codemod` return `shifted: true` when a
 * write changes a file's line count, which means every node id captured
 * before that call is now wrong.
 *
 * **Why this tracks file mtime, not `shifted: true` directly.** Under H2
 * (the CLI owns the loop), the model's tool calls happen entirely INSIDE the
 * spawned `claude` subprocess via MCP — `claudeCliEvents.ts` only ever emits
 * `text`/`context`/`usage`/`error`/`done` (confirmed by reading its full
 * switch), never `toolCall`/`toolResult`. Studio's server genuinely cannot
 * observe a `shifted: true` result mid-turn; the CLI's own context already
 * has it (the tool result is returned directly into the model's context, so
 * the model needs no help noticing a shift THAT JUST HAPPENED — the prompt's
 * own absolute rule governs that). What the server CAN observe, cheaply and
 * from outside the subprocess entirely, is whether the active page's SOURCE
 * FILE changed since the last turn it looked — the externally-visible effect
 * of exactly the write that would have returned `shifted: true` (and also of
 * writes that didn't shift, and of a human editing the file directly — a
 * superset of "you need to re-read", never a subset. The rule is "warn too
 * often" not "warn too rarely" for this specific failure mode, by design.
 *
 * A fresh server process (or a conversation this tracker has never seen
 * before) has nothing to compare against, so the FIRST turn touching a page
 * never warns — there is genuinely nothing stale yet.
 */
import { statSync } from 'node:fs'

interface StalenessEntry {
  readonly file: string
  readonly mtimeMs: number
}

export interface StalenessTracker {
  /**
   * Record this turn's active page file for `conversationId`, and report
   * whether the PREVIOUS turn's recorded mtime for the SAME file differs
   * from the current one — i.e. whether a write landed since last look.
   * Never throws: a missing/unreadable file reports `false` (nothing to warn
   * about — the file can't be read either way) rather than crashing prompt
   * assembly over a filesystem race.
   */
  checkAndRecord(conversationId: string, activePageFile: string): boolean
}

/** Test seam — a fresh tracker per test avoids the exact cross-test module-state pollution `claudeCli.test.ts`'s roster tests hit (see its own doc comment). Production code uses the single shared instance below. */
export function createStalenessTracker(statSyncFn: typeof statSync = statSync): StalenessTracker {
  const lastSeen = new Map<string, StalenessEntry>()
  return {
    checkAndRecord(conversationId, activePageFile) {
      let mtimeMs: number
      try {
        mtimeMs = statSyncFn(activePageFile).mtimeMs
      } catch {
        return false
      }
      const prev = lastSeen.get(conversationId)
      lastSeen.set(conversationId, { file: activePageFile, mtimeMs })
      if (!prev || prev.file !== activePageFile) return false
      return prev.mtimeMs !== mtimeMs
    },
  }
}

/** The one production tracker — process-lifetime, per conversation. Cleared implicitly on server restart, which is the correct "nothing stale yet" state for every conversation. */
export const studioSnapshotStaleness: StalenessTracker = createStalenessTracker()

/** The literal warning line the dynamic suffix carries when `checkAndRecord` reports a change — WS-12 §2.2 point 3's exact wording. */
export const STALE_NODE_IDS_WARNING =
  '⚠ node ids re-issued since your last turn on this page — every id you captured before is stale; re-read before editing.'
