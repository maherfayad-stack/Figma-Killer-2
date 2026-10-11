/**
 * useInspectorClosedAfterDrag — whether the in-place props popover is closed
 * because a drag just ended on the current selection.
 *
 * A drag of any outcome (moved, refused, cancelled) closes the popover for the
 * selection it ended on: it would otherwise sit over the neighbours the layer
 * was just dragged across. Selecting something else, or clearing the
 * selection, brings it back. State is adjusted during render (React's
 * derived-state pattern) so the close lands in the same commit as the drag's
 * end, with no effect and no flash.
 */
import { useState } from 'react'

export function useInspectorClosedAfterDrag(dragging: boolean, selectionSignature: string, hasSelection: boolean): boolean {
  const [draggingSeen, setDraggingSeen] = useState(false)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  if (draggingSeen !== dragging) {
    setDraggingSeen(dragging)
    if (draggingSeen) setClosedFor(selectionSignature)
  }
  if (closedFor !== null && !hasSelection) setClosedFor(null)
  return closedFor === selectionSignature
}
