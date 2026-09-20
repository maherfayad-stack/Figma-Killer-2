/**
 * useBridgeFrameInteraction — `live-12`: the parent half of selecting and
 * zooming through a Tier 2 bridge frame on the design board.
 *
 * A portal frame's clicks are React events in the parent's own tree
 * (`NodeRenderer`), its page activation is the frame wrapper's capture
 * handler in the parent DOM (`BoardFrameView`'s `handleActivateCapture`,
 * reached through `useIframeEventForwarding`'s cloned events), and its wheel
 * is cloned onto the iframe element by the same hook. A bridge frame is a
 * cross-origin document running the user's real app: its runtime
 * (`@core/studio-runtime`) forwards `pointer` and `wheel` messages, and until
 * this hook NOTHING on the parent side consumed them — `BridgeFrameAdapter`
 * emitted them into the void, so a click inside a live frame selected
 * nothing, activated nothing, and ⌘+wheel over it zoomed nothing, on every
 * board the moment `run-project` became the default tier.
 *
 * Pointer → activate this frame's page first when it is not the active one
 * (the same order the portal path guarantees: activation in the capture
 * phase, selection after), then the same `CanvasSelectionContext` handlers
 * `NodeRenderer` calls, by node id, with the modifiers the runtime reported.
 * Wheel → one `WheelEvent` re-dispatched on the iframe element in PARENT
 * client pixels (`iframeLocalPointToParentClientPoint`, the portal path's own
 * conversion) so it bubbles to the canvas root and zoom-to-cursor stays under
 * the cursor.
 *
 * Only ever mounted by `LiveBoardFrame`, which is a design-board frame — the
 * Live tab's single frame is `CanvasLiveSurface` and never comes through here.
 */
import { use, useEffect, useRef } from 'react'
import { CanvasSelectionContext } from '../CanvasContexts'
import type { FrameDocumentAdapter } from '../frameAdapter/FrameDocumentAdapter'
import { listFrameAdapters } from '../frameAdapter/canvasFrameAdapterRegistry'
import { iframeLocalPointToParentClientPoint } from '../iframeEventCoordinates'

export interface BridgeFrameInteractionOptions {
  breakpointId: string
  frameId: string
  /** Whether this frame's page is the board's active page — a press in an inactive frame activates it first. */
  isActive: boolean
  onActivate: (breakpointId: string) => void
}

/** The iframe element `adapter` was registered under — `null` once it has unmounted. */
function frameElementOf(adapter: FrameDocumentAdapter): HTMLIFrameElement | null {
  for (const [iframe, registered] of listFrameAdapters()) {
    if (registered === adapter) return iframe
  }
  return null
}

export function useBridgeFrameInteraction(adapter: FrameDocumentAdapter | null, options: BridgeFrameInteractionOptions): void {
  const selection = use(CanvasSelectionContext)
  // The handlers are re-created by `CanvasRoot` on every render and
  // `isActive` flips on every activation; the subscription below must not
  // follow either or it re-subscribes per render. Written in an effect,
  // never during render (`react-hooks/refs`).
  const latest = useRef({ selection, options })
  useEffect(() => {
    latest.current = { selection, options }
  })

  useEffect(() => {
    if (!adapter) return
    const activateIfNeeded = () => {
      const { options: current } = latest.current
      if (!current.isActive) current.onActivate(current.breakpointId)
    }
    const unsubscribes = [
      adapter.on('pointer', (event) => {
        const { selection: handlers, options: current } = latest.current
        switch (event.phase) {
          case 'click':
            activateIfNeeded()
            if (event.nodeId) handlers.onFrameNodeClick(event.nodeId, event.modifiers, current.breakpointId, current.frameId)
            return
          case 'move':
            handlers.onNodeHover(event.nodeId, current.breakpointId, current.frameId)
            return
          case 'down':
            activateIfNeeded()
            if (event.nodeId) handlers.onNodePointerDown(event.nodeId)
            return
          case 'up':
            if (event.nodeId) handlers.onNodePointerUp(event.nodeId)
            return
        }
      }),
      adapter.on('wheel', (event) => {
        const iframe = frameElementOf(adapter)
        if (!iframe) return
        const rect = iframe.getBoundingClientRect()
        const point = iframeLocalPointToParentClientPoint(
          rect,
          { width: iframe.clientWidth, height: iframe.clientHeight },
          { x: event.clientX, y: event.clientY },
        )
        iframe.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
            clientX: point.x,
            clientY: point.y,
            ctrlKey: event.modifiers.ctrlKey,
            shiftKey: event.modifiers.shiftKey,
            altKey: event.modifiers.altKey,
            metaKey: event.modifiers.metaKey,
          }),
        )
      }),
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [adapter])
}
