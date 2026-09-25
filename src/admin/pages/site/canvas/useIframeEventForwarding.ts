/**
 * useIframeEventForwarding — replays events that fire INSIDE a canvas frame's
 * iframe onto the parent document, where the editor's own gesture, drag and
 * shortcut layers live.
 *
 * Split out of `IframeFrameSurface.tsx`, whose only remaining job is owning
 * the iframe document itself. Everything here answers one question — "this
 * event happened in the iframe, but it belongs to the editor: how does it get
 * there?" — and it is deliberately kept whole, in one module, because the
 * three relays share the space-pan flag, the pan pointer id, and the
 * coordinate translation.
 *
 * Wheel
 * ─────
 * Scrolling with the cursor over an iframe would otherwise do nothing: the
 * iframe document doesn't propagate wheel events to the parent, where the
 * canvas pan/zoom handlers (`useGesture`, attached to the canvas root) live.
 * We listen inside the iframe and re-dispatch a new `WheelEvent` on the iframe
 * ELEMENT (in the parent doc), so it bubbles to the canvas root.
 *
 * Cross-iframe drag relay
 * ───────────────────────
 * Canvas drags that start in the parent doc (selection-toolbar reorders,
 * media-panel inserts) inevitably cross into an iframe partway through.
 * Left-click pointer events inside the iframe never bubble to the parent's
 * `window`, so the parent's pointermove / up / cancel listeners go silent the
 * moment the cursor enters a frame. To fix that, drag hooks set
 * `data-studio-canvas-dragging` and `data-studio-canvas-dragging-pointer-id`
 * on the parent's `<html>` while a drag is in flight. Every iframe reads those
 * flags inside its pointer handler and, when set, forwards the three pointer
 * event types to the parent (using the original drag's pointerId so the
 * parent's session-id assumptions still line up).
 *
 * Clipboard
 * ─────────
 * P5-A. `copy` / `cut` / `paste` raised in the frame's document reach the
 * canvas's clipboard bridge (`canvasClipboardBridge.ts`), which is what lets
 * ⌘V read an image or an SVG from the OS clipboard with focus in a frame.
 *
 * OS file drop
 * ────────────
 * D2 G15. A `dragover`/`drop` carrying files from the desktop is re-dispatched
 * on the iframe element so the board's own handler sees it. EVERY drag in a
 * design frame's document is cancelled there — files or not — so the browser
 * cannot navigate that document to whatever was dropped on it. The rule and
 * its reasoning live in `canvasFrameDragRelay.ts`; this file owns only when
 * it is installed.
 *
 * Keyboard
 * ────────
 * Clicking a node to select it focuses the iframe, so subsequent keystrokes go
 * to the iframe document — where none of the editor's parent-level native
 * shortcut listeners can see them. keydown is cloned onto the parent
 * `document`, keyup feeds the dispatcher's release broadcast, and the frame's
 * window losing focus releases every held key — all through
 * `canvasFrameKeyRelay.ts`, which the bridge-frame relay shares. See
 * `onKeyDown` for the inline-edit stand-down that makes this safe.
 *
 * All of that is canvas-only: live frames pan nothing, host no cross-frame
 * drag, and scroll natively.
 *
 * Prototype `key` triggers
 * ────────────────────────
 * The one thing a LIVE frame forwards, and by direct call rather than by a
 * clone — see the effect's own comment. A running prototype's form fields are
 * real, and cloning what the user types in them onto the parent document would
 * hand every keystroke to the editor's shortcut layer.
 *
 * Portal mode only (`live-05`, STATE.md, Batch 3) — reads the frame's native
 * `Document` through `PortalFrameAdapter`'s escape hatch (`getPortalWindow`).
 * A bridge frame's wheel and pan presses  * the wire instead: the runtime
 * forwards them as `wheel`/`pointer` messages and
 * `useBridgeFrameInteraction` (`live-12`/`live-13`) replays them on the
 * iframe element, the same target this hook dispatches to. Its keyboard rides
 * the wire too since P2-B (`key`/`blur` messages → `canvasFrameKeyRelay.ts`).
 * One gap remains there, real and documented rather than silent: the
 * cross-frame drag relay has no bridge-mode equivalent.
 */

import { useEffect, type RefObject } from 'react'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { installFrameDragRelay } from './canvasFrameDragRelay'
import { installCanvasClipboardBridge } from './canvasClipboardBridge'
import { readCanvasPointerRelay } from './canvasPointerRelay'
import { isCanvasSpacePanActive, setCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
import { frameKeyInitFrom, relayFrameBlur, relayFrameKeyDown, relayFrameKeyUp } from './canvasFrameKeyRelay'
import { useEditorStore } from '@site/store/store'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { followPrototypeKeyFromFrame } from './usePrototypePlayTriggers'

export function useIframeEventForwarding(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  adapter: FrameDocumentAdapter | null,
  isLive: boolean,
): void {
  // ── Forward wheel events to the canvas gesture layer ─────────────────
  // Without this, scrolling the wheel while the cursor is over an iframe
  // does nothing — the iframe document doesn't propagate wheel events to
  // the parent. The canvas pan/zoom gesture handlers live in the parent
  // document, attached to the canvas root via useGesture; they need
  // wheel events at the parent's coordinate system. We forward by
  // listening inside the iframe and re-dispatching a new WheelEvent on
  // the iframe element itself (in the parent doc), so it bubbles to the
  // canvas root and useGesture's handler picks it up.
  useEffect(() => {
    // Live frames scroll natively — no pan to forward to.
    if (isLive) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
    const onWheel = (e: WheelEvent) => {
      // Prevent the iframe from doing its own scroll (should be a no-op
      // since we sized the iframe to content, but defensive).
      e.preventDefault()
      const rect = iframe.getBoundingClientRect()
      // The iframe event reports unscaled, iframe-local CSS pixels. The
      // parent canvas needs transformed client pixels so zoom-to-cursor
      // stays anchored under the user's pointer at every canvas scale.
      const clientPoint = iframeLocalPointToParentClientPoint(
        rect,
        { width: iframe.clientWidth, height: iframe.clientHeight },
        { x: e.clientX || 0, y: e.clientY || 0 },
      )
      const forwarded = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: clientPoint.x,
        clientY: clientPoint.y,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
      iframe.dispatchEvent(forwarded)
    }
    // `passive: false` so we can preventDefault on the iframe-internal
    // wheel — otherwise Chrome lets the iframe do its own scroll first.
    iframeDoc.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      iframeDoc.removeEventListener('wheel', onWheel)
    }
  }, [adapter, iframeRef, isLive])

  // ── Forward an OS FILE drag/drop to the board (D2 G15) ────────────────
  // A native `dragover`/`drop` does not cross the iframe boundary, and a
  // frame is exactly where an image dropped from the desktop is meant to
  // land. `useCanvasFileDrop` listens on the parent `window`, so the pair is
  // re-dispatched on the iframe ELEMENT there and bubbles up to it.
  //
  // The rule itself — cancel EVERY drop's default so the browser cannot
  // navigate the frame's document away, relay only the file-carrying ones —
  // lives in `canvasFrameDragRelay.ts`, which is where its reasoning and its
  // test are. This effect is only its lifecycle.
  useEffect(() => {
    // Live frames belong to the running app: a drop there is the app's.
    if (isLive) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
    return installFrameDragRelay(iframeDoc, iframe)
  }, [adapter, iframeRef, isLive])

  // ── Clipboard events (P5-A) ───────────────────────────────────────────
  // ⌘V pressed with focus in this frame raises its `paste` in THIS document,
  // and a native clipboard event does not cross the iframe boundary; the key
  // relay's clone on the parent document raises none. So the bridge listens
  // here too, as `useCanvasClipboardBridge` does in the editor's document.
  // See `canvasClipboardBridge.ts`.
  useEffect(() => {
    // A live frame is the running app: its clipboard is the app's.
    if (isLive) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    return installCanvasClipboardBridge(iframeDoc)
  }, [adapter, isLive])

  // ── Forward pointer events for canvas pan gestures + parent-doc canvas drags ────
  // The canvas pan gesture (useCanvas via @use-gesture) and the canvas
  // parent-doc canvas drag handlers both live in the parent document
  // and rely on `window` pointer events. Two scenarios need to cross
  // the iframe boundary from inside the iframe back to the parent:
  //
  //   1. Space + left-click drag (Figma convention) — pan when the user
  //      is holding space, even with the cursor over a frame.
  //   2. An active canvas drag started outside the iframe (selection
  //      toolbar handle, media panel asset, etc.). The
  //      pointer down fires in the parent, then as the cursor enters an
  //      iframe its pointermove/up events go to the iframe instead of
  //      bubbling up to `window`. Canvas drag hooks set
  //      `data-studio-canvas-dragging` on `<html>` so each iframe knows to
  //      forward pointermove / up / cancel events while the drag is in
  //      flight. The drag id is also stashed so we can mint forwarded
  //      events with the matching pointerId.
  //
  // For (2) we mirror the spacebar tracking that lives inside `useCanvas`
  // but install it on the iframe document so the iframe knows whether
  // space is currently held. When pointerdown fires with space active,
  // we (a) forward the event so the canvas pan handler sees it, and
  // (b) `preventDefault` so the iframe doesn't also send the original
  // pointer event into module selection logic (otherwise a module would
  // get selected while the user was trying to pan).
  useEffect(() => {
    // Pan-gesture / parent-doc canvas-drag relay is canvas-only. Live frames
    // neither pan nor host the cross-frame canvas drag.
    if (isLive) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
    let spaceHeld = false
    // Clicking a node to select it focuses this iframe, so every subsequent
    // keystroke is delivered to the iframe document instead of the parent,
    // where the editor's key dispatcher and the window-level ⌘S / ⌘K live.
    // `canvasFrameKeyRelay.ts` bridges it: a keydown CLONE on the parent
    // `document` (never on the iframe element — that would double-fire
    // anything listening via fiber bubbling), and the keyup into the
    // dispatcher's release broadcast. Dispatching on the parent document also
    // keeps the clone out of this iframe document, so it never loops back.
    const parentDocument = iframe.ownerDocument
    const onKeyDown = (e: KeyboardEvent) => {
      // While inline text editing, the contentEditable node owns the keyboard.
      // Stand the whole canvas key layer down: don't track space-pan, don't
      // touch Tab, and DON'T forward the keystroke to the parent document.
      // The clone's target is `document`, not the cross-realm editing
      // element, so no target-based guard in the parent could tell it was
      // typing. The dispatcher's `inline-edit` rung would halt it anyway; the
      // window-level listeners (⌘S aside, which must survive an edit) would
      // not. The worst case is Cmd+Z running the store `undo()` (reverting
      // the whole coalesced session) while the DOM keeps the text — store and
      // DOM diverge. The element's own React onKeyDown owns Escape/Enter.
      if (useEditorStore.getState().activeInlineEdit) return
      if (e.code === 'Space') spaceHeld = true
      // Tab is cancelled HERE, always: the author is designing the page, not
      // using it, and letting Tab walk its links and buttons draws the
      // browser's focus ring inside the design and traps the keyboard in the
      // frame. It is still FORWARDED (P2-B, IX-3) — with a node selected the
      // `node` rung reads it as "select the next sibling".
      if (e.key === 'Tab') e.preventDefault()
      // A parent handler claimed the key (⌘K, ⌘S, Delete, …): suppress the
      // iframe's own default too, so the browser does not ALSO act on it
      // (e.g. the native ⌘S save dialog).
      if (relayFrameKeyDown(parentDocument, frameKeyInitFrom(e))) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld = false
      relayFrameKeyUp(parentDocument, frameKeyInitFrom(e))
    }
    // ERR-11 — Alt-Tab with focus in this frame blurs THIS window, and the
    // parent hears nothing (its own blur fired when the frame took focus).
    const frameWindow = iframeDoc.defaultView
    const onFrameBlur = () => {
      spaceHeld = false
      relayFrameBlur(parentDocument)
    }
    iframeDoc.addEventListener('keydown', onKeyDown)
    iframeDoc.addEventListener('keyup', onKeyUp)
    frameWindow?.addEventListener('blur', onFrameBlur)

    const forwardPointer = (e: PointerEvent, overridePointerId?: number) => {
      const rect = iframe.getBoundingClientRect()
      const clientPoint = iframeLocalPointToParentClientPoint(
        rect,
        { width: iframe.clientWidth, height: iframe.clientHeight },
        { x: e.clientX || 0, y: e.clientY || 0 },
      )
      const forwarded = new PointerEvent(e.type, {
        bubbles: true,
        cancelable: true,
        pointerId: overridePointerId ?? e.pointerId,
        pointerType: e.pointerType,
        button: e.button,
        buttons: e.buttons,
        clientX: clientPoint.x,
        clientY: clientPoint.y,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
      iframe.dispatchEvent(forwarded)
    }
    const isCanvasDragActive = (): { pointerId: number } | null => {
      const ownerDoc = iframe.ownerDocument
      return ownerDoc ? readCanvasPointerRelay(ownerDoc) : null
    }
    // True while a pan gesture started inside this iframe is still in
    // flight (space+left-click hold). We start a pan on pointerdown when
    // the conditions match and keep forwarding every subsequent pointermove
    // / pointerup for the same pointerId until the button comes back up.
    // This is the only way to know that a stray pointermove is "part of an
    // active pan" — `e.buttons` is 0 on the final pointerup, and using
    // `e.button === 0` to detect "left is down during move" matches every
    // casual mouse motion (because pointermove always reports `button` as 0).
    // Tracking explicitly is the only correct option.
    let panPointerId: number | null = null
    const isPanStartPointer = (e: PointerEvent): boolean => {
      return shouldStartCanvasPointerPan(e, {
        spaceHeld: spaceHeld || isCanvasSpacePanActive(parentDocument),
      })
    }
    const maybeForward = (e: PointerEvent) => {
      // (2) An external canvas drag is in progress — forward move/up/
      // cancel so the parent's `window` listeners keep ticking.
      // pointerdown is excluded: the iframe never originates the drag,
      // and forwarding the first iframe-internal pointerdown would
      // confuse the parent's session state.
      const dragSignal = isCanvasDragActive()
      if (dragSignal && (e.type === 'pointermove' || e.type === 'pointerup' || e.type === 'pointercancel')) {
        // The iframe-internal event is harmless on its own (no selection
        // logic listens for raw pointermove inside the iframe), so we
        // don't swallow it — but we do forward it to the parent doc with
        // the original drag's pointerId so the session-id check in
        // the parent drag session is consistent.
        forwardPointer(e, dragSignal.pointerId)
        return
      }

      if (e.type === 'pointerdown' && isPanStartPointer(e)) {
        panPointerId = e.pointerId
        // Swallow the original so the click doesn't also trigger module
        // selection while the user is intentionally panning.
        e.preventDefault()
        e.stopPropagation()
        forwardPointer(e)
        return
      }

      if (panPointerId !== null && e.pointerId === panPointerId) {
        if (e.type === 'pointermove') {
          if (spaceHeld) {
            e.preventDefault()
            e.stopPropagation()
          }
          forwardPointer(e)
          return
        }
        if (e.type === 'pointerup' || e.type === 'pointercancel') {
          forwardPointer(e)
          panPointerId = null
          return
        }
      }
    }
    iframeDoc.addEventListener('pointerdown', maybeForward)
    iframeDoc.addEventListener('pointermove', maybeForward)
    iframeDoc.addEventListener('pointerup', maybeForward)
    iframeDoc.addEventListener('pointercancel', maybeForward)
    return () => {
      setCanvasSpacePanActive(parentDocument, 'iframe', false)
      iframeDoc.removeEventListener('keydown', onKeyDown)
      iframeDoc.removeEventListener('keyup', onKeyUp)
      frameWindow?.removeEventListener('blur', onFrameBlur)
      iframeDoc.removeEventListener('pointerdown', maybeForward)
      iframeDoc.removeEventListener('pointermove', maybeForward)
      iframeDoc.removeEventListener('pointerup', maybeForward)
      iframeDoc.removeEventListener('pointercancel', maybeForward)
    }
  }, [adapter, iframeRef, isLive])

  // ── A `key` prototype trigger, raised inside a LIVE frame ────────────────
  //
  // The only keyboard this hook carries into a live frame, and it is
  // deliberately NOT the clone-onto-the-parent-document mechanism the design
  // canvas uses above. A live frame is the page as a visitor gets it: the user
  // may well be typing into an authored form field, and cloning those
  // keystrokes onto `document` would hand every one of them to the editor's
  // undo, save, spotlight and panel-rail shortcuts.
  //
  // So the keystroke is offered to exactly one consumer, by direct call.
  // `followPrototypeKeyFromFrame` stands down unless the player is armed, the
  // event carries no modifier, and the target is not a text input — so an
  // unarmed live frame pays one function call per keystroke and nothing else.
  useEffect(() => {
    if (!isLive) return
    if (!isPortalFrameAdapter(adapter)) return
    const iframeDoc = adapter.getPortalWindow()?.document
    if (!iframeDoc) return
    const onKeyDown = (e: KeyboardEvent) => followPrototypeKeyFromFrame(e)
    iframeDoc.addEventListener('keydown', onKeyDown)
    return () => iframeDoc.removeEventListener('keydown', onKeyDown)
  }, [adapter, isLive])
}
