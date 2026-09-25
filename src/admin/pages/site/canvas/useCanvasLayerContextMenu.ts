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
  const open = (next: CanvasContextMenuPosition) => {
    setPosition({ ...next, layerIdsUnderPointer: nodesUnderClientPoint(next.x, next.y) })
  }

  const close = () => {
    setPosition(null)
  }

  return { position, open, close }
}
