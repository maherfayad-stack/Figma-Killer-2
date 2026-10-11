/**
 * annotationPlacement — where a newly-added sticky note / doc card lands, and
 * the one-shot "open in edit mode" request that follows it.
 *
 * PURE placement, plus a tiny module-level hand-off. The toolbar button that
 * adds an annotation lives outside the annotation's own view, but only the
 * view owns its editing state (`StickyNoteView` / `DocBlockView`, local
 * `useState`, deliberately NOT the page-tree `inlineEditSlice`). A new view
 * mounts the moment `addNote` commits, so the toolbar records the id here and
 * the view reads it as its initial `isEditing`. Not store state: it is a
 * moment, not a document, and nothing else may depend on it.
 */
import { screenToBoard } from './CanvasRulers/rulerGeometry'

/** How far each stacked annotation steps from the previous one, in board units. */
const STACK_STEP = 24

interface Rect {
  x: number
  y: number
  /** Present for a real annotation: its size, so a bigger one cannot hide a smaller one. */
  w?: number
  h?: number
}

const MAX_PLACEMENT_STEPS = 64

interface PlacementInput {
  /** Live canvas transform (store `zoom` / `panX` / `panY`). */
  zoom: number
  panX: number
  panY: number
  /** The visible canvas box, in `.canvas`-relative screen px. */
  viewportWidth: number
  viewportHeight: number
  /** The new annotation's size, board units. */
  width: number
  height: number
  /** Top-left corners of annotations already on the board. */
  existing: readonly Rect[]
}

/**
 * Top-left board position that centres a `width × height` annotation in the
 * visible viewport, moved clear of whatever already occupies that spot — so
 * adding a note and then a doc (a different size, hence a different top-left
 * around the same centre) never buries one under the other. Against a sized
 * annotation it steps to just past that annotation's right edge; against a
 * bare point it steps diagonally.
 */
export function centredAnnotationPosition(input: PlacementInput): { x: number; y: number } {
  const centreX = screenToBoard(input.viewportWidth / 2, input.zoom, input.panX)
  const centreY = screenToBoard(input.viewportHeight / 2, input.zoom, input.panY)
  let x = Math.round(centreX - input.width / 2)
  let y = Math.round(centreY - input.height / 2)
  const blocker = (): Rect | undefined =>
    input.existing.find((r) =>
      r.w === undefined || r.h === undefined
        ? Math.abs(r.x - x) < STACK_STEP / 2 && Math.abs(r.y - y) < STACK_STEP / 2
        : x < r.x + r.w && r.x < x + input.width && y < r.y + r.h && r.y < y + input.height,
    )
  for (let step = 0; step < MAX_PLACEMENT_STEPS; step += 1) {
    const hit = blocker()
    if (!hit) break
    if (hit.w === undefined) {
      x += STACK_STEP
      y += STACK_STEP
    } else {
      x = hit.x + hit.w + STACK_STEP
    }
  }
  return { x, y }
}

let pendingEditId: string | null = null

/** Ask the annotation with this id to open in edit mode when its view mounts. */
export function requestAnnotationEdit(id: string): void {
  pendingEditId = id
}

/** Whether `id` was just added and should mount editing. Cleared by {@link clearAnnotationEditRequest}. */
export function hasAnnotationEditRequest(id: string): boolean {
  return pendingEditId === id
}

/** Drop the request once the view has consumed it (called from an effect, so StrictMode's double render still sees it). */
export function clearAnnotationEditRequest(id: string): void {
  if (pendingEditId === id) pendingEditId = null
}
