/**
 * CommentPlacementLayer — the armed comment tool.
 *
 * An UNTRANSFORMED sibling of `CanvasTransformLayer` (like `CanvasRulers` and
 * `BoardNotesToolbar`), which only exists while `commentToolActive` is true.
 * While it exists it covers the canvas and takes the click.
 *
 * A separate full-cover surface, rather than a branch inside the canvas's
 * existing pointer plumbing, for two reasons. It makes the tool genuinely
 * modal — selection, drag-to-move, marquee and the notes toolbar cannot fire
 * underneath it, because they never see the event. And it keeps every line of
 * "what happens while placing a comment" in one file instead of scattering
 * `if (commentToolActive) return` guards through handlers that have nothing to
 * do with comments.
 *
 * WHAT A CLICK RESOLVES TO
 * ────────────────────────
 * `commentAnchorAtPoint` — board coordinates, then the frame under the cursor
 * and the offset within it, then the node inside that frame's iframe. Dragging
 * an existing pin asks the same question, so the answer lives in its own module
 * rather than here; see its doc for why each step degrades the way it does.
 */
import { useEffect, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { commentAnchorAtPoint } from './commentAnchorAtPoint'
import styles from './CommentPlacementLayer.module.css'

interface CommentPlacementLayerProps {
  /** The transformed layer — its client rect IS the board's screen origin. */
  transformLayerRef: RefObject<HTMLDivElement | null>
}

export function CommentPlacementLayer({ transformLayerRef }: CommentPlacementLayerProps) {
  const active = useEditorStore((s) => s.commentToolActive)
  const board = useEditorStore(selectActiveBoard)
  const setCommentToolActive = useEditorStore((s) => s.setCommentToolActive)
  const beginDraftPin = useEditorStore((s) => s.beginDraftPin)

  // Escape disarms. Bound while the tool is armed rather than globally, so it
  // never competes with the many other Escape handlers in the editor.
  useEffect(() => {
    if (!active) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setCommentToolActive(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, setCommentToolActive])

  if (!active || !board) return null

  const place = (clientX: number, clientY: number) => {
    const layer = transformLayerRef.current
    if (!layer) return
    beginDraftPin({ boardId: board.id, anchor: commentAnchorAtPoint(layer, clientX, clientY) })
  }

  return (
    <div
      className={styles.capture}
      data-testid="comment-placement-layer"
      role="presentation"
      onPointerDown={(event) => {
        // Left button only — a right-click here should not silently place a
        // comment the user cannot see themselves having asked for.
        if (event.button !== 0) return
        // `preventDefault` only, never `stopPropagation` — this surface being
        // modal comes from covering the canvas, not from cutting the event
        // off. Stopping it would hide the press from `@use-gesture`, leaving
        // its `filterTaps` state stale so that the NEXT click — the "Comment"
        // button in the draft popover this very press is about to open — gets
        // suppressed. Letting it through costs nothing: every canvas handler
        // beneath is target-guarded (`handleCanvasClick`,
        // `useMarqueeSelection`) and the pan only runs for middle-button or
        // space+primary.
        event.preventDefault()
        place(event.clientX, event.clientY)
      }}
    />
  )
}
