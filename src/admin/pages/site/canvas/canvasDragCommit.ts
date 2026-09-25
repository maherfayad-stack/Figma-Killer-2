/**
 * canvasDragCommit — the ONE store write a released element drag makes, and
 * the four gestures that share it.
 *
 * Extracted from `useCanvasReorderDrag.ts` when D2 G3 (the cross-frame drop)
 * made it a fourth branch and that module was already at the 700-line ceiling.
 * The seam is real and not merely a size one: everything else in the hook is
 * about the gesture WHILE the pointer is down — measuring, resolving, painting,
 * auto-panning, all of it deliberately writing nothing. This is the moment the
 * gesture becomes an edit, and it is the only part of the drag with an opinion
 * about the store at all.
 *
 * The four branches, in the order they are asked:
 *
 *  1. **A free move (K6)** — ⌘/Ctrl held, and the element is one that can be
 *     placed by coordinates. Writes `left`/`top` inline, or presents the
 *     refusal `resolveFreeMove` already computed. Asked first because a free
 *     move resolves no drop target at all, so there is nothing below it to
 *     disambiguate against.
 *  2. **A cross-frame drop (D2 G3)** — the pointer was over a frame showing a
 *     DIFFERENT page. One `transplantNodes` call; the element leaves one file
 *     and lands in another, or the store refuses and says why.
 *  3. **A lift onto the free canvas (P5-G)** — released over the empty board
 *     of a Studio board: the element leaves its page and becomes a loose
 *     layer (Alt: a copy of it does).
 *  4. **An Alt-drop (K2)** — a copy into the resolved position, same page.
 *  5. **An ordinary reorder** — the move the drag has always been.
 *
 * Nothing here decides ANYTHING about whether a write is allowed. Every branch
 * hands the question straight to the store action that owns it, which is the
 * single commit-time authority (`nodeActions.ts`, `transplantActions.ts`); the
 * verdicts the drag painted while the pointer was down were previews of those
 * same rules and are deliberately not re-read here.
 */
import { useEditorStore } from '@site/store/store'
import type { CanvasLiftDrop } from './BoardCanvasLayer/canvasLayerLift'
import type { CanvasDropResolution, CanvasTransplantTarget } from './canvasDnd'
import {
  freeMoveStylePatch,
  presentFreeMoveRefusal,
  type FreeMoveResolution,
  type FreeMoveStep,
} from './canvasFreeMove'

/** Where a cross-frame drop landed — both ends, because the write spans two files. */
export interface CanvasDragForeignDrop {
  /** The page the dragged element is written in. */
  originPageId: string
  /** The page the pointer was over at release. */
  pageId: string
  target: CanvasTransplantTarget
}

export interface CanvasDragCommitInput {
  /** The element the gesture is about — the one a free move or a transplant writes. */
  draggedId: string
  /** The same-page verdict the last painted frame resolved. */
  resolution: CanvasDropResolution
  /**
   * K6's cached answer: `null` means "this was an ordinary reorder",
   * `undefined` means the session never asked (a drag that ended before its
   * first frame). Both take the reorder path.
   */
  free: FreeMoveResolution | null | undefined
  freeStep: FreeMoveStep | null
  /** Alt at release — the only modifier read at commit time rather than per move. */
  duplicating: boolean
  /** D2 G3 — set when the pointer was over another page's frame at release. */
  foreign: CanvasDragForeignDrop | null
  /** P5-G — set when the release was over the empty board of a Studio board. */
  lift: CanvasLiftDrop | null
}

/**
 * Write the gesture. Called exactly once, from `pointerup`, after the session
 * has already been torn down — so every value it needs is passed by value and
 * nothing here can resurrect a dead session.
 *
 * Swallows nothing: a stale target (the tree moved under a gesture that
 * started before a resync) throws out of the store action, and the caller
 * logs it as the one thing it has always been — a drop that no longer names a
 * position that exists.
 */
export function commitCanvasDrag(input: CanvasDragCommitInput): void {
  const store = useEditorStore.getState()

  if (input.free) {
    if (!input.free.ok) presentFreeMoveRefusal(input.free.refusal)
    else if (input.freeStep) {
      store.setNodeInlineStyles(input.draggedId, freeMoveStylePatch(input.free.plan, input.freeStep))
    }
    return
  }

  const foreign = input.foreign
  if (foreign) {
    // ONE element, always: `previewStructuralTransplant` refuses a
    // multi-selection outright (and painted that refusal while the pointer was
    // down), so the id that reaches the store is the one the ghost named.
    store.transplantNodes([input.draggedId], {
      originPageId: foreign.originPageId,
      pageId: foreign.pageId,
      parentId: foreign.target.parentId,
      index: foreign.target.index,
      ...(input.duplicating ? { copy: true } : {}),
    })
    return
  }

  if (input.lift) {
    store.liftNodeToCanvas(input.draggedId, input.lift.originPageId, input.lift.at, input.duplicating)
    return
  }

  const target = input.resolution.target
  if (!target) return
  if (input.duplicating) store.duplicateNodesTo(target.draggedIds, target.parentId, target.index)
  else store.moveNodes(target.draggedIds, target.parentId, target.index)
}
