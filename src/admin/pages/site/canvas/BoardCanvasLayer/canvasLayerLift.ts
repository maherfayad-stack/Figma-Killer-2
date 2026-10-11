/**
 * canvasLayerLift — whether a released ELEMENT drag was a lift onto the free
 * canvas (P5-G, FC-5 G9), and where the new loose layer goes.
 *
 * An element dragged out of its frame and released over the empty board of a
 * Studio board — over no frame at all, its own included — leaves the page and
 * becomes a loose layer (Figma: dragging a layer out of a frame makes it
 * top-level). The layer keeps the grab: its top-left lands where the element's
 * top-left was under the pointer when the drag began, so what the user was
 * holding stays under the cursor.
 *
 * Asked once, at release, after the session's last frame resolved — the same
 * moment the cross-frame branch reads its verdict. Everything measured here
 * the session already measured, except the board origin, which is one rect.
 */
import type { ClientPoint, FrameCandidateIndex } from '../canvasDragSession'
import { clientToBoardPoint, findBoardOrigin, isEmptyBoardTarget } from './canvasLayerGeometry'

export interface CanvasLiftDrop {
  originPageId: string
  at: { x: number; y: number }
}

export function resolveCanvasLiftDrop(input: {
  /** The page the dragged element is written in; `null` for a surface with no page (no lift). */
  originPageId: string | null
  draggedId: string
  index: FrameCandidateIndex
  /** Where the press started, and where it was released — parent-document client coordinates. */
  origin: ClientPoint
  point: ClientPoint
  canvasRoot: HTMLElement | null
}): CanvasLiftDrop | null {
  if (!input.originPageId || !input.canvasRoot) return null
  // Only a release ON the empty board is a lift: over any frame (the origin
  // one included) it is a drop into that frame, and over a panel or the
  // toolbar there is nothing to place it on. Asked of what is under the
  // pointer — see `isEmptyBoardTarget` for why not of the registry's rects.
  const under = input.canvasRoot.ownerDocument.elementFromPoint(input.point.x, input.point.y)
  if (!isEmptyBoardTarget(under) || !input.canvasRoot.contains(under)) return null
  const origin = findBoardOrigin(input.canvasRoot)
  if (!origin) return null

  const scale = origin.zoom
  const release = clientToBoardPoint(input.point, origin, scale)
  const element = input.index.candidates.find((candidate) => candidate.nodeId === input.draggedId)?.rect
  if (!element) return { originPageId: input.originPageId, at: release }
  // The grab offset, in board units: where inside the element the press was.
  const grabX = (input.origin.x - (input.index.originX + element.left * scale)) / scale
  const grabY = (input.origin.y - (input.index.originY + element.top * scale)) / scale
  return { originPageId: input.originPageId, at: { x: release.x - grabX, y: release.y - grabY } }
}
