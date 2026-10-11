/**
 * historyTypes — what ONE undoable transaction is, in all three of the
 * shapes the editor has to be able to undo.
 *
 * Split out of `types.ts` when that file passed the 700-line ceiling. The
 * seam is real rather than arbitrary: everything here answers "what is on
 * the undo stack", which is read by `historyStack.ts`, `boardHistory.ts`,
 * `structuralHistory.ts`, `historyPreservation.ts` and `undoRedoActions.ts`
 * and is independent of `SiteSlice`, the store surface that happens to hold
 * the stack.
 *
 * `types.ts` re-exports all of it, so every existing import keeps working
 * and the slice still has one front door.
 */
import type { Patches } from 'mutative'
import type { BoardsFile } from '@core/studio-board'
import type { StructuralSourceGesture } from '@site/studio/structuralUndoPlan'
import type { PrototypeOp } from '@site/studio/prototypeApi'

/**
 * One undoable transaction, stored as Mutative patch pairs scoped to the
 * SiteDocument (paths are relative to `site`, e.g. `['pages', 0, 'nodes', …]`).
 *
 * - `inverse` reverts the transaction (applied on undo).
 * - `forward` re-applies it (applied on redo).
 * - `coalesceKey` carries the in-progress input-burst identity so consecutive
 *   per-keystroke edits fold into a single entry (see `commitHistoryEntry`).
 *
 * An entry may ALSO (or instead) carry `board` — the board domain's state pair
 * (`store-09`). One stack, two domains: ⌘Z undoes the last thing the user did,
 * whether it lived in the `.tsx` or in `.studio/boards.json`.
 */
export interface HistoryEntry {
  inverse: Patches
  forward: Patches
  coalesceKey: string | null
  /**
   * `store-08` — present only when this transaction also WROTE STRUCTURE to
   * the user's source. Undo/redo must then re-issue the gesture rather than
   * replay `inverse`/`forward`: `saveSite` diffs node VALUES and has no notion
   * of parent or order (see `structuralSourceEdits.ts`'s header), so a
   * patch-only undo moves the element on the canvas, leaves the `.tsx` saying
   * the opposite, and the next reparse silently wins.
   */
  structural?: StructuralHistory
  /**
   * `store-09` — present when this transaction changed BOARD state (frames,
   * sticky notes, doc cards, guides, board CRUD). See `BoardHistory`.
   */
  board?: BoardHistory
  /**
   * Present when this transaction wrote the prototype links
   * (`.studio/prototype.json`). See `PrototypeHistory`.
   */
  prototype?: PrototypeHistory
  /**
   * ERR-6 — present only while the structural write this entry stands for is
   * still on the wire: the gesture's own write (`'gesture'`), or the write an
   * undo/redo just re-issued for it (`'undo'`/`'redo'`). It is how the write's
   * answer finds THIS entry again once it arrives, wherever the stack has put
   * it by then (a reload re-addresses entries by copying them, so identity is
   * no use). `structuralCommitRollback.ts` sets it, and removes it when the
   * write lands or is taken back.
   */
  pendingCommit?: PendingStructuralCommit
  /**
   * P3-D (OD-7) — this entry and the one directly ABOVE it are one gesture: a
   * `detach` made so a structural gesture inside a shared component applies
   * to this instance only, and that gesture. ⌘Z on the one above carries on
   * to this one; ⌘⇧Z on this one carries on to the one above
   * (`undoRedoActions.ts`). Set only once the gesture above has landed
   * (`instanceOnlyGesture.ts`), so an unrelated entry is never pulled in.
   */
  linkedToNext?: true
}

/** See `HistoryEntry.pendingCommit`. */
export interface PendingStructuralCommit {
  id: number
  /** Which write is in flight: the gesture itself, or an undo/redo re-issuing it. Decides where a failed write leaves the entry. */
  step: 'gesture' | 'undo' | 'redo'
}

/**
 * The board-domain fields one transaction changed, before and after.
 *
 * SNAPSHOT PAIRS, NOT PATCHES — and deliberately so. Every board mutation is a
 * pure `Board -> Board` transform re-published through `upsertBoard`, so
 * `boards` is already a persistent immutable structure: a "snapshot" is two
 * object references that share everything the mutation did not touch. Storing
 * them is O(1), restoring them is O(1), and there is no patch path to go stale
 * when a board index shifts. Patches buy nothing here that structural sharing
 * has not already bought.
 *
 * Correctness rests on undo being strictly LIFO: the stack is only ever read
 * from the top, so the state at the moment of undo is exactly this entry's
 * `after`, and assigning `before` is exact rather than approximate. The one
 * way that can break is a board mutation that does NOT go through the history
 * stack (a fresh `.studio/boards.json` read) — which is why `loadBoards` and
 * `markBoardsLoadFailed` purge board entries outright. See `boardHistory.ts`.
 *
 * `activeBoardId` rides along because `addBoard`/`removeBoard` change it in
 * the same gesture, and undoing "create board" without returning to the board
 * you were on leaves you staring at a board you did not choose.
 */
export interface BoardHistorySnapshot {
  boards: BoardsFile
  activeBoardId: string | null
}

export interface BoardHistory {
  before: BoardHistorySnapshot
  after: BoardHistorySnapshot
}

/**
 * A prototype-link write, as the two server operations that take it back and
 * put it again. Operations, not snapshots: the links file is written by link
 * (`prototypeStore.ts`), so removing the link a gesture added restores the
 * file's bytes exactly, and nothing the gesture did not touch is rewritten.
 * Replaying an op is a request, which is why undo of one is asynchronous.
 */
export interface PrototypeHistory {
  undo: PrototypeOp
  redo: PrototypeOp
}

/**
 * What undo/redo has to re-issue for a structural transaction: always a
 * source-writing gesture, whose undo is a WRITE (`structuralSourceHistory.ts`).
 *
 * That includes the ones that mutate the tree eagerly for a same-tick preview —
 * `delete`, and a same-file move or reorder (single or sequence). Their tree
 * mutation's own patches are never replayed; the entry is tagged with the
 * gesture instead (`structuralHistory.ts`), and its ⌘Z is the undo journal's
 * `restore` (P3-F), resolved the identical way every other `source` gesture's
 * inverse is. A move used to re-issue `moveNodes` instead, which put the
 * element back by position and so could not restore a blank line or an
 * indentation the move had changed.
 */
export type StructuralHistory = StructuralSourceHistory

/**
 * `store-14` — a gesture that wrote the user's markup and mutated NO tree:
 * insert, duplicate, wrap, group, ungroup, paste, cross-frame transplant, the
 * `<img>` an OS file drop becomes.
 *
 * These never reached the stack before, so ⌘Z after one of them undid whatever
 * came before it. The entry carries no patches at all — there is nothing in
 * `site` to replay, because the document that changed is the `.tsx` — only the
 * gesture's own forward edits and the inverse resolved against what the write
 * reported making. `structuralSourceHistory.ts` owns both halves.
 */
export interface StructuralSourceHistory {
  gesture: 'source'
  source: StructuralSourceGesture
}
