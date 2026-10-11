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
 *
 * ## The ghost is the element, at half opacity
 *
 * A caller that knows what it is inserting passes `body` (and the hook's
 * `ghostSize`): the ghost is then that element at its own size scaled by the
 * canvas zoom, top-left on the pointer, at 50 % opacity - what Figma shows. The
 * label chip sits under it. A caller that cannot say what it inserts keeps the
 * chip alone.
 *
 * The ghost MOVES without React: `drag.tracker` writes the pointer position to
 * the element's custom properties on the hook's animation frame, so this
 * component renders when the drop target or the ghost's size changes, not per
 * pointermove.
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
  /** The label chip's contents. */
  children?: ReactNode
  /**
   * The element itself, drawn at the ghost's size. Omitted with a known size,
   * the ghost is a tinted placeholder box of that size (an empty Div).
   */
  body?: ReactNode
}

export function CanvasInsertionDragOverlay<TGhost>({
  drag,
  children,
  body,
}: CanvasInsertionDragOverlayProps<TGhost>) {
  if (!drag) return null
  const sized = body !== undefined || drag.size != null

  return createPortal(
    <>
      {/* No preview at all while the pointer is outside every frame — an
          element that would not land anywhere must not draw a target. */}
      {drag.preview && (
        <div
          className={styles.dropPreview}
          data-position={drag.preview.position}
          data-axis={drag.preview.axis}
          data-reversed={drag.preview.reversed ? 'true' : undefined}
          style={dropPreviewStyle(drag.preview)}
          aria-hidden="true"
        >
          <span className={styles.dropTag}>{drag.preview.label}</span>
        </div>
      )}
      <div
        ref={drag.tracker?.attach}
        className={styles.ghost}
        data-insertion-ghost=""
        data-ghost-sized={drag.size ? 'exact' : sized ? 'auto' : undefined}
        style={ghostPositionStyle(drag)}
        aria-hidden="true"
      >
        {sized ? (
          <>
            <div className={styles.ghostBody} data-insertion-ghost-body="">
              <div className={styles.ghostScaled}>{body}</div>
            </div>
            <div className={styles.ghostChip}>{children}</div>
          </>
        ) : (
          children
        )}
      </div>
    </>,
    document.body,
  )
}
