/**
 * useElementResizeDrag — the pointer half of dragging a selected element's
 * edge, wired imperatively onto handles that live INSIDE the frame's iframe.
 *
 * ## Why native listeners rather than React props
 *
 * The handles are portalled into `CanvasSelectionOverlayInjector`'s overlay
 * root, which is in the IFRAME's document. React attaches its listeners at the
 * root container of the tree, and a portal into a second document puts the
 * elements outside the document React is delegating from — so `onPointerDown`
 * on a portalled handle is not something to rely on. Attaching real listeners
 * to the real nodes sidesteps the question entirely, and costs one effect.
 *
 * ## Why there is no zoom division anywhere in here
 *
 * The canvas zoom is a CSS transform on the iframe ELEMENT, applied in the
 * parent document. Pointer events raised inside the iframe's own document are
 * reported in that document's untransformed CSS pixels — the browser
 * un-projects the ancestor transform before the event is dispatched. So a 40px
 * pointer delta read here is 40 CSS px of element, at every zoom level. This
 * is the same property that let the selection rings drop their zoom math
 * (`BreakpointSelectionOverlay`'s docblock); dividing by zoom here would
 * double-correct and make the element run away from the cursor at any zoom
 * other than 1. `setPointerCapture` on the handle keeps the whole gesture in
 * that one document even when the cursor leaves the frame.
 *
 * ## Preview, then commit
 *
 * During the drag the size is written straight onto the element's own
 * `style` — no store round trip, so it tracks the pointer at frame rate and
 * the selection ring (which re-measures every tick) follows for free. On drop
 * the real edit goes through `setNodeInlineStyles`, which is what reaches the
 * user's source as `style={{ width: '240px' }}` on that one JSX element.
 *
 * The override is dropped BEFORE the store commit, so React's re-render is
 * what finally sets the size and the DOM never disagrees with what React
 * thinks it wrote. When the commit is refused (a locked node, a write the
 * codemod will not make) nothing re-renders and the element is left at what
 * the document actually says — the honest outcome, and better than a canvas
 * showing a size that was never written.
 *
 * Escape cancels: the override is dropped and nothing is committed.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { beginCanvasGesture, endCanvasGesture } from './canvasGesture'
import { presentedElementForNode } from './canvasNodeLookup'
import { MIN_ELEMENT_SIZE, resizeElementSize, resizeStylePatch } from './elementResize'
import type { ResizeHandle } from './rectResize'

/** The attribute each handle carries, naming the direction it drags. */
export const RESIZE_HANDLE_ATTR = 'data-canvas-resize-handle'

interface ElementResizeDragOptions {
  /** The handle container portalled into the iframe overlay root, or `null`. */
  frame: HTMLElement | null
  /** The iframe document the selected element lives in. */
  iframeDoc: Document | null
  /** The single selected node, or `null` when resize is not offered. */
  nodeId: string | null
}

export function useElementResizeDrag({ frame, iframeDoc, nodeId }: ElementResizeDragOptions): void {
  useEffect(() => {
    if (!frame || !iframeDoc || !nodeId) return

    // The same resolver `CanvasResizeHandles` gates on, so the thing being
    // dragged and the thing the handles were drawn for cannot disagree — which
    // matters most for an `alm.*` node, where the node id sits on a
    // `display: contents` host and the box is one level down. Its own
    // escaping, deliberately, rather than `CSS.escape` — which is not defined
    // in the test environment's DOM.
    const target = presentedElementForNode(iframeDoc, nodeId)
    if (!target) return

    const cleanups: Array<() => void> = []

    for (const handleEl of frame.querySelectorAll<HTMLElement>(`[${RESIZE_HANDLE_ATTR}]`)) {
      const handle = handleEl.getAttribute(RESIZE_HANDLE_ATTR) as ResizeHandle | null
      if (!handle) continue

      const onPointerDown = (event: PointerEvent) => {
        // Left button only, and never let this reach the canvas's own
        // selection/pan handling — a drag on a handle is not a click on the
        // element underneath it.
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()

        const rect = target.getBoundingClientRect()
        const start = { width: rect.width, height: rect.height }
        const startX = event.clientX
        const startY = event.clientY
        let last = start

        // Freeze the expensive derived geometry (the parent-doc anchor session,
        // the frame's auto-height refit) for the length of the drag — this
        // gesture changes layout on every frame, which is exactly what those
        // two are built to assume does not happen. See `canvasGesture.ts`.
        const gesture = beginCanvasGesture()

        try {
          handleEl.setPointerCapture(event.pointerId)
        } catch (_err) {
          // A capture the browser refuses (a pointer already released) is not
          // fatal — the document-level listeners below still drive the drag.
        }

        const clearPreview = () => {
          target.style.removeProperty('width')
          target.style.removeProperty('height')
        }

        // Coalesced to ONE write per animation frame. A pointermove stream runs
        // well past 60Hz on a trackpad or a high-rate mouse, and every write to
        // `style.width` invalidates layout for the whole page inside the frame
        // — which the overlay's own RAF tick then measures. Writing on each
        // event makes the browser lay out several times per painted frame and
        // the drag visibly falls behind the cursor; writing once per frame
        // cannot, and loses nothing, because only the last position of a frame
        // was ever going to be seen.
        let pendingFrame: number | null = null
        const applyPending = () => {
          pendingFrame = null
          if (last.width !== start.width) target.style.width = `${last.width}px`
          if (last.height !== start.height) target.style.height = `${last.height}px`
        }

        const onMove = (moveEvent: PointerEvent) => {
          last = resizeElementSize(
            handle,
            start,
            moveEvent.clientX - startX,
            moveEvent.clientY - startY,
            MIN_ELEMENT_SIZE,
          )
          pendingFrame ??= requestAnimationFrame(applyPending)
        }

        const finish = (commit: boolean) => {
          if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
          iframeDoc.removeEventListener('pointermove', onMove)
          iframeDoc.removeEventListener('pointerup', onUp)
          iframeDoc.removeEventListener('pointercancel', onCancel)
          iframeDoc.removeEventListener('keydown', onKeyDown)
          try {
            handleEl.releasePointerCapture(event.pointerId)
          } catch (_err) {
            // Already released with the pointer — nothing to undo.
          }
          // Drop the preview BEFORE the commit, never after. The preview and
          // the committed value are the SAME DOM property, so clearing it
          // afterwards deletes exactly what React just wrote — and React will
          // not write it again, because from its point of view the style prop
          // did not change. The element then sits at its DOCUMENT size (full
          // width, for an ordinary block child) until a reload rebuilds the
          // tree, while the user's file says otherwise. Clearing first makes
          // the store update's re-render the last thing to touch
          // `style.width`; both happen inside this one event handler, so the
          // browser paints once and the intermediate state is never seen.
          clearPreview()
          const patch = commit ? resizeStylePatch(handle, start, last) : null
          if (patch) useEditorStore.getState().setNodeInlineStyles(nodeId, patch)
          // Unfreeze AFTER the commit, so the single settle pass measures the
          // final size rather than the last previewed one.
          endCanvasGesture(gesture)
        }

        const onUp = () => finish(true)
        const onCancel = () => finish(false)
        const onKeyDown = (keyEvent: KeyboardEvent) => {
          if (keyEvent.key === 'Escape') finish(false)
        }

        iframeDoc.addEventListener('pointermove', onMove)
        iframeDoc.addEventListener('pointerup', onUp)
        iframeDoc.addEventListener('pointercancel', onCancel)
        iframeDoc.addEventListener('keydown', onKeyDown)
      }

      handleEl.addEventListener('pointerdown', onPointerDown)
      cleanups.push(() => handleEl.removeEventListener('pointerdown', onPointerDown))
    }

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [frame, iframeDoc, nodeId])
}
