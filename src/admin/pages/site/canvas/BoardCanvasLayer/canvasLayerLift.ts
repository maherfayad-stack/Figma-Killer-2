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
import type { BoardDropSurfaces } from '../canvasDragBoard'
import { canvasSurfaceAtPoint } from '../canvasDragBoard'
import type { ClientPoint, FrameCandidateIndex } from '../canvasDragSession'
import { clientToBoardPoint } from './canvasLayerGeometry'

export interface CanvasLiftDrop {
  originPageId: string
  at: { x: number; y: number }
}

export function resolveCanvasLiftDrop(input: {
  /** The page the dragged element is written in; `null` for a surface with no page (no lift). */
  originPageId: string | null
  draggedId: string
  board: BoardDropSurfaces
  index: FrameCandidateIndex
  /** Where the press started, and where it was released — parent-document client coordinates. */
  origin: ClientPoint
  point: ClientPoint
  canvasRoot: HTMLElement | null
}): CanvasLiftDrop | null {
  if (!input.originPageId || !input.canvasRoot) return null
  // Over ANY frame — the origin one included — is a drop into that frame, not a lift.
  if (canvasSurfaceAtPoint(input.board, input.point)) return null
  // Released outside the board (a panel, the toolbar): nothing to place it on.
  const root = input.canvasRoot.getBoundingClientRect()
  if (input.point.x < root.left || input.point.x > root.right || input.point.y < root.top || input.point.y > root.bottom) return null
  const boardOrigin = input.canvasRoot.querySelector<HTMLElement>('[data-studio-board-origin]')
  if (!boardOrigin) return null

  const scale = input.index.scale > 0 ? input.index.scale : 1
  const origin = boardOrigin.getBoundingClientRect()
  const release = clientToBoardPoint(input.point, origin, scale)
  const element = input.index.candidates.find((candidate) => candidate.nodeId === input.draggedId)?.rect
  if (!element) return { originPageId: input.originPageId, at: release }
  // The grab offset, in board units: where inside the element the press was.
  const grabX = (input.origin.x - (input.index.originX + element.left * scale)) / scale
  const grabY = (input.origin.y - (input.index.originY + element.top * scale)) / scale
  return { originPageId: input.originPageId, at: { x: release.x - grabX, y: release.y - grabY } }
}
