/**
 * useBridgeFrameInteraction — `live-12`/`live-13`/`live-18`: the parent half
 * of selecting, panning, zooming, resizing, and inline-text-editing through a
 * Tier 2 bridge frame on the design board.
 *
 * A portal frame's clicks are React events in the parent's own tree
 * (`NodeRenderer`), its page activation is the frame wrapper's capture
 * handler in the parent DOM (`BoardFrameView`'s `handleActivateCapture`,
 * reached through `useIframeEventForwarding`'s cloned events), and its wheel
 * and pan presses are cloned onto the iframe element by the same hook. A
 * bridge frame is a cross-origin document running the user's real app: its
 * runtime (`@core/studio-runtime`) forwards `pointer`, `wheel` and
 * `resize:commit` messages, and until this hook NOTHING on the parent side
 * consumed them — `BridgeFrameAdapter` emitted them into the void, so a click
 * inside a live frame selected nothing, activated nothing, and ⌘+wheel over
 * it zoomed nothing, on every board the moment `run-project` became the
 * default tier.
 *
 * Pointer → a PAN press first (`shouldStartCanvasPointerPan`: the middle
 * button, or the primary button with Space held or the hand tool armed —
 * the same rule the portal relay applies): it is replayed on the iframe
 * element as a real `PointerEvent` in parent client pixels, along with every
 * move and the release of that same pointer, so `useCanvas`'s drag gesture on
 * the canvas root pans exactly as if the press had landed beside the frame.
 * The click the runtime forwards after that release is dropped — a pan is not
 * a selection. Otherwise: activate this frame's page first when it is not the
 * active one (the same order the portal path guarantees), then the same
 * `CanvasSelectionContext` handlers `NodeRenderer` calls, by node id, with
 * the modifiers the runtime reported.
 *
 * Wheel → one `WheelEvent` re-dispatched on the iframe element in parent
 * client pixels (`iframeLocalPointToParentClientPoint`, the portal path's own
 * conversion) so it bubbles to the canvas root and zoom-to-cursor stays under
 * the cursor.
 *
 * Resize commit → the frame previewed the drag itself (`resizeHandles.ts`);
 * the parent makes the ONE write, `setNodeInlineStyles`, the portal path's
 * `useElementResizeDrag` makes for the same gesture.
 *
 * `text:editStart`/`text:commit`/`text:cancel` (`live-18`) → the frame asks
 * (a double-click landed on a stamped element), the store decides through
 * the SAME `startInlineEdit` predicate the portal double-click handler
 * applies, and the reply (allowed + the node's current text, or refused)
 * crosses back through `adapter.startTextEdit`. Nothing is written to the
 * store until `text:commit` — the typed text lives only in the frame's own
 * DOM until then (`inlineTextEdit.ts`'s module doc) — so `text:cancel`, and
 * an HMR update landing mid-edit, are both plain no-ops on this side.
 *
 * Only ever mounted by `LiveBoardFrame`, which is a design-board frame — the
 * Live tab's single frame is `CanvasLiveSurface` and never comes through here.
 */
import { use, useEffect, useRef } from 'react'
import { useEditorStore } from '@site/store/store'
import { CanvasSelectionContext } from '../CanvasContexts'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from '../canvasPanInput'
import type { FrameDocumentAdapter, FrameRuntimeEvent } from '../frameAdapter/FrameDocumentAdapter'
import { listFrameAdapters } from '../frameAdapter/canvasFrameAdapterRegistry'
import { iframeLocalPointToParentClientPoint } from '../iframeEventCoordinates'

export interface BridgeFrameInteractionOptions {
  breakpointId: string
  frameId: string
  /** Whether this frame's page is the board's active page — a press in an inactive frame activates it first. */
  isActive: boolean
  onActivate: (breakpointId: string) => void
}

type PointerEventFromFrame = Extract<FrameRuntimeEvent, { type: 'pointer' }>

/** The iframe element `adapter` was registered under — `null` once it has unmounted. */
function frameElementOf(adapter: FrameDocumentAdapter): HTMLIFrameElement | null {
  for (const [iframe, registered] of listFrameAdapters()) {
    if (registered === adapter) return iframe
  }
  return null
}

/** `point`, reported in the frame's own client pixels, as a parent client point on `iframe` — zoom and pan included. */
function parentClientPoint(iframe: HTMLIFrameElement, point: { x: number; y: number }): { x: number; y: number } {
  return iframeLocalPointToParentClientPoint(
    iframe.getBoundingClientRect(),
    { width: iframe.clientWidth, height: iframe.clientHeight },
    point,
  )
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
    // The pointer whose press started a pan, until its release; and whether
    // the click the runtime forwards after that release is still owed a drop.
    let panPointerId: number | null = null
    let dropNextClick = false
    const replayPointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', event: PointerEventFromFrame) => {
      const iframe = frameElementOf(adapter)
      if (!iframe) return
      const point = parentClientPoint(iframe, { x: event.clientX, y: event.clientY })
      iframe.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          button: event.button,
          buttons: event.buttons,
          clientX: point.x,
          clientY: point.y,
          ctrlKey: event.modifiers.ctrlKey,
          shiftKey: event.modifiers.shiftKey,
          altKey: event.modifiers.altKey,
          metaKey: event.modifiers.metaKey,
        }),
      )
    }
    const unsubscribes = [
      adapter.on('pointer', (event) => {
        const { selection: handlers, options: current } = latest.current
        switch (event.phase) {
          case 'down':
            if (shouldStartCanvasPointerPan(event, { spaceHeld: isCanvasSpacePanActive(document) })) {
              panPointerId = event.pointerId
              replayPointer('pointerdown', event)
              return
            }
            activateIfNeeded()
            if (event.nodeId) handlers.onNodePointerDown(event.nodeId)
            return
          case 'move':
            if (panPointerId === event.pointerId) {
              replayPointer('pointermove', event)
              return
            }
            handlers.onNodeHover(event.nodeId, current.breakpointId, current.frameId)
            return
          case 'up':
            if (panPointerId === event.pointerId) {
              panPointerId = null
              dropNextClick = true
              replayPointer('pointerup', event)
              return
            }
            if (event.nodeId) handlers.onNodePointerUp(event.nodeId)
            return
          case 'click':
            if (dropNextClick) {
              dropNextClick = false
              return
            }
            activateIfNeeded()
            if (event.nodeId) handlers.onFrameNodeClick(event.nodeId, event.modifiers, current.breakpointId, current.frameId)
            return
        }
      }),
      adapter.on('wheel', (event) => {
        const iframe = frameElementOf(adapter)
        if (!iframe) return
        const point = parentClientPoint(iframe, { x: event.clientX, y: event.clientY })
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
      adapter.on('resize:commit', (event) => {
        useEditorStore.getState().setNodeInlineStyles(event.nodeId, event.patch)
      }),
      // `live-18` — the frame asks, the store decides (the SAME predicate the
      // portal double-click handler's `startInlineEdit` applies), the reply
      // crosses back over the wire. Nothing is written to the store until
      // `text:commit` — see `inlineTextEdit.ts`'s module doc for why that's safe.
      adapter.on('text:editStart', (event) => {
        const { options: current } = latest.current
        const started = useEditorStore.getState().startInlineEdit(event.nodeId, current.breakpointId, current.frameId)
        const text = started ? useEditorStore.getState().activeInlineEdit?.initialValue : undefined
        adapter.startTextEdit(event.nodeId, started, text)
      }),
      adapter.on('text:commit', (event) => {
        const store = useEditorStore.getState()
        if (store.activeInlineEdit?.nodeId !== event.nodeId) return
        store.applyInlineEditValue(event.text)
        useEditorStore.getState().endInlineEdit()
      }),
      adapter.on('text:cancel', (event) => {
        const store = useEditorStore.getState()
        if (store.activeInlineEdit?.nodeId !== event.nodeId) return
        store.cancelInlineEdit()
      }),
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [adapter])
}
