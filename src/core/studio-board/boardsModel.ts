import type { Board, BoardFrame, BoardGuide, BoardsFile, BoardStacked, DocBlock, StickyNote } from './types'
import type { PreviewAxes } from './previewAxes'

export function createBoardsFile(): BoardsFile {
  return { version: 1, boards: [] }
}

export function createBoard(id: string, name: string): Board {
  return { id, name, frames: [], notes: [], docs: [], guides: [] }
}

export function upsertBoard(file: BoardsFile, board: Board): BoardsFile {
  const index = file.boards.findIndex((b) => b.id === board.id)
  const boards =
    index === -1
      ? [...file.boards, board]
      : file.boards.map((b, i) => (i === index ? board : b))
  return { ...file, boards }
}

export function removeBoard(file: BoardsFile, boardId: string): BoardsFile {
  return { ...file, boards: file.boards.filter((b) => b.id !== boardId) }
}

/**
 * The board `activeBoardId` names, or `null` when nothing is active or the id
 * no longer resolves (a board removed while it was active). The read
 * counterpart to `upsertBoard`/`removeBoard`.
 *
 * Lives here rather than in the editor's `boardSlice.ts` — where it started —
 * because it is a pure selector over `BoardsFile` with no store dependency,
 * and keeping it in the slice forced every sibling action module to import
 * back from the slice. That produced a real `boardSlice -> boardAnnotation/
 * FrameSelectionActions -> boardSlice` cycle, caught by
 * `no-circular-dependencies.test.ts`.
 */
export function getActiveBoard(file: BoardsFile, activeBoardId: string | null): Board | null {
  if (!activeBoardId) return null
  return file.boards.find((b) => b.id === activeBoardId) ?? null
}

export function renameBoard(board: Board, name: string): Board {
  return { ...board, name }
}

export function upsertNote(board: Board, note: StickyNote): Board {
  const index = board.notes.findIndex((n) => n.id === note.id)
  const notes =
    index === -1
      ? [...board.notes, note]
      : board.notes.map((n, i) => (i === index ? note : n))
  return { ...board, notes }
}

export function moveNote(board: Board, noteId: string, x: number, y: number): Board {
  const index = board.notes.findIndex((n) => n.id === noteId)
  if (index === -1) return board
  const notes = board.notes.map((n, i) => (i === index ? { ...n, x, y } : n))
  return { ...board, notes }
}

export function removeNote(board: Board, noteId: string): Board {
  return { ...board, notes: board.notes.filter((n) => n.id !== noteId) }
}

export function upsertDoc(board: Board, doc: DocBlock): Board {
  const index = board.docs.findIndex((d) => d.id === doc.id)
  const docs =
    index === -1
      ? [...board.docs, doc]
      : board.docs.map((d, i) => (i === index ? doc : d))
  return { ...board, docs }
}

export function moveDoc(board: Board, docId: string, x: number, y: number): Board {
  const index = board.docs.findIndex((d) => d.id === docId)
  if (index === -1) return board
  const docs = board.docs.map((d, i) => (i === index ? { ...d, x, y } : d))
  return { ...board, docs }
}

export function removeDoc(board: Board, docId: string): Board {
  return { ...board, docs: board.docs.filter((d) => d.id !== docId) }
}

// ---------------------------------------------------------------------------
// Annotation geometry + stacking — shared by notes and docs, which differ only
// in which array they live in. `AnnotationRef` is how every caller addresses
// one; see `types.ts`'s `BoardStacked` for what `z` means and why it is
// optional.
// ---------------------------------------------------------------------------

/** The smallest an annotation may be dragged to. Below this the chrome (colour swatches, the doc header) no longer fits and the card becomes ungrabbable. */
export const MIN_ANNOTATION_SIZE = 80

export type AnnotationKind = 'note' | 'doc'

export interface AnnotationRef {
  kind: AnnotationKind
  id: string
}

/** Every note and doc on the board as one addressable list, in paint order (see `annotationPaintOrder`). */
export function boardAnnotations(board: Board): (StickyNote | DocBlock)[] {
  return [...board.notes, ...board.docs]
}

/**
 * `items` sorted into paint order: everything without a `z` first, in its own
 * array order, then everything with a `z` ascending. Stable — two items with
 * the same `z` keep their relative array order, so raising one item can never
 * silently reshuffle its neighbours.
 */
export function annotationPaintOrder<T extends BoardStacked>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const az = a.item.z
      const bz = b.item.z
      if (az === undefined && bz === undefined) return a.index - b.index
      if (az === undefined) return -1
      if (bz === undefined) return 1
      if (az !== bz) return az - bz
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

function replaceAnnotation(
  board: Board,
  ref: AnnotationRef,
  update: (item: StickyNote & DocBlock) => Partial<StickyNote & DocBlock>,
): Board {
  if (ref.kind === 'note') {
    const index = board.notes.findIndex((n) => n.id === ref.id)
    if (index === -1) return board
    const notes = board.notes.map((n, i) =>
      i === index ? { ...n, ...update(n as StickyNote & DocBlock) } : n,
    )
    return { ...board, notes }
  }
  const index = board.docs.findIndex((d) => d.id === ref.id)
  if (index === -1) return board
  const docs = board.docs.map((d, i) =>
    i === index ? { ...d, ...update(d as StickyNote & DocBlock) } : d,
  )
  return { ...board, docs }
}

/** Set an annotation's rect. Width/height are clamped to `MIN_ANNOTATION_SIZE` here rather than at the drag site, so a programmatic caller cannot produce an ungrabbable card either. */
export function resizeAnnotation(
  board: Board,
  ref: AnnotationRef,
  rect: { x: number; y: number; w: number; h: number },
): Board {
  return replaceAnnotation(board, ref, () => ({
    x: rect.x,
    y: rect.y,
    w: Math.max(MIN_ANNOTATION_SIZE, rect.w),
    h: Math.max(MIN_ANNOTATION_SIZE, rect.h),
  }))
}

/**
 * Raise `refs` above every other annotation (`'front'`) or lower them below
 * every other (`'back'`), preserving their order relative to each other.
 *
 * Assigns absolute `z` values rather than incrementing: after a `'front'` the
 * moved items hold the top N slots outright, so a second `'front'` on a
 * different item cannot land it in a tie it then loses to array order.
 */
export function reorderAnnotations(board: Board, refs: readonly AnnotationRef[], to: 'front' | 'back'): Board {
  if (refs.length === 0) return board
  const moving = new Set(refs.map((r) => `${r.kind}:${r.id}`))
  const ordered = annotationPaintOrder([
    ...board.notes.map((n) => ({ ref: { kind: 'note' as const, id: n.id }, z: n.z })),
    ...board.docs.map((d) => ({ ref: { kind: 'doc' as const, id: d.id }, z: d.z })),
  ])
  const stay = ordered.filter((e) => !moving.has(`${e.ref.kind}:${e.ref.id}`))
  const move = ordered.filter((e) => moving.has(`${e.ref.kind}:${e.ref.id}`))
  const sequence = to === 'front' ? [...stay, ...move] : [...move, ...stay]
  return sequence.reduce(
    (acc, entry, index) => replaceAnnotation(acc, entry.ref, () => ({ z: index })),
    board,
  )
}

// ---------------------------------------------------------------------------
// Frames — keyed by `BoardFrame.id` (WS-10 Phase 2), NOT `pageId`. Before
// "duplicate as variant" a board never had two frames of the same page, so
// `pageId` alone was already a unique frame key; a duplicated variant breaks
// that (two frames, one `pageId`, different `axes`), so every per-frame
// mutation below addresses a SPECIFIC frame by its own `id`. `pageId` stays
// on `BoardFrame` purely to say which page's tree a frame renders — see
// `types.ts`'s doc.
// ---------------------------------------------------------------------------

/**
 * Insert a NEW frame (an `id` the board doesn't have yet) or merge the given
 * fields onto the EXISTING frame with that `id` — merging (not replacing)
 * preserves fields the caller didn't mention (notably `width`/`height`),
 * which is what lets `setFramePosition` pass just `{ id, pageId, x, y }`
 * without dropping a previously-resized frame's size.
 */
export function upsertFrame(board: Board, frame: Partial<BoardFrame> & { id: string; pageId: string }): Board {
  const index = board.frames.findIndex((f) => f.id === frame.id)
  const frames =
    index === -1
      ? [...board.frames, { ...frame, x: frame.x ?? 0, y: frame.y ?? 0 }]
      : board.frames.map((f, i) => (i === index ? { ...f, ...frame } : f))
  return { ...board, frames }
}

export function moveFrame(board: Board, frameId: string, x: number, y: number): Board {
  const index = board.frames.findIndex((f) => f.id === frameId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => (i === index ? { ...f, x, y } : f))
  return { ...board, frames }
}

/**
 * No-op for a missing frame id, mirroring `moveFrame`.
 *
 * `height: undefined` is MEANINGFUL, not "leave it alone": it clears the
 * stored height, returning the frame to hugging its content. `BoardFrame.height`
 * being absent is exactly what `hasManualHeight` reads to decide between the
 * auto-growing box and a fixed one, so "hug" has to be expressible here — it is
 * what a width-only drag preserves, and what "Fit height to content" restores.
 */
export function resizeFrame(
  board: Board,
  frameId: string,
  width: number,
  height: number | undefined,
): Board {
  const index = board.frames.findIndex((f) => f.id === frameId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => {
    if (i !== index) return f
    // Delete rather than store `undefined`: `boards.json` is JSON, and an
    // explicit `"height": null` would not round-trip as "absent".
    const { height: _dropped, ...rest } = f
    return height === undefined ? { ...rest, width } : { ...rest, width, height }
  })
  return { ...board, frames }
}

/**
 * Removes ONE frame by id — surgical, so removing a "duplicate as variant"
 * never touches its sibling.
 */
export function removeFrame(board: Board, frameId: string): Board {
  return { ...board, frames: board.frames.filter((f) => f.id !== frameId) }
}

/**
 * Removes EVERY frame of a page — the pre-Phase-2 `removeFrame(pageId)`
 * behaviour, kept as its own named function for callers that genuinely mean
 * "this page" rather than "this one frame instance" (the bulk multi-select
 * path, `FrameBulkInspector.tsx` — `selectedFrameIds` is still page-id-keyed,
 * see `boardSlice.ts`'s module doc for why that's an accepted, documented
 * scope boundary rather than a Phase 2 requirement).
 */
export function removeFramesForPage(board: Board, pageId: string): Board {
  return { ...board, frames: board.frames.filter((f) => f.pageId !== pageId) }
}

/** WS-10 Phase 2 — set (`axes` provided) or clear (`undefined`) a frame's per-axis preview override. No-op for a missing frame id. */
export function setFrameAxes(board: Board, frameId: string, axes: Partial<PreviewAxes> | undefined): Board {
  const index = board.frames.findIndex((f) => f.id === frameId)
  if (index === -1) return board
  const frames = board.frames.map((f, i) => {
    if (i !== index) return f
    if (!axes) {
      const { axes: _drop, ...rest } = f
      return rest
    }
    return { ...f, axes }
  })
  return { ...board, frames }
}

// ---------------------------------------------------------------------------
// Guides (D1) — persisted ruler guides, `board.guides`. Mirrors the
// note/doc shape above exactly (upsert / move / remove), keyed by `id`.
// Distinct from `SnapGuide` (`canvas/boardSnapping.ts`) — see `BoardGuide`'s
// doc in `types.ts` for the name collision this avoids.
// ---------------------------------------------------------------------------

export function upsertGuide(board: Board, guide: BoardGuide): Board {
  const guides = board.guides ?? []
  const index = guides.findIndex((g) => g.id === guide.id)
  const nextGuides =
    index === -1 ? [...guides, guide] : guides.map((g, i) => (i === index ? guide : g))
  return { ...board, guides: nextGuides }
}

/** No-op for a missing guide id. */
export function moveGuide(board: Board, guideId: string, position: number): Board {
  const guides = board.guides ?? []
  const index = guides.findIndex((g) => g.id === guideId)
  if (index === -1) return board
  const nextGuides = guides.map((g, i) => (i === index ? { ...g, position } : g))
  return { ...board, guides: nextGuides }
}

export function removeGuide(board: Board, guideId: string): Board {
  return { ...board, guides: (board.guides ?? []).filter((g) => g.id !== guideId) }
}

/**
 * WS-10 Phase 2 (§4.3-§4.4) — "duplicate as variant": a new frame of the
 * SAME page (`sourceFrameId`'s `pageId`, size), its OWN `id` (caller-
 * supplied — this module stays a pure function, no `crypto.randomUUID()`
 * inside it, matching how `boardSlice.ts` already mints every other id),
 * positioned at `x`/`y` and carrying `axes` as its preview override. `null`
 * when `sourceFrameId` doesn't exist. Never touches the source frame, never
 * writes to the user's source (`studio-workspace/*` is user data, trap #12 —
 * this is purely a `boards.json` object).
 */
export function duplicateFrame(
  board: Board,
  sourceFrameId: string,
  next: { id: string; x: number; y: number; axes: Partial<PreviewAxes> },
): Board | null {
  const source = board.frames.find((f) => f.id === sourceFrameId)
  if (!source) return null
  const frame: BoardFrame = {
    ...source,
    id: next.id,
    x: next.x,
    y: next.y,
    axes: next.axes,
  }
  return { ...board, frames: [...board.frames, frame] }
}
