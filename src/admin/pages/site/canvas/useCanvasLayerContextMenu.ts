/**
 * useCanvasLayerContextMenu — state for the canvas right-click menu.
 *
 * Hook lives in a sibling `.ts` file (not `CanvasLayerContextMenu.tsx`) so
 * Fast Refresh keeps working — the project rule is that `.tsx` files only
 * export components.
 */

import { useState } from 'react'
import { nodesUnderClientPoint } from './canvasNodesUnderPoint'

export interface CanvasContextMenuPosition {
  x: number
  y: number
  nodeId: string
}

/** The open menu: where, on what, and (P5-E, IX-26) every layer under that point. */
export interface CanvasContextMenuState extends CanvasContextMenuPosition {
  layerIdsUnderPointer: readonly string[]
}

interface CanvasLayerContextMenuApi {
  position: CanvasContextMenuState | null
  open: (position: CanvasContextMenuPosition) => void
  close: () => void
}

export function useCanvasLayerContextMenu(): CanvasLayerContextMenuApi {
  const [position, setPosition] = useState<CanvasContextMenuState | null>(null)

  // The layers under the pointer are read once, as the menu opens — the one
  // moment the point means anything (`x`/`y` are editor-document client px).
  // The menu opens at once; the "Select layer" list fills in when the frame's
  // rect index answers (a microtask for a warm or same-origin frame).
  const open = (next: CanvasContextMenuPosition) => {
    setPosition({ ...next, layerIdsUnderPointer: [] })
    void nodesUnderClientPoint(next.x, next.y).then((layerIdsUnderPointer) => {
      setPosition((current) => (current && current.x === next.x && current.y === next.y && current.nodeId === next.nodeId ? { ...current, layerIdsUnderPointer } : current))
    })
  }

  const close = () => {
    setPosition(null)
  }

  return { position, open, close }
}
