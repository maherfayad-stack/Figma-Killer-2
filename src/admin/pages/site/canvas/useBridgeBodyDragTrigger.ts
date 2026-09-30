/**
 * useBridgeBodyDragTrigger — pressing an element's own body starts a drag in
 * a Tier 2 BRIDGE frame too.
 *
 * `useCanvasBodyDragTrigger` is a capture listener on the frame's document,
 * which a bridge frame does not have: it is the user's own app on its own dev
 * server, cross-origin, and every project is Tier 2 by default. Its runtime
 * forwards every pointer phase as a `pointer` message instead
 * (`@core/studio-runtime`'s `gestureForwarding.ts`) — having already cancelled
 * the press and stopped it before the app's own handlers, so the component's
 * click or pressed state never runs on a design frame. Until this existed
 * nothing on the parent read a press as a drag at all: pressing an element in
 * a live board frame and moving selected it on release and moved nothing.
 *
 * The rest of the gesture needs no new wire: `beginDrag` flags the canvas
 * pointer relay, and `useBridgeFrameInteraction` already replays every `move`
 * and `up` of that pointer onto the iframe element, where they bubble to the
 * session's window listeners like any relayed move (speed-06). The candidates
 * come over the wire as well (`canvasDragSession.ts`).
 *
 * Which layer the press drags is the one it would select
 * (`canvasPressTarget.ts`) — resolved on the MESSAGE's node, never on the
 * app's innermost stamped element.
 */
import { use, useEffect, useEffectEvent } from 'react'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import { CanvasFrameAdapterContext } from './CanvasContexts'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { beginCanvasPress } from './canvasNodeGestureLatch'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
import { canvasPressContext, planCanvasPressDrag } from './canvasPressTarget'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import type { CanvasDragOrigin } from './canvasDragSession'

interface BridgeBodyDragTriggerOptions {
  /** True when a press on an element's body may start a drag (structural edit permitted). */
  enabled: boolean
  iframeElement: HTMLIFrameElement | null
  /** The page this frame renders — the tree the press is resolved against. */
  pageId: string | null
  frameId: string | null
  /** Opens the drag session. Returns false when this press cannot start one. */
  beginDrag: (origin: CanvasDragOrigin) => boolean
}

export function useBridgeBodyDragTrigger({
  enabled,
  iframeElement,
  pageId,
  frameId,
  beginDrag,
}: BridgeBodyDragTriggerOptions): void {
  // The frame's adapter, provided by `BreakpointFrame` around the overlay. A
  // portal frame's presses are `useCanvasBodyDragTrigger`'s, so only a BRIDGE
  // adapter arms this one.
  const frameAdapter = use(CanvasFrameAdapterContext)
  const adapter = frameAdapter && !isPortalFrameAdapter(frameAdapter) ? frameAdapter : null
  // The latest render closure (`beginDrag` reads the current selection) without
  // re-subscribing to the adapter on every selection change.
  const beginBodyDrag = useEffectEvent((origin: CanvasDragOrigin) => beginDrag(origin))

  useEffect(() => {
    if (!enabled || !adapter || !iframeElement) return
    return adapter.on('pointer', (event) => {
      if (event.phase !== 'down') return
      // Every press in this frame starts a new gesture — see `beginCanvasPress`.
      beginCanvasPress()
      if (event.button !== 0 || !event.nodeId) return
      // Space / middle button / the hand tool: `useBridgeFrameInteraction`
      // replays this press as a PAN. One gesture, one meaning.
      if (shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) })) return
      const hitId = event.nodeId
      // After every other listener of THIS message: `useBridgeFrameInteraction`
      // activates the frame's page on the same `down`, and the session reads
      // the active page. The `move`s that follow arrive as later messages, so
      // nothing of the gesture is missed.
      queueMicrotask(() => {
        const state = useEditorStore.getState()
        // An inline text edit owns the pointer inside its run: a press-and-drag
        // there selects text.
        if (state.activeInlineEdit) return
        const page = selectCanvasPageFor(state, pageId, frameId)
        if (!page) return
        const plan = planCanvasPressDrag(page, hitId, canvasPressContext(state, frameId), {
          deep: event.modifiers.metaKey || event.modifiers.ctrlKey,
        })
        // The frame's own background: nothing to move.
        if (!plan) return
        const point = iframeLocalPointToParentClientPoint(
          iframeElement.getBoundingClientRect(),
          { width: iframeElement.clientWidth, height: iframeElement.clientHeight },
          { x: event.clientX, y: event.clientY },
        )
        beginBodyDrag({
          // The FRAME's pointer id: the relay replays this frame's moves only
          // for the pointer the session was opened with.
          pointerId: event.pointerId,
          clientX: point.x,
          clientY: point.y,
          candidateIds: plan.candidateIds,
          preferredDraggedId: plan.preferredDraggedId,
          selectOnActivate: plan.selectOnActivate,
          frameId,
          altKey: event.modifiers.altKey,
          freeKey: event.modifiers.metaKey || event.modifiers.ctrlKey,
        })
      })
    })
  }, [enabled, adapter, iframeElement, pageId, frameId])
}
