/**
 * boardHistory — `store-09`. Board state is undoable, on the SAME stack as
 * every `site` edit.
 *
 * ## Why this exists
 *
 * Verbatim user report: *"when moving sticky notes, and elements in the canvas
 * and click ctrl + z it doesn't get back to that position"*, against an earlier
 * standing rule: *"it should work on every action"*. `store-08`'s handoff named
 * this exact gap as a deliberate cut — board state (`boardSlice.ts`) lives
 * outside `site`, and `runHistoricMutation` records only `site`-scoped patches,
 * so a frame drag and a note drag produced no history entry at all.
 *
 * There is only one undo stack, because there is only one ⌘Z. An entry records
 * whichever domain(s) its transaction touched (`HistoryEntry.inverse`/`forward`
 * for `site`, `HistoryEntry.board` for board state) and `undo`/`redo` restore
 * whatever the top entry carries. The user does not know — and must not need to
 * know — that a sticky note and a padding value are stored in different files.
 *
 * ## Snapshots, not patches
 *
 * See `BoardHistory` in `site/types.ts` for the full reasoning. Short version:
 * every board mutation is already a pure transform republished via
 * `upsertBoard`, so a before/after pair is two references over a persistent
 * structure — O(1) to store, O(1) to restore, with no patch path that can go
 * stale when a board or frame index shifts.
 *
 * ## Coalescing: one entry per drag
 *
 * A frame drag calls `setFramePosition` on EVERY `pointermove` (and an
 * annotation drag calls `moveNote`/`moveDoc` the same way) — that is real board
 * state the snap guides and the autosave read, so it cannot be deferred to
 * pointer-up. Each tick therefore commits a transaction, and without a
 * coalesce key one drag would cost a hundred undo entries.
 *
 * Every continuous gesture passes a key from {@link boardCoalesceKey} scoped to
 * the ENTITY being dragged, and `historyStack.ts`'s fold keeps the burst's
 * first `before` while advancing `after` — so the whole drag is one entry that
 * undoes to where the frame started. The burst is closed explicitly on
 * pointer-up (`endBoardGesture`), so dragging the same frame twice is two
 * entries rather than one that swallows both.
 *
 * ## Persistence
 *
 * Board state is Studio's own state on disk (`.studio/boards.json`), never the
 * user's `.tsx`. So undo here is plain state replay plus a re-persist: every
 * restore sets `boardsDirty`, which is the same signal the original mutation
 * raised and which `AdminCanvasLayout`'s autosave watches. A restore that
 * SHRINKS the frame set also raises `boardsPendingExplicitRemoval` — undoing an
 * "add frame" is a deliberate removal, and without the flag `boardsSaveGuard`
 * would refuse the save that persists it.
 */
import type { Draft } from 'mutative'
import type { BoardsFile } from '@core/studio-board'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { commitHistoryEntry } from './site/historyStack'
import type { BoardHistorySnapshot, HistoryEntry } from './site/types'

type BoardSet = Parameters<EditorStoreSliceCreator<EditorStore>>[0]
type BoardGet = Parameters<EditorStoreSliceCreator<EditorStore>>[1]

/**
 * Coalesce keys for the board domain, in one place so two gestures can never
 * accidentally share one (which would let a note drag fold into a frame drag)
 * and so a gesture can never accidentally split (a key derived twice with
 * different spellings).
 *
 * Every key is scoped to the ENTITY, not just the gesture: dragging frame A
 * then frame B without an intervening pointer-up (possible with a stylus, or a
 * mis-fired capture) must still be two entries.
 */
export const boardCoalesceKey = {
  frameMove: (frameId: string) => `board:frame-move:${frameId}`,
  frameRect: (frameId: string) => `board:frame-rect:${frameId}`,
  frameNudge: () => 'board:frame-nudge',
  annotationMove: (kind: string, id: string) => `board:annotation-move:${kind}:${id}`,
  annotationResize: (kind: string, id: string) => `board:annotation-resize:${kind}:${id}`,
  annotationNudge: () => 'board:annotation-nudge',
  noteText: (noteId: string) => `board:note-text:${noteId}`,
  docHtml: (docId: string) => `board:doc-html:${docId}`,
  guideMove: (guideId: string) => `board:guide-move:${guideId}`,
} as const

/** Non-undoable board-slice fields a mutation writes in the same `set`. */
export interface BoardCommitExtras {
  /** Board that becomes active as part of THIS transaction (board CRUD). */
  activeBoardId?: string | null
  /** The mutation deliberately removed a frame — see `boardsSaveGuard.ts`. */
  explicitRemoval?: boolean
  /**
   * Editor-local fields the gesture also writes (selection, clipboard, frame
   * defaults). Applied live, NOT recorded — same rule `runHistoricMutation`
   * applies to the editor fields a site recipe touches.
   */
  also?: (state: Draft<EditorStore>) => void
}

/** Every `BoardFrame.id` in a file — the unit `boardsSaveGuard` measures removals in. */
function frameIds(file: BoardsFile): Set<string> {
  const ids = new Set<string>()
  for (const board of file.boards) for (const frame of board.frames) ids.add(frame.id)
  return ids
}

/** True when `next` is missing at least one frame id `prev` had. */
function dropsAFrame(prev: BoardsFile, next: BoardsFile): boolean {
  if (prev === next) return false
  const after = frameIds(next)
  for (const id of frameIds(prev)) if (!after.has(id)) return true
  return false
}

/**
 * Apply one board-domain mutation AND record its undo entry, in a single
 * `set` — the board slice's counterpart to `runHistoricMutation`.
 *
 * `nextBoards` is the already-transformed file (the pure `@core/studio-board`
 * transforms stay exactly where they are; this only owns the store write).
 * Passing the CURRENT file, with no `activeBoardId` change, is a no-op that
 * neither dirties the boards nor pushes an entry — so a transform that
 * declined to change anything still cannot flip `boardsDirty` for nothing.
 */
export function commitBoardChange(
  set: BoardSet,
  get: BoardGet,
  coalesceKey: string | null,
  nextBoards: BoardsFile,
  extras: BoardCommitExtras = {},
): void {
  const current = get()
  const before: BoardHistorySnapshot = {
    boards: current.boards,
    activeBoardId: current.activeBoardId,
  }
  const after: BoardHistorySnapshot = {
    boards: nextBoards,
    activeBoardId: extras.activeBoardId === undefined ? current.activeBoardId : extras.activeBoardId,
  }
  const changed = before.boards !== after.boards || before.activeBoardId !== after.activeBoardId

  set((state) => {
    extras.also?.(state)
    if (!changed) return
    state.boards = after.boards
    state.activeBoardId = after.activeBoardId
    state.boardsDirty = true
    if (extras.explicitRemoval) state.boardsPendingExplicitRemoval = true
    commitHistoryEntry(state, { inverse: [], forward: [], coalesceKey, board: { before, after } })
  })
}

/**
 * Restore one end of a board history entry onto the live draft.
 *
 * Shared by `undo` and `redo` — the two differ only in which end they name.
 * Marks the boards dirty so the restored state actually reaches
 * `.studio/boards.json`, and declares the removal when the restore shrinks the
 * frame set (see the module doc).
 */
export function restoreBoardSnapshot(
  state: Draft<EditorStore>,
  snapshot: BoardHistorySnapshot,
): void {
  const previous = state.boards
  state.boards = snapshot.boards
  state.activeBoardId = snapshot.activeBoardId
  state.boardsDirty = true
  if (dropsAFrame(previous, snapshot.boards)) state.boardsPendingExplicitRemoval = true
  // Whatever was selected may no longer exist (undoing an "add note" removes
  // the note the add selected). Selection is not itself undoable, so prune it
  // rather than restore it.
  const boardIds = new Set(snapshot.boards.boards.map((b) => b.id))
  if (!boardIds.has(snapshot.activeBoardId ?? '')) {
    state.activeBoardId = snapshot.boards.boards[0]?.id ?? null
  }
  const active = snapshot.boards.boards.find((b) => b.id === state.activeBoardId)
  if (active && state.selectedAnnotations.length > 0) {
    const noteIds = new Set(active.notes.map((n) => n.id))
    const docIds = new Set(active.docs.map((d) => d.id))
    const kept = state.selectedAnnotations.filter((ref) =>
      ref.kind === 'note' ? noteIds.has(ref.id) : docIds.has(ref.id),
    )
    if (kept.length !== state.selectedAnnotations.length) state.selectedAnnotations = kept
  }
}

/** True when an entry's ONLY scope is the board domain. */
export function isBoardOnlyEntry(entry: HistoryEntry): boolean {
  return (
    entry.board !== undefined &&
    entry.inverse.length === 0 &&
    entry.forward.length === 0 &&
    entry.structural === undefined
  )
}

/**
 * Keep only the board-scoped entries in a stack — what a SITE reload should
 * leave behind when it decides the site-scoped stack can no longer be replayed
 * (`historyPreservation.ts`).
 *
 * A `.tsx` reparse says nothing whatsoever about `.studio/boards.json`, so
 * wiping a sticky-note move because a page's line numbers shifted would be
 * exactly the "one gesture destroys unrelated undo history" bug `store-08`
 * fixed for the site domain, reintroduced in the board domain.
 */
export function retainBoardOnlyEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.filter(isBoardOnlyEntry)
}

/**
 * Drop every board-scoped entry — what a fresh `.studio/boards.json` READ must
 * do (`loadBoards`, `markBoardsLoadFailed`).
 *
 * A stored snapshot is a reference to the object graph the store held at the
 * time. Once the server hands back a different graph, replaying an old snapshot
 * would not "undo the last gesture", it would resurrect a whole boards file the
 * user has since moved past. Entries that ALSO carry site patches keep those
 * and lose only their board half.
 */
export function dropBoardHistory(state: Draft<EditorStore>): void {
  const strip = (entries: HistoryEntry[]): HistoryEntry[] => {
    let changed = false
    const next: HistoryEntry[] = []
    for (const entry of entries) {
      if (entry.board === undefined) {
        next.push(entry)
        continue
      }
      changed = true
      if (isBoardOnlyEntry(entry)) continue
      const { board: _board, ...rest } = entry
      next.push(rest)
    }
    return changed ? next : entries
  }
  const past = strip(state._historyPast)
  const future = strip(state._historyFuture)
  if (past !== state._historyPast) state._historyPast = past
  if (future !== state._historyFuture) state._historyFuture = future
  state._historyCoalesceKey = null
  state.canUndo = state._historyPast.length > 0
  state.canRedo = state._historyFuture.length > 0
}
