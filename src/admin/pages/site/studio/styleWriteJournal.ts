/**
 * styleWriteJournal — ⌘Z for a style write that landed as an override or an
 * expanded shorthand (G-5) takes the file back BYTE FOR BYTE.
 *
 * ## Why the value-level undo is not enough
 *
 * A style edit is undone by replaying the history entry's patches, which put
 * the PREVIOUS VALUE back: `padding: 20px 10px` + top 30 landed as an appended
 * `padding-top: 30px`, and "set it back" writes `padding-top: 20px` — a line the
 * file never had. The server already journals exactly those landings
 * (`styleLandingNeedsJournal`); the chip's Undo posts the token as a `restore`.
 * This module is the same token on the keyboard: the entry the edit pushed
 * becomes a journaled source gesture, and ⌘Z / ⇧⌘Z take the ordinary structural
 * path (`structuralSourceHistory.ts`) — undo is the `restore`, redo re-posts the
 * batch.
 *
 * ## Which entry
 *
 * The save is planned from the document, not from a history entry, so the entry
 * is inferred, and only when the inference is certain: `claimNewStyleHistoryEntry`
 * runs at the start of every save and answers with the top entry only if it is
 * the ONE entry pushed since the previous save. Several entries in one batch (a
 * drag plus a typed value) share one token that would take all of them back, so
 * they keep the value-level undo — as does an entry a later edit coalesced
 * into, which `journalStyleWrite` detects by identity.
 */
import { styleLandingNeedsJournal, type StyleLanding } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { HistoryEntry } from '@site/store/slices/site/types'
import { restoreEdit, type StructuralEditPayload } from './structuralUndoPlan'

export interface StyleHistoryTarget {
  index: number
  entry: HistoryEntry
}

/** Entries an earlier save already accounted for (held weakly: an evicted entry just goes away). */
const accounted = new WeakSet<HistoryEntry>()

/**
 * The entry this save belongs to, or `null` when it is not exactly one. Marks
 * every entry above the last accounted one as accounted, so the next save
 * starts from here.
 */
export function claimNewStyleHistoryEntry(past: readonly HistoryEntry[]): StyleHistoryTarget | null {
  let fresh = 0
  for (let i = past.length - 1; i >= 0; i -= 1) {
    const entry = past[i]!
    if (accounted.has(entry)) break
    accounted.add(entry)
    // A structural or board entry was written by its own commit, never by this save.
    if (entry.structural === undefined && entry.board === undefined) fresh += 1
  }
  const top = past[past.length - 1]
  if (fresh !== 1 || top === undefined || top.structural !== undefined || top.board !== undefined) return null
  return { index: past.length - 1, entry: top }
}

/** After the save landed: make the claimed entry a journaled one when a landing needs it. */
export function journalStyleBatch(
  target: StyleHistoryTarget | null,
  landings: readonly StyleLanding[],
  edits: readonly StructuralEditPayload[],
  undoToken: string | undefined,
): void {
  if (target === null || undoToken === undefined) return
  if (!landings.some((landing) => styleLandingNeedsJournal(landing.rung))) return
  const store = useEditorStore.getState()
  store.journalStyleWrite(target, {
    label: 'Style change',
    forward: edits.map((edit) => ({ ...edit })),
    inverseTemplate: { kind: 'restore-journal' },
    inverse: [restoreEdit(undoToken)],
  })
  // Tagging replaced the entry object; the replacement is this save's, not a new edit's.
  const tagged = useEditorStore.getState()._historyPast[target.index]
  if (tagged !== undefined) accounted.add(tagged)
}
