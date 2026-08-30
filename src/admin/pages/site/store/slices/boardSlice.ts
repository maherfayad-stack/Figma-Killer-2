/**
 * boardSlice — Studio board overlay state (sticky notes + doc blocks + page frames).
 *
 * Owns the editor-side view of `<workspace>/.studio/boards.json`: the parsed
 * `BoardsFile`, which board is currently active, and a dirty flag the
 * auto-save effect in `AdminCanvasLayout` watches to persist changes back to
 * the server. Only meaningful in studio mode (`?studio`) — the CMS flow never
 * touches this slice.
 *
 * Frames: `board.frames` is the source of truth for which pages are curated
 * onto a board — `BoardFramesLayer` renders exactly this list (resolved
 * against `site.pages`), not "every page". `addFrame` / `seedFramesForActiveBoard`
 * add membership at a default grid slot; `setFramePosition` moves an EXISTING
 * frame (works for both "first drag" and subsequent moves — the frame object
 * always already exists by drag time, `addFrame` owns creation); `setFrameSize`
 * (Phase 6E) persists a frame's own width/height (canvas drag-resize or the
 * design tab's device-preset picker) — a frame without a saved size renders
 * at the shared `FRAME_WIDTH`/`FRAME_HEIGHT` default; `removeFrameById` drops
 * ONE frame instance without touching the underlying page or any sibling
 * frame of the same page; `removeFrame` (pageId) drops every frame of a page.
 *
 * WS-10 Phase 2 — every per-frame action above is keyed by `BoardFrame.id`,
 * NOT `pageId` (a duplicated variant means two frames share one `pageId` —
 * see `@core/studio-board`'s `types.ts` for the full reasoning; trap #2, the
 * NODE id grammar itself does not change). `duplicateFrameAsVariant` is the
 * "make this usable" action: a second frame of the same page beside the
 * source, with one axis flipped. `selectedFrameIds` (WS-7.1 multi-select,
 * below) stays PAGE-id-keyed on purpose — see that section for the accepted
 * scope boundary this creates once a duplicated variant exists.
 *
 * Doc cards: `board.docs` mirrors the sticky-note shape exactly (`addDoc` /
 * `moveDoc` / `updateDocHtml` / `removeDoc`) — rich-text-authored
 * documentation cards rendered by `BoardDocsLayer`/`DocBlockView`.
 *
 * Boards are plural: `addBoard` / `renameBoard` / `removeBoard` /
 * `setActiveBoard` manage the `BoardsFile`'s board list and which one is
 * active. A board's `frames` are its own — switching boards changes which
 * curated set of pages the canvas shows.
 *
 * All mutations route through the pure `@core/studio-board` transforms
 * (`upsertBoard`, `upsertNote`, `moveNote`, `removeNote`, `upsertDoc`,
 * `moveDoc`, `removeDoc`, `upsertFrame`, `moveFrame`, `resizeFrame`,
 * `removeFrame`, `removeFramesForPage`, `setFrameAxes`, `duplicateFrame`, …)
 * rather than hand-mutating `Board` / `BoardsFile` objects, so this slice
 * stays a thin translation from store actions to the pure board model.
 *
 * Three groups of those transforms/actions live in sibling modules, purely to
 * stay under the 700-line ceiling: `boardBulkFrameActions.ts` (WS-7.2 bulk
 * frame actions) and `boardAnnotationActions.ts` (note/doc transforms, split
 * out when `store-02`'s `boardsLoadFailed` fix pushed this file to 732) are
 * pure `Board -> Board | null`, where `null` means "nothing to do" so this
 * slice skips `set()` rather than flipping `boardsDirty` for a no-op.
 * `boardFrameSelectionActions.ts` (WS-7.1 frame multi-select, split out when
 * this store-02-follow-up change added `boardsPendingExplicitRemoval`) is the
 * one exception carrying its own `set`/`get` wiring rather than a pure
 * transform — the four actions it holds mutate `selectedFrameIds` directly
 * and have no `Board`-shaped return value to hand back.
 *
 * Snap guides (Phase 6B): `boardSnapGuides` is a TRANSIENT UI field — the
 * alignment guide lines `BoardGuidesLayer` draws while a frame/note/doc is
 * mid-drag. It intentionally lives as its own top-level store field, NOT
 * inside `boards`/`BoardsFile`, so it never reaches `serializeBoardsFile` or
 * the boards auto-save effect (`AdminCanvasLayout`'s `useStudioBoardsPersistence`
 * only ever reads/writes `boards`). `setBoardSnapGuides` never flips
 * `boardsDirty` for the same reason — guides are drawn, not persisted.
 *
 * Frame multi-selection (WS-7.1): `selectedFrameIds` is a SEPARATE selection
 * domain from `selectedNodeIds` (selectionSlice) — a board frame is not a
 * node, and (WS-10 Phase 2) it stays PAGE-id-keyed rather than converting to
 * frame ids: a real, accepted, documented scope boundary, not an oversight —
 * once a page has a duplicated variant, the bulk actions below resolve a page
 * id to its FIRST matching frame (`firstFrameForPage`), never a specific one.
 * The single-frame path (drag, resize handles, `FrameSizePanel`, "duplicate
 * as variant", "remove from board") stays fully frame-id-precise regardless.
 * `selectFrame`/`selectAllFrames` clear the node selection when they make the
 * frame selection non-empty (and vice versa in selectionSlice), so the
 * Properties panel always shows exactly one of "frame(s)" or "node(s)"
 * selected, never both. Bulk actions (WS-7.2 — set size, device preset,
 * apply-to-all-pages, fit-to-content, align/distribute, tidy) go through the
 * same pure `moveFrame`/`resizeFrame` transforms the single-frame actions do.
 *
 * `frameDefaults` (WS-7.2 — "apply to all pages") mirrors the per-project
 * default in `.studio/meta.json`'s `frameDefaults` (`server/handlers/studio/
 * studioMeta.ts`) — `AdminCanvasLayout` hydrates it via `setFrameDefaults`
 * alongside the boards load, and `addFrame`/`seedFramesForActiveBoard` read
 * it so a page added AFTER "apply to all pages" inherits the same width
 * instead of falling back to the hardcoded `FRAME_WIDTH`. This slice never
 * calls the meta.json endpoint itself — persisting the default is the UI
 * action's job (`frameDefaultsApi.ts`), matching every other project-meta
 * write in this codebase (rename, probe) — the store stays a pure state
 * container with no direct HTTP calls.
 */
import type { EditorStoreSliceCreator, EditorStore } from '@site/store/types'
import type { AnnotationRef, Board, BoardsFile, NoteColor, PreviewAxes } from '@core/studio-board'
import type { SnapGuide } from '@site/canvas/boardSnapping'
import {
  createBoard,
  createBoardsFile,
  upsertBoard,
  removeBoard as removeBoardFromFile,
  renameBoard as renameBoardOnBoard,
  upsertFrame,
  moveFrame,
  resizeFrame,
  removeFrame as removeFrameById,
  removeFramesForPage,
  setFrameAxes as setFrameAxesOnBoard,
  duplicateFrame,
  defaultFramePosition,
  getActiveBoard,
  FRAME_WIDTH,
} from '@core/studio-board'
import type { FrameAlignEdge } from '@site/canvas/BoardFramesLayer/frameAlign'
import * as bulk from './boardBulkFrameActions'
import * as guideActions from './boardGuideActions'
import { createFrameSelectionActions } from './boardFrameSelectionActions'
import {
  createAnnotationActions,
  EMPTY_ANNOTATION_CLIPBOARD,
  type AnnotationClipboard,
} from './boardAnnotationSliceActions'

export type { FrameAlignEdge }

/** WS-10 Phase 2 — horizontal gap between a source frame and its "duplicate as variant" sibling. */
const VARIANT_GAP = 48

/** Mirrors `FrameDefaultsSchema` in `server/handlers/studio/studioMeta.ts` — kept as a plain client-local shape so this browser module never imports server code. */
export interface FrameDefaults {
  width?: number
  height?: number
}

interface BoardSlice {
  /** The parsed `.studio/boards.json` contents. */
  boards: BoardsFile
  /** Board the sticky-notes overlay reads/writes. `null` until loaded. */
  activeBoardId: string | null
  /** True once `loadBoards` has run for this editor session. */
  boardsLoaded: boolean
  /** True when `boards` has unsaved changes the auto-save effect must flush. */
  boardsDirty: boolean
  /**
   * True when the CURRENT `boards` state is a synthetic placeholder created
   * because the `.studio/boards.json` FETCH itself failed (network/HTTP
   * error) — as opposed to a legitimate "no boards.json exists yet" empty
   * response, which `loadBoards` also renders as a fresh default board but
   * is real, save-worthy state. Set by `markBoardsLoadFailed`, cleared by
   * the next successful `loadBoards`. `useStudioDefaultBoardSeed`
   * (`AdminCanvasLayout.tsx`) refuses to seed frames while this is true —
   * seeding a placeholder from whatever `site.pages` happens to hold at
   * that moment, then auto-saving it 800ms later, would silently overwrite
   * the REAL boards.json (which was never actually read) with a synthesized
   * subset. See the `boards-fetch-race-01` STATE.md entry.
   */
  boardsLoadFailed: boolean
  /**
   * True when a real removal (`removeFrame`/`removeFrameById`/`removeBoard`,
   * or `patchPages`'s cleanup for a page confirmed gone) happened since the
   * last successful save. Consumed by `AdminCanvasLayout.tsx`'s
   * `boardsSaveGuard.ts` — see that module's doc for why. Reset by
   * `markBoardsClean`, same lifecycle as `boardsDirty`.
   */
  boardsPendingExplicitRemoval: boolean
  /**
   * Transient alignment guide lines for the furniture piece currently being
   * dragged (Phase 6B). Empty outside of an active drag. NOT persisted — see
   * the module doc's "Snap guides" note.
   */
  boardSnapGuides: SnapGuide[]

  /**
   * Hydrate from a freshly-fetched `BoardsFile`. An empty file gets a default
   * "Board 1" created and marked dirty so the newly-created board persists
   * on the next auto-save. Always clears `boardsLoadFailed` — a load that
   * reaches here has real (or legitimately-empty) server data, not a
   * fetch-failure placeholder.
   */
  loadBoards: (file: BoardsFile) => void
  /**
   * Render a placeholder empty board because the boards.json FETCH failed
   * (network/HTTP error), WITHOUT marking it dirty and WITHOUT letting
   * `useStudioDefaultBoardSeed` treat it as a real empty project — see
   * `boardsLoadFailed`'s doc. The canvas still gets a board to render (the
   * multi-frame board is the whole canvas in studio mode, so it must never
   * silently fall back to single-page breakpoint frames), but nothing here
   * is eligible for auto-seed or auto-save until a real load succeeds.
   */
  markBoardsLoadFailed: () => void
  /**
   * Create a new board (empty frames/notes), make it active, and return its
   * id. `name` defaults to the next unique "Board N".
   */
  addBoard: (name?: string) => string
  /** Rename a board. No-op for an unknown id. */
  renameBoard: (boardId: string, name: string) => void
  /**
   * Delete a board. If it was active, activity switches to the first
   * remaining board. Never removes the last board (no-op).
   */
  removeBoard: (boardId: string) => void
  /** Switch which board is active. No-op for an unknown id. */
  setActiveBoard: (boardId: string) => void
  // ── Annotations: sticky notes + doc cards ───────────────────────────────
  // Wiring lives in `boardAnnotationSliceActions.ts`; the pure transforms in
  // `boardAnnotationActions.ts`. See the former's module doc for why the
  // annotation selection is its own `AnnotationRef` list rather than reusing
  // `selectedFrameIds`.
  /** Create a sticky note at (x, y) on the active board. No-op with no active board. */
  addNote: (x: number, y: number) => void
  /** Reposition a note on the active board. */
  moveNote: (noteId: string, x: number, y: number) => void
  /** Update a note's text content. */
  updateNoteText: (noteId: string, text: string) => void
  /** Recolor a note. */
  setNoteColor: (noteId: string, color: NoteColor) => void
  /** Delete a note from the active board. */
  removeNote: (noteId: string) => void
  /** Create a doc card at (x, y) on the active board. No-op with no active board. */
  addDoc: (x: number, y: number) => void
  /** Reposition a doc card on the active board. */
  moveDoc: (docId: string, x: number, y: number) => void
  /** Replace a doc card's rich text. Sanitized before it is stored. */
  updateDocHtml: (docId: string, html: string) => void
  /** Delete a doc card from the active board. */
  removeDoc: (docId: string) => void
  /** Set a note's or doc's rect (drag-resize). Size is clamped to `MIN_ANNOTATION_SIZE`. */
  resizeAnnotation: (ref: AnnotationRef, rect: { x: number; y: number; w: number; h: number }) => void

  /** Notes/docs currently selected. Mutually exclusive with `selectedNodeIds` and `selectedFrameIds`. */
  selectedAnnotations: AnnotationRef[]
  /** Copied annotation VALUES — see `boardAnnotationSliceActions.ts` for why values, not refs. */
  annotationClipboard: AnnotationClipboard
  /** How many times the CURRENT clipboard has been pasted, so each paste steps further from the last. Reset by every copy. */
  annotationPasteCount: number
  /** Select one annotation, replacing the selection or toggling it into the set. */
  selectAnnotation: (ref: AnnotationRef, mode?: 'replace' | 'toggle') => void
  setSelectedAnnotations: (refs: readonly AnnotationRef[]) => void
  clearAnnotationSelection: () => void
  deleteSelectedAnnotations: () => void
  /** Copy the selection in place and select the copies. */
  duplicateSelectedAnnotations: () => void
  copySelectedAnnotations: () => void
  pasteAnnotations: () => void
  /** Move the selection by a board-unit delta (arrow-key nudge). */
  nudgeSelectedAnnotations: (dx: number, dy: number) => void
  /** Raise the selection above, or lower it below, every other annotation. */
  reorderSelectedAnnotations: (to: 'front' | 'back') => void
  /** Deselect everything — nodes, board frames and annotations. The three are independent lists; see `boardAnnotationSliceActions.ts`. */
  clearAllSelections: () => void
  /** D1 — persisted ruler guides. All are no-ops with no active board (moveGuide/removeGuide also no-op for an unknown id). */
  addGuide: (axis: 'x' | 'y', position: number) => void
  moveGuide: (guideId: string, position: number) => void
  removeGuide: (guideId: string) => void
  /** Drop every guide on the active board, or only the given axis's. */
  clearGuides: (axis?: 'x' | 'y') => void
  /**
   * Reposition ONE existing frame by its own `id` (WS-10 Phase 2). No-op if
   * that frame id doesn't exist on the active board, or there is no active
   * board — frame CREATION is `addFrame`/`seedFramesForActiveBoard`'s job
   * exclusively.
   */
  setFramePosition: (frameId: string, x: number, y: number) => void
  /**
   * Persist ONE frame's own width/height (Phase 6E — resizable frames +
   * device presets), by `id` (WS-10 Phase 2). No-op with no active board, or
   * if the frame id doesn't exist.
   */
  /** Persist a frame's own size. `height: undefined` CLEARS it — "hug the content"; see `resizeFrame`. */
  setFrameSize: (frameId: string, width: number, height: number | undefined) => void
  /** Remove EVERY frame of `pageId` from the active board (e.g. the page itself was deleted, or a bulk multi-select remove — `selectedFrameIds` is page-id-keyed, see module doc). */
  removeFrame: (pageId: string) => void
  /** WS-10 Phase 2 — remove ONE frame instance by its own `id`, never touching a sibling "duplicate as variant" of the same page. This is what `BoardFrameView`'s "Remove from board" menu item calls. */
  removeFrameById: (frameId: string) => void
  /**
   * Add a `BoardFrame` for `pageId` to the ACTIVE board at a default grid
   * slot. No-op if the page is already a frame on the board, or there is no
   * active board.
   */
  addFrame: (pageId: string) => void
  /**
   * Add frames (grid layout) for every `pageId` not already present on the
   * ACTIVE board. Used for the one-time default-board seed. No-op with no
   * active board or when every id is already a frame.
   */
  seedFramesForActiveBoard: (pageIds: string[]) => void
  /**
   * WS-10 Phase 2 (§4.3-§4.5) — "duplicate as variant": create a second
   * frame of `sourceFrameId`'s page, positioned beside it, carrying
   * `axesOverride` as its OWN `BoardFrame.axes` (merged onto the board
   * default per-axis at render time — see `previewAxesFrameEffect.ts`).
   * Selects the new frame (mirrors `selectFrame`'s mutual-exclusivity with
   * node selection). Returns the new frame's id, or `null` if `sourceFrameId`
   * doesn't exist / there is no active board. Writes ONLY to the in-memory
   * `boards` state (persisted to `.studio/boards.json` like any other board
   * edit) — never touches the user's source (`studio-workspace/*` is user
   * data, trap #12).
   */
  duplicateFrameAsVariant: (sourceFrameId: string, axesOverride: Partial<PreviewAxes>) => string | null
  /** WS-10 Phase 2 — set (or clear, passing `undefined`) one frame's per-axis preview override by `id`. No-op if the frame id doesn't exist. */
  setFrameAxes: (frameId: string, axes: Partial<PreviewAxes> | undefined) => void
  /** Clear the dirty flag after a successful save. */
  markBoardsClean: () => void
  /**
   * Replace the active drag's snap guides (Phase 6B). Pass `[]` to clear —
   * furniture drag handlers do this on pointer-up/cancel. Never touches
   * `boardsDirty`: guides are drawn, not persisted.
   */
  setBoardSnapGuides: (guides: SnapGuide[]) => void

  // ── Frame multi-selection (WS-7.1) ───────────────────────────────────────
  /** Selected frame ids (page ids), on the ACTIVE board. Distinct from node selection. Page-id-keyed — see module doc's WS-10 Phase 2 note. */
  selectedFrameIds: string[]
  /**
   * Select a frame. `replace` (default) clears the set and selects only
   * `pageId`; `toggle` (Shift-click) adds it if absent, removes it if
   * present. Selecting a frame clears the node selection (mutual
   * exclusivity — see module doc).
   */
  selectFrame: (pageId: string, mode?: 'replace' | 'toggle') => void
  /** Replace the frame selection wholesale — the marquee-drag live-update path. No-op if the set is reference-unchanged in length AND content is trivially empty-to-empty. */
  setSelectedFrameIds: (pageIds: string[]) => void
  /** Replace the frame selection with every frame on the active board (⌘/Ctrl+A on empty canvas). */
  selectAllFrames: () => void
  /** Empty the frame selection. No-op if already empty. */
  clearFrameSelection: () => void

  // ── Per-project frame size default (WS-7.2 — "apply to all pages") ──────
  /** Local mirror of `.studio/meta.json`'s `frameDefaults` — hydrated by `AdminCanvasLayout`, read by `addFrame`/`seedFramesForActiveBoard`. */
  frameDefaults: FrameDefaults
  /**
   * True once the project's `frameDefaults` have been RESOLVED for this
   * session — whether they came back populated, empty, or the fetch failed.
   * Not "are there defaults", but "do we yet know".
   *
   * `useStudioDefaultBoardSeed` waits on this. Without it the default-board
   * seed races the `frameDefaults` fetch (two independent promises started
   * together in `AdminCanvasLayout`), and losing that race stamps every
   * seeded frame with the hardcoded `FRAME_WIDTH`/`FRAME_HEIGHT` — so a
   * project created as Mobile would open its first screen at 1024×800 and
   * silently persist that, exactly the outcome the platform choice exists to
   * prevent. Reset to `false` on every project switch by `setFrameDefaults`'s
   * caller re-running its load effect.
   */
  frameDefaultsSettled: boolean
  /** Replace the local `frameDefaults` mirror (load-time hydration; does not itself persist anything). Marks `frameDefaultsSettled`. */
  setFrameDefaults: (defaults: FrameDefaults) => void
  /** Drop the mirror back to "not yet known" at the START of a project load, so the seed never runs on the PREVIOUS project's defaults. */
  clearFrameDefaults: () => void

  // ── Bulk frame actions (WS-7.2) — all operate on `selectedFrameIds` ─────
  /**
   * Set width and/or height on every selected frame. Pass `null` for a
   * dimension to leave it unchanged per-frame (mixed-value support: typing
   * only W in the bulk inspector must not clobber each frame's own H).
   */
  setSelectedFramesSize: (width: number | null, height: number | null) => void
  /**
   * The literal "apply to all pages" ask: writes `width` to EVERY frame on
   * the active board (not just the selection) and updates the local
   * `frameDefaults` mirror so a page added later inherits it via
   * `addFrame`/`seedFramesForActiveBoard`. Does not touch `.studio/
   * meta.json` itself — the calling UI persists that through
   * `frameDefaultsApi.ts` (see module doc).
   */
  applyWidthToAllFrames: (width: number) => void
  /**
   * Set each named frame's height individually — the generic primitive
   * behind "fit height to content": the UI measures each selected frame's
   * live iframe content height and passes the result here so the store
   * itself never reaches into the DOM.
   */
  setFrameHeights: (heightsByPageId: Record<string, number>) => void
  /** Align every selected frame to a shared edge/center line. No-op below 2 selected frames. */
  alignSelectedFrames: (edge: FrameAlignEdge) => void
  /** Space selected frames evenly along an axis, extremes fixed. No-op below 3 selected frames. */
  distributeSelectedFrames: (axis: 'horizontal' | 'vertical') => void
  /** Re-lay every selected frame into the standard add-time grid, in selection order. */
  tidySelectedFrames: () => void
}

declare module '@site/store/types' {
  interface EditorStore extends BoardSlice {}
}

/** Find the active board, or `null` when there is none (not loaded / no boards). Exported for `boardFrameSelectionActions.ts`'s `selectAllFrames`. */

/** Next unused "Board N" name — skips numbers already taken by another board. */
function nextDefaultBoardName(boards: Board[]): string {
  const names = new Set(boards.map((b) => b.name))
  let n = 1
  while (names.has(`Board ${n}`)) n++
  return `Board ${n}`
}

export const createBoardSlice: EditorStoreSliceCreator<BoardSlice> = (set, get) => ({
  boards: createBoardsFile(),
  activeBoardId: null,
  boardsLoaded: false,
  boardsDirty: false,
  boardsLoadFailed: false,
  boardsPendingExplicitRemoval: false,
  boardSnapGuides: [],
  selectedFrameIds: [],
  frameDefaults: {},
  frameDefaultsSettled: false,
  selectedAnnotations: [],
  annotationClipboard: EMPTY_ANNOTATION_CLIPBOARD,
  annotationPasteCount: 0,

  loadBoards: (file) => {
    if (file.boards.length > 0) {
      set({
        boards: file,
        boardsLoaded: true,
        boardsDirty: false,
        boardsLoadFailed: false,
        activeBoardId: file.boards[0].id,
      })
      return
    }

    const board = createBoard(crypto.randomUUID(), 'Board 1')
    set({
      boards: upsertBoard(file, board),
      boardsLoaded: true,
      // A fresh default board was created locally — it needs to persist.
      boardsDirty: true,
      boardsLoadFailed: false,
      activeBoardId: board.id,
    })
  },

  markBoardsLoadFailed: () => {
    const board = createBoard(crypto.randomUUID(), 'Board 1')
    set({
      boards: upsertBoard(createBoardsFile(), board),
      boardsLoaded: true,
      // Deliberately NOT dirty — this placeholder must never reach the
      // auto-save effect. See `boardsLoadFailed`'s doc comment.
      boardsDirty: false,
      boardsLoadFailed: true,
      activeBoardId: board.id,
    })
  },

  addBoard: (name) => {
    const { boards } = get()
    const board = createBoard(crypto.randomUUID(), name ?? nextDefaultBoardName(boards.boards))
    set({
      boards: upsertBoard(boards, board),
      activeBoardId: board.id,
      boardsDirty: true,
    })
    return board.id
  },

  renameBoard: (boardId, name) => {
    const { boards } = get()
    const board = boards.boards.find((b) => b.id === boardId)
    if (!board) return
    set({ boards: upsertBoard(boards, renameBoardOnBoard(board, name)), boardsDirty: true })
  },

  removeBoard: (boardId) => {
    const { boards, activeBoardId } = get()
    // Never remove the last board — the studio canvas always needs one.
    if (boards.boards.length <= 1) return
    if (!boards.boards.some((b) => b.id === boardId)) return

    const nextBoards = removeBoardFromFile(boards, boardId)
    const nextActiveBoardId =
      activeBoardId === boardId ? nextBoards.boards[0]?.id ?? null : activeBoardId
    // A real, confirmed removal — safe for `boardsSaveGuard.ts` to let through
    // even though it shrinks the aggregate frame set.
    set({
      boards: nextBoards,
      activeBoardId: nextActiveBoardId,
      boardsDirty: true,
      boardsPendingExplicitRemoval: true,
    })
  },

  setActiveBoard: (boardId) => {
    const { boards } = get()
    if (!boards.boards.some((b) => b.id === boardId)) return
    set({ activeBoardId: boardId })
  },

  ...createAnnotationActions(set, get),

  // D1 — persisted ruler guides (one-lined to stay under the size-budget ceiling).
  addGuide: (axis, position) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (board) set({ boards: upsertBoard(boards, guideActions.addGuide(board, axis, position)), boardsDirty: true })
  },
  moveGuide: (guideId, position) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (board) set({ boards: upsertBoard(boards, guideActions.moveGuide(board, guideId, position)), boardsDirty: true })
  },
  removeGuide: (guideId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (board) set({ boards: upsertBoard(boards, guideActions.removeGuide(board, guideId)), boardsDirty: true })
  },
  clearGuides: (axis) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const next = guideActions.clearGuides(board, axis)
    if (next) set({ boards: upsertBoard(boards, next), boardsDirty: true })
  },

  setFramePosition: (frameId, x, y) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, moveFrame(board, frameId, x, y)), boardsDirty: true })
  },

  setFrameSize: (frameId, width, height) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, resizeFrame(board, frameId, width, height)), boardsDirty: true })
  },

  removeFrame: (pageId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const nextBoard = removeFramesForPage(board, pageId)
    const removedSomething = nextBoard.frames.length !== board.frames.length
    set({
      boards: upsertBoard(boards, nextBoard),
      boardsDirty: true,
      ...(removedSomething ? { boardsPendingExplicitRemoval: true } : {}),
    })
  },

  removeFrameById: (frameId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const nextBoard = removeFrameById(board, frameId)
    const removedSomething = nextBoard.frames.length !== board.frames.length
    set({
      boards: upsertBoard(boards, nextBoard),
      boardsDirty: true,
      ...(removedSomething ? { boardsPendingExplicitRemoval: true } : {}),
    })
  },

  addFrame: (pageId) => {
    const { boards, activeBoardId, frameDefaults } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    if (board.frames.some((f) => f.pageId === pageId)) return
    const { x, y } = defaultFramePosition(board.frames.length)
    // WS-7.2 — a page added after "apply to all pages" inherits the
    // project's frame default instead of the hardcoded FRAME_WIDTH/HEIGHT.
    const frame: Parameters<typeof upsertFrame>[1] = { id: crypto.randomUUID(), pageId, x, y }
    if (frameDefaults.width) frame.width = frameDefaults.width
    if (frameDefaults.height) frame.height = frameDefaults.height
    set({ boards: upsertBoard(boards, upsertFrame(board, frame)), boardsDirty: true })
  },

  seedFramesForActiveBoard: (pageIds) => {
    const { boards, activeBoardId, frameDefaults } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    const existingIds = new Set(board.frames.map((f) => f.pageId))
    const missingIds = pageIds.filter((id) => !existingIds.has(id))
    if (missingIds.length === 0) return

    const nextBoard = missingIds.reduce((acc, pageId, i) => {
      const { x, y } = defaultFramePosition(board.frames.length + i)
      const frame: Parameters<typeof upsertFrame>[1] = { id: crypto.randomUUID(), pageId, x, y }
      if (frameDefaults.width) frame.width = frameDefaults.width
      if (frameDefaults.height) frame.height = frameDefaults.height
      return upsertFrame(acc, frame)
    }, board)
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  duplicateFrameAsVariant: (sourceFrameId, axesOverride) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return null
    const source = board.frames.find((f) => f.id === sourceFrameId)
    if (!source) return null

    const newFrameId = crypto.randomUUID()
    const nextBoard = duplicateFrame(board, sourceFrameId, {
      id: newFrameId,
      // Beside the source, same row — the primary way users reach this
      // feature (§4.4), so it must never land exactly on top of its sibling.
      x: source.x + (source.width ?? FRAME_WIDTH) + VARIANT_GAP,
      y: source.y,
      axes: axesOverride,
    })
    if (!nextBoard) return null

    set((state) => {
      state.boards = upsertBoard(boards, nextBoard)
      state.boardsDirty = true
      // Select the new frame, mirroring `selectFrame`'s mutual-exclusivity
      // with node selection — the user's next action is almost always
      // "look at the variant I just made".
      state.selectedFrameIds = [source.pageId]
      if (state.selectedNodeIds.length > 0) {
        state.selectedNodeIds = []
        state.selectedNodeId = null
      }
    })
    return newFrameId
  },

  setFrameAxes: (frameId, axes) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    if (!board) return
    set({ boards: upsertBoard(boards, setFrameAxesOnBoard(board, frameId, axes)), boardsDirty: true })
  },

  markBoardsClean: () => set({ boardsDirty: false, boardsPendingExplicitRemoval: false }),

  setBoardSnapGuides: (guides) => set({ boardSnapGuides: guides }),

  // ── Frame multi-selection (WS-7.1) — implementation split out to
  // `boardFrameSelectionActions.ts` purely to stay under the module-size
  // ceiling (same reasoning as `boardBulkFrameActions.ts`/
  // `boardAnnotationActions.ts`) — see that module's doc.
  ...createFrameSelectionActions(set, get),

  // ── Per-project frame size default (WS-7.2) ─────────────────────────────

  setFrameDefaults: (defaults) => set({ frameDefaults: defaults, frameDefaultsSettled: true }),
  clearFrameDefaults: () => set({ frameDefaults: {}, frameDefaultsSettled: false }),

  // ── Bulk frame actions (WS-7.2) — pure transforms live in
  // `boardBulkFrameActions.ts` (module-size split); this is just the
  // `set`/`get` wiring around them, uniform across all six.
  setSelectedFramesSize: (width, height) => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    const nextBoard = board && bulk.setSelectedFramesSize(board, selectedFrameIds, width, height)
    if (!nextBoard) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  applyWidthToAllFrames: (width) => {
    const { boards, activeBoardId, frameDefaults } = get()
    const board = getActiveBoard(boards, activeBoardId)
    const nextBoard = board && bulk.applyWidthToAllFrames(board, width)
    if (!nextBoard) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true, frameDefaults: { ...frameDefaults, width } })
  },

  setFrameHeights: (heightsByPageId) => {
    const { boards, activeBoardId } = get()
    const board = getActiveBoard(boards, activeBoardId)
    const nextBoard = board && bulk.setFrameHeights(board, heightsByPageId)
    if (!nextBoard) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  alignSelectedFrames: (edge) => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    const nextBoard = board && bulk.alignSelectedFrames(board, selectedFrameIds, edge)
    if (!nextBoard) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  distributeSelectedFrames: (axis) => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    const nextBoard = board && bulk.distributeSelectedFrames(board, selectedFrameIds, axis)
    if (!nextBoard) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },

  tidySelectedFrames: () => {
    const { boards, activeBoardId, selectedFrameIds } = get()
    const board = getActiveBoard(boards, activeBoardId)
    const nextBoard = board && bulk.tidySelectedFrames(board, selectedFrameIds)
    if (!nextBoard) return
    set({ boards: upsertBoard(boards, nextBoard), boardsDirty: true })
  },
})

/** Select the active board (or `null` — not studio mode / not loaded yet). */
export const selectActiveBoard = (s: EditorStore): Board | null =>
  getActiveBoard(s.boards, s.activeBoardId)

/** Select the active drag's snap guides (empty outside of a drag). */
export const selectBoardSnapGuides = (s: EditorStore): SnapGuide[] => s.boardSnapGuides
