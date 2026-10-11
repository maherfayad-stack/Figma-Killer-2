/**
 * useBridgeResizeDrag — the pointer half of resizing an element inside a live
 * (Tier 2) frame, from handles that sit beside its iframe in the PARENT
 * document (SB-4).
 *
 * The frame is cross-origin, so the parent can neither read the element nor
 * write its preview: the geometry of the drag is the runtime's
 * (`resizeSession.ts`), driven over the wire. This hook is the same drag a
 * same-origin frame gets (`handleDragSession.ts`: pointer capture, ⇧ / ⌥ read
 * on every move and key change, Escape, one message per animation frame, the
 * ERR-12 guard) with a different `paint`: instead of writing the element's own
 * style it posts `resize:step`. The frame previews through its own stylesheet,
 * posts `resize:guides` for the snap guides and, on release, `resize:commit`
 * with the patch the parent writes through the store
 * (`useBridgeFrameInteraction.ts`).
 *
 * ⇧ / ⌥ are sent raw (`resizeModifiersOf` with the scale tool off yields exactly
 * `proportional = shiftKey`, `fromCenter = altKey`); the scale tool is latched
 * in the frame by `setResizeTarget` (`useBridgeResizeTarget.ts`).
 */
import { useEffect } from 'react'
import { RESIZE_ACTIVE_ATTR, RESIZE_HANDLE_ATTR, type ResizeHandle } from '@core/studio-runtime'
import { iframeZoom } from './elementResizeGuides'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { startHandleDrag } from './handleDragSession'

interface BridgeResizeDragOptions {
  /** The handle container rendered beside the iframe, or `null`. */
  frame: HTMLElement | null
  /** The live frame's adapter, or `null` when resize is not offered. */
  adapter: FrameDocumentAdapter | null
  /** The frame's iframe element: the canvas zoom is read off its rendered box. */
  iframeElement: HTMLIFrameElement | null
}

export function useBridgeResizeDrag({ frame, adapter, iframeElement }: BridgeResizeDragOptions): void {
  useEffect(() => {
    if (!frame || !adapter) return

    const cleanups: Array<() => void> = []
    // The drag in flight, if any — cancelled when the handles are torn down
    // under it, so a gesture can never outlive its element and leave the frame
    // previewing a size nobody is dragging.
    let cancelActive: (() => void) | null = null

    // The click that ends a drag lands on the handle and would bubble up the
    // canvas to its empty-board deselect.
    const swallowHandleClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    frame.addEventListener('click', swallowHandleClick)
    frame.addEventListener('dblclick', swallowHandleClick)
    cleanups.push(() => {
      frame.removeEventListener('click', swallowHandleClick)
      frame.removeEventListener('dblclick', swallowHandleClick)
    })

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

        let latest = { dx: 0, dy: 0, shiftKey: false, altKey: false }
        adapter.resizeBegin(handle)
        cancelActive = startHandleDrag({
          event,
          handleEl,
          frame,
          activeAttr: RESIZE_ACTIVE_ATTR,
          iframeDoc: null,
          zoom: iframeZoom(iframeElement),
          scaleTool: false,
          callbacks: {
            step: (dx, dy, modifiers) => {
              latest = { dx, dy, shiftKey: modifiers.proportional, altKey: modifiers.fromCenter }
            },
            paint: () => adapter.resizeStep(latest.dx, latest.dy, latest),
            end: (commit) => {
              cancelActive = null
              // The release can land before the frame's last animation frame did: the frame must see the pointer's
              // final position before it is told to commit (a cancelled drag drops its preview and needs no step).
              if (commit) adapter.resizeStep(latest.dx, latest.dy, latest)
              adapter.resizeEnd(commit)
            },
          },
        })
      }

      handleEl.addEventListener('pointerdown', onPointerDown)
      cleanups.push(() => handleEl.removeEventListener('pointerdown', onPointerDown))
    }

    return () => {
      cancelActive?.()
      for (const cleanup of cleanups) cleanup()
    }
  }, [frame, adapter, iframeElement])
}
