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
 * **A pan replay's `move`/`up` drive their point from `screenX/screenY`
 * DELTAS, never from `clientX/clientY` re-projected through the iframe's
 * rect.** The first, disproven fix here pinned the iframe's
 * `getBoundingClientRect()` snapshot for the life of a pan, reasoning that a
 * physically still mouse reports an unchanged frame-local point — true, but
 * it silently assumed the frame-local point was the only thing moving.
 * Measured live (Playwright, synthetic middle-button drag, pan read off the
 * transform layer once per animation frame — see `live-19`'s STATE.md entry
 * for the full numbers): that pinned version panned the canvas at HALF speed
 * with backward steps and then snapped back on release, because once the
 * canvas starts panning, the FRAME ITSELF starts moving under a mouse that
 * IS still moving — the iframe's own screen position changes, so the
 * runtime's `pointermove` inside it reports a frame-local `clientX` that has
 * stopped growing at the mouse's own rate (the frame is chasing it). Adding
 * that shrinking local delta to a rect fixed at pan-start starves the pan of
 * its own input.
 *
 * The actual root cause is a **compositor lag**, not a coordinate-frame
 * choice: Chrome computes the runtime's `clientX/clientY` against the
 * cross-origin iframe's LAST COMMITTED screen transform, which lags the
 * parent's own DOM transform write by one to two compositor frames during an
 * active pan (an out-of-process iframe's rendering is genuinely a frame or
 * two behind the parent compositor's latest paint). The parent then adds its
 * OWN, freshly-read `getBoundingClientRect()` on top — the two disagree by
 * however much pan landed in between, in EITHER direction, and `speed-03`'s
 * rAF coalescing on both sides beats against that disagreement. No
 * rect-timing trick fixes this, pinned or not, because the lag lives in the
 * browser's compositor, not in anything this hook reads or writes.
 *
 * `screenX`/`screenY` (`MouseEvent`'s hardware-relative fields, `live-19`)
 * sidestep the whole problem: the OS reports the SAME screen position to
 * both the child's and the parent's event, with no iframe transform, no
 * compositor commit, and no rect read involved on EITHER side. A pan replay
 * therefore records the down's converted parent-client point and the down's
 * `screenX/screenY` once, and drives every subsequent `move`/`up` as
 * `downClientPoint + (event.screenX − downScreenX, event.screenY − downScreenY)`
 * — a pure hardware delta, immune to the frame lagging or leading the mouse.
 * Every other path (hover, click, the `speed-06` external-drag relay, wheel)
 * is untouched: none of them pan the canvas out from under the very point
 * they're converting.
 *
 * `speed-06` — a THIRD pointer case, checked before the ordinary hover/up
 * handling: a drag that started OUTSIDE this frame entirely (an asset-card
 * drag, the notch's own drag) and whose pointer has now moved inside this
 * bridge frame's iframe. `useCanvasInsertionDrag`'s `window` pointermove/up
 * listeners go silent the instant the cursor crosses into a real,
 * cross-origin iframe — nothing about that press ever reached this frame's
 * `down` phase (it happened in the PARENT document), so `panPointerId` is
 * never set for it. `readCanvasPointerRelay` (`canvasPointerRelay.ts`) reads
 * the SAME `data-studio-canvas-dragging`/`…-pointer-id` flags the portal
 * relay (`useIframeEventForwarding.ts`) reads for the mirror-image case
 * (forwarding an iframe-internal move back OUT to the parent); here the
 * runtime has already delivered the move to the PARENT as a `pointer`
 * message, and replaying it onto the iframe element (bubbling to `window`,
 * same mechanism the pan replay above uses) is what lets the parent's own
 * drag-session listeners see it. Routed here, never to `onNodeHover`/
 * `onNodePointerUp` — an external drag owns the gesture, not this frame's
 * selection. No `down`/`cancel` case: the runtime's wire has no `cancel`
 * phase (nothing here taps native `pointercancel`), a real, documented gap
 * rather than a silent one.
 *
 * Wheel → one `WheelEvent` re-dispatched on the iframe element in parent
 * client pixels (`iframeLocalPointToParentClientPoint`, the portal path's own
 * conversion) so it bubbles to the canvas root and zoom-to-cursor stays under
 * the cursor.
 *
 * Resize commit → the frame previewed the drag itself (`resizeHandles.ts`);
 * the parent makes the ONE write, `setNodeInlineStyles`, the portal path's
 * `useElementResizeDrag` makes for the same gesture — the size and the Fixed
 * companions the frame planned from the markers `useBridgeSelectionChrome`
 * sent it (canvas-23). Resize guides (canvas-26) → painted in this frame's
 * drag layer, exactly where a portal drag paints its own.
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
 * Instances (P2-B) → a click or a hover inside a not-yet-entered
 * `studio.instance` lands on the INSTANCE, and a double-click opens it one
 * level — the same `findEnclosingInstance` / `resolveInstanceEntry` rules
 * `NodeRenderer` applies to a portal frame. Before this, a click on a
 * component in a live frame selected the element inside it (the runtime
 * stamps the component's own markup), which no portal frame ever did.
 *
 * Key / blur (P2-B) → `canvasFrameKeyRelay.ts`, the portal frame's keyboard
 * path: a keydown becomes a clone on the parent `document` for the one key
 * dispatcher, a keyup ends any hold, and the frame losing focus releases
 * every held key if focus left the editor (ERR-11).
 *
 * Only ever mounted by `LiveBoardFrame`, which is a design-board frame — the
 * Live tab's single frame is `CanvasLiveSurface` and never comes through here.
 */
import { use, useEffect, useRef } from 'react'
import { selectCanvasPageFor, useEditorStore } from '@site/store/store'
import { CanvasSelectionContext } from '../CanvasContexts'
import { findEnclosingInstance, resolveInstanceEntry } from '../canvasSelectionUtils'
import { relayFrameBlur, relayFrameKeyDown, relayFrameKeyUp, type FrameKeyInit } from '../canvasFrameKeyRelay'
import { isCanvasSpacePanActive, shouldStartCanvasPointerPan } from '../canvasPanInput'
import { readCanvasPointerRelay } from '../canvasPointerRelay'
import type { FrameDocumentAdapter, FrameRuntimeEvent } from '../frameAdapter/FrameDocumentAdapter'
import { listFrameAdapters } from '../frameAdapter/canvasFrameAdapterRegistry'
import { iframeLocalPointToParentClientPoint } from '../iframeEventCoordinates'
import { paintResizeGuides, resolveResizeGuideSurface } from '../elementResizeGuides'

export interface BridgeFrameInteractionOptions {
  breakpointId: string
  frameId: string
  /** The page this frame renders — the tree a click's instance boundary is resolved against. */
  pageId: string
  /** Whether this frame's page is the board's active page — a press in an inactive frame activates it first. */
  isActive: boolean
  onActivate: (breakpointId: string) => void
}

type PointerEventFromFrame = Extract<FrameRuntimeEvent, { type: 'pointer' }>
type KeyEventFromFrame = Extract<FrameRuntimeEvent, { type: 'key' }>

const NO_MODIFIERS = { shiftKey: false, metaKey: false, ctrlKey: false }

function frameKeyInit(event: KeyEventFromFrame): FrameKeyInit {
  return { key: event.key, code: event.code, location: event.location, repeat: event.repeat, ...event.modifiers }
}

/** The iframe element `adapter` was registered under — `null` once it has unmounted. */
function frameElementOf(adapter: FrameDocumentAdapter): HTMLIFrameElement | null {
  for (const [iframe, registered] of listFrameAdapters()) {
    if (registered === adapter) return iframe
  }
  return null
}

/** `point`, reported in the frame's own client pixels, as a parent client point on `iframe` — zoom and pan included. One-shot only: see the module doc for why a pan's `move`/`up` must NOT call this. */
function parentClientPoint(iframe: HTMLIFrameElement, point: { x: number; y: number }): { x: number; y: number } {
  return iframeLocalPointToParentClientPoint(
    iframe.getBoundingClientRect(),
    { width: iframe.clientWidth, height: iframe.clientHeight },
    point,
  )
}

/** Where a pan gesture started: the down's converted parent-client point, and the down's hardware `screenX/screenY` — the fixed reference every subsequent `move`/`up` of the SAME pan measures its delta against. */
interface PanOrigin {
  client: { x: number; y: number }
  screen: { x: number; y: number }
}

/** `origin.client` plus how far `event`'s hardware screen position has moved since the pan started — see the module doc. */
function panPoint(origin: PanOrigin, event: PointerEventFromFrame): { x: number; y: number } {
  return {
    x: origin.client.x + (event.screenX - origin.screen.x),
    y: origin.client.y + (event.screenY - origin.screen.y),
  }
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
    // The page this frame renders, read fresh — its instance boundaries are
    // what a click or hover resolves against (see the module doc).
    const framePage = () => {
      const { options: current } = latest.current
      return selectCanvasPageFor(useEditorStore.getState(), current.pageId, current.frameId)
    }
    const selectionTarget = (nodeId: string): string => {
      const page = framePage()
      if (!page) return nodeId
      return findEnclosingInstance(page, nodeId, useEditorStore.getState().enteredInstanceIds) ?? nodeId
    }
    // The pointer whose press started a pan, until its release; and whether
    // the click the runtime forwards after that release is still owed a drop.
    let panPointerId: number | null = null
    let dropNextClick = false
    // Recorded on the pan's `down`, read by every `move`/`up` of that SAME
    // gesture — see the module doc. `null` outside an active pan.
    let panOrigin: PanOrigin | null = null
    const replayPointer = (type: 'pointerdown' | 'pointermove' | 'pointerup', event: PointerEventFromFrame, point: { x: number; y: number }) => {
      const iframe = frameElementOf(adapter)
      if (!iframe) return
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
          screenX: event.screenX,
          screenY: event.screenY,
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
              const iframe = frameElementOf(adapter)
              if (iframe) {
                const client = parentClientPoint(iframe, { x: event.clientX, y: event.clientY })
                panOrigin = { client, screen: { x: event.screenX, y: event.screenY } }
                replayPointer('pointerdown', event, client)
              } else {
                panOrigin = null
              }
              return
            }
            activateIfNeeded()
            if (event.nodeId) handlers.onNodePointerDown(event.nodeId)
            return
          case 'move':
            if (panPointerId === event.pointerId) {
              if (panOrigin) replayPointer('pointermove', event, panPoint(panOrigin, event))
              return
            }
            if (readCanvasPointerRelay(document)?.pointerId === event.pointerId) {
              const iframe = frameElementOf(adapter)
              if (iframe) replayPointer('pointermove', event, parentClientPoint(iframe, { x: event.clientX, y: event.clientY }))
              return
            }
            handlers.onNodeHover(event.nodeId && selectionTarget(event.nodeId), current.breakpointId, current.frameId)
            return
          case 'up':
            if (panPointerId === event.pointerId) {
              panPointerId = null
              dropNextClick = true
              if (panOrigin) replayPointer('pointerup', event, panPoint(panOrigin, event))
              panOrigin = null
              return
            }
            if (readCanvasPointerRelay(document)?.pointerId === event.pointerId) {
              const iframe = frameElementOf(adapter)
              if (iframe) replayPointer('pointerup', event, parentClientPoint(iframe, { x: event.clientX, y: event.clientY }))
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
            if (event.nodeId) handlers.onFrameNodeClick(selectionTarget(event.nodeId), event.modifiers, current.breakpointId, current.frameId)
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
      // canvas-26 — the frame snapped; its guides paint where a portal drag's
      // do, in this frame's parent-document drag layer (`[]` clears them).
      adapter.on('resize:guides', (event) => {
        paintResizeGuides(resolveResizeGuideSurface(frameElementOf(adapter)), event.guides)
      }),
      // `live-18` — the frame asks, the store decides (the SAME predicate the
      // portal double-click handler's `startInlineEdit` applies), the reply
      // crosses back over the wire. Nothing is written to the store until
      // `text:commit` — see `inlineTextEdit.ts`'s module doc for why that's safe.
      adapter.on('text:editStart', (event) => {
        const { selection: handlers, options: current } = latest.current
        // A double-click inside a closed instance OPENS it (one level) and
        // selects what is under the cursor there — never a text edit.
        const page = framePage()
        const entry = page ? resolveInstanceEntry(page, event.nodeId, useEditorStore.getState().enteredInstanceIds) : null
        if (entry) {
          useEditorStore.getState().enterInstance(entry.enter)
          handlers.onFrameNodeClick(entry.select, NO_MODIFIERS, current.breakpointId, current.frameId)
          adapter.startTextEdit(event.nodeId, false)
          return
        }
        const started = useEditorStore.getState().startInlineEdit(event.nodeId, current.breakpointId, current.frameId)
        const text = started ? useEditorStore.getState().activeInlineEdit?.initialValue : undefined
        adapter.startTextEdit(event.nodeId, started, text)
      }),
      adapter.on('key', (event) => {
        if (event.phase === 'down') relayFrameKeyDown(document, frameKeyInit(event))
        else relayFrameKeyUp(document, frameKeyInit(event))
      }),
      adapter.on('blur', () => relayFrameBlur(document)),
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
