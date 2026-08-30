/**
 * CanvasInsertionDragOverlay — what a drag-to-canvas gesture looks like.
 *
 * Renders the two things every such drag needs: the rectangle (or insertion
 * line) marking exactly where the element will land, and a ghost following the
 * cursor. Portaled to `document.body` because the preview has to be able to
 * paint over an iframe's contents, which nothing inside the canvas transform
 * layer can do.
 *
 * Pairs with `useCanvasInsertionDrag`, which produces the state; this is only
 * the drawing. The ghost's contents are the caller's — a label for the notch's
 * primitives, a wireframe for the module inserter — so it takes children.
 */
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { CanvasInsertionDragState } from '../useCanvasInsertionDrag'
import { dropPreviewStyle } from '../canvasInsertionDrop'
import { ghostPositionStyle } from './ghostPositionStyle'
import styles from './CanvasInsertionDragOverlay.module.css'

interface CanvasInsertionDragOverlayProps<TGhost> {
  /** Null when no drag is in flight — the overlay renders nothing. */
  drag: CanvasInsertionDragState<TGhost> | null
  /** The ghost's contents. Omit for a label-only ghost. */
  children?: ReactNode
}

export function CanvasInsertionDragOverlay<TGhost>({
  drag,
  children,
}: CanvasInsertionDragOverlayProps<TGhost>) {
  if (!drag) return null

  return createPortal(
    <>
      {/* No preview at all while the pointer is outside every frame — an
          element that would not land anywhere must not draw a target. */}
      {drag.preview && (
        <div
          className={styles.dropPreview}
          data-position={drag.preview.position}
          style={dropPreviewStyle(drag.preview)}
          aria-hidden="true"
        >
          <span className={styles.dropTag}>{drag.preview.label}</span>
        </div>
      )}
      <div className={styles.ghost} style={ghostPositionStyle(drag)} aria-hidden="true">
        {children}
      </div>
    </>,
    document.body,
  )
}
