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
 * Three things, in order, each degrading cleanly to the next:
 *
 *   1. Board coordinates, from the transform layer's own client rect. Using
 *      the element's measured rect rather than reconstructing it from
 *      pan/zoom/offsets means the maths cannot drift out of sync with the
 *      layer's CSS (which carries `top: 80px; left: 80px`).
 *   2. The frame under the cursor, by hit-testing `[data-frame-id]`, and the
 *      frame-local offset within it. This is the coordinate of record — it is
 *      what makes a pin follow its frame when the frame is dragged.
 *   3. The node under the cursor, by hit-testing INSIDE that frame's iframe.
 *      Best-effort: a cross-origin or not-yet-loaded iframe simply yields no
 *      node, and the comment becomes coordinate-only rather than failing.
 *
 * Step 3 is the one that gives a comment meaning rather than just a position,
 * and it is captured HERE, at drop time, because it is the only moment the
 * tree and the cursor are both available. See `captureNodeHint`.
 */
import { useEffect, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { selectActiveBoard } from '@site/store/slices/boardSelectors'
import { captureNodeHint, type CommentAnchor } from '@core/studio-comments'
import { canvasZoomOf } from '../canvasZoom'
import styles from './CommentPlacementLayer.module.css'

interface CommentPlacementLayerProps {
  /** The transformed layer — its client rect IS the board's screen origin. */
  transformLayerRef: RefObject<HTMLDivElement | null>
}

/**
 * Screen point → board point, measured off the transform layer itself.
 *
 * Using the element's measured rect for the ORIGIN means the maths cannot
 * drift out of sync with the layer's CSS (which carries `top: 80px;
 * left: 80px`). The SCALE has to come from `canvasZoomOf` rather than from
 * that same rect — the layer's `offsetWidth` is 0, so the usual
 * `rect.width / offsetWidth` ratio silently yields 1. See `canvasZoom.ts`.
 */
function toBoardPoint(
  layer: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number; zoom: number } {
  const rect = layer.getBoundingClientRect()
  const zoom = canvasZoomOf(layer)
  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
    zoom,
  }
}

/**
 * The node id under a point inside a board frame, or `null`.
 *
 * Reads through the frame's iframe, which is same-origin (`srcdoc`), so
 * `contentDocument` is reachable. Everything here is wrapped because a frame
 * that is still booting has no document yet, and a comment placed a moment
 * too early must land as a coordinate-only pin, not an exception.
 */
function nodeIdAtPoint(frameEl: HTMLElement, clientX: number, clientY: number): string | null {
  try {
    const iframe = frameEl.querySelector('iframe')
    const doc = iframe?.contentDocument
    if (!iframe || !doc) return null
    const iframeRect = iframe.getBoundingClientRect()
    const scale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
    if (scale === 0) return null
    const innerX = (clientX - iframeRect.left) / scale
    const innerY = (clientY - iframeRect.top) / scale
    const hit = doc.elementFromPoint(innerX, innerY)
    return hit?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
  } catch {
    // A frame whose document is not reachable is not an error condition here
    // — it just means this pin has coordinates and no subject.
    return null
  }
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

    const board_ = toBoardPoint(layer, clientX, clientY)

    // Hit-test through the capture surface — it is the topmost element at the
    // cursor, so `elementFromPoint` would return the surface itself.
    const beneath = document
      .elementsFromPoint(clientX, clientY)
      .find((el) => el instanceof HTMLElement && el.closest('[data-frame-id]'))
    const frameEl =
      beneath instanceof HTMLElement ? beneath.closest<HTMLElement>('[data-frame-id]') : null

    let anchor: CommentAnchor = {
      frameId: null,
      pageId: null,
      dx: board_.x,
      dy: board_.y,
      node: null,
    }

    if (frameEl) {
      const frameRect = frameEl.getBoundingClientRect()
      const pageId = frameEl.getAttribute('data-page-id')
      const nodeId = nodeIdAtPoint(frameEl, clientX, clientY)
      const page = pageId
        ? useEditorStore.getState().site?.pages.find((candidate) => candidate.id === pageId)
        : undefined

      anchor = {
        frameId: frameEl.getAttribute('data-frame-id'),
        pageId,
        // Frame-LOCAL, so the pin travels with the frame. Divided by the live
        // zoom because the measured rect is already scaled.
        dx: (clientX - frameRect.left) / board_.zoom,
        dy: (clientY - frameRect.top) / board_.zoom,
        node: nodeId && page ? captureNodeHint(page, nodeId) : null,
      }
    }

    beginDraftPin({ boardId: board.id, anchor })
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
        event.preventDefault()
        event.stopPropagation()
        place(event.clientX, event.clientY)
      }}
    />
  )
}
