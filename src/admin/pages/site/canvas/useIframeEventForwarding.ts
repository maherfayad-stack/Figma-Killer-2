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
 * Keyboard
 * ────────
 * Clicking a node to select it focuses the iframe, so subsequent keystrokes go
 * to the iframe document — where none of the editor's parent-level native
 * shortcut listeners can see them. They are cloned onto the parent `document`
 * instead. See `onKeyDown` for the inline-edit stand-down that makes this safe.
 *
 * All of it is canvas-only: live frames pan nothing, host no cross-frame drag,
 * and scroll natively.
 */

import { useEffect, type RefObject } from 'react'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { isCanvasSpacePanActive, setCanvasSpacePanActive, shouldStartCanvasPointerPan } from './canvasPanInput'
import { useEditorStore } from '@site/store/store'

export function useIframeEventForwarding(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  iframeDoc: Document | null,
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
  }, [iframeDoc, iframeRef, isLive])

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
    if (!iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
    let spaceHeld = false
    // Clicking a node to select it focuses this iframe, so every subsequent
    // keystroke is delivered to the iframe document instead of the parent.
    // The editor's global / editor / panel shortcuts are NATIVE listeners on
    // the parent `window` (spotlight ⌘K, save ⌘S) and parent `document`
    // (panel toggles, undo/redo) — none of which see events that fire inside
    // an iframe. We bridge them by re-dispatching a clone on the parent
    // `document`: it reaches every `document`-level listener at the target
    // and every `window`-level listener during capture/bubble.
    //
    // We deliberately dispatch on `document`, NOT on the iframe element. The
    // global shortcut dispatcher and canvas-level native bridge both listen
    // in the parent document; dispatching here keeps the clone out of the
    // iframe document so this listener never sees it again (no loop).
    const parentDocument = iframe.ownerDocument
    const forwardKeyboard = (e: KeyboardEvent) => {
      const forwarded = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: e.key,
        code: e.code,
        location: e.location,
        repeat: e.repeat,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
      parentDocument.dispatchEvent(forwarded)
      // If a parent handler claimed the shortcut (e.g. ⌘K, ⌘S), suppress the
      // iframe's own default for the original key so the browser doesn't also
      // act on it (e.g. native ⌘S save dialog).
      if (forwarded.defaultPrevented) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // While inline text editing, the contentEditable node owns the keyboard.
      // Stand the whole canvas key layer down: don't track space-pan, don't
      // block Tab, and DON'T forward the keystroke to the parent document.
      // Forwarding re-dispatches a clone on `document`, where native handlers
      // (undo/redo, zoom reset, panel rail, space-pan) guard only on
      // `e.target.isContentEditable` — but the clone's target is `document`,
      // not the cross-realm editing element, so they'd fire mid-edit. The
      // worst is Cmd+Z running the store `undo()` (reverting the whole
      // coalesced session) while the DOM keeps the text — store/DOM diverge.
      // The element's own React onKeyDown still owns Escape/Enter.
      if (useEditorStore.getState().activeInlineEdit) return
      if (e.code === 'Space' && !e.repeat) {
        spaceHeld = true
        setCanvasSpacePanActive(parentDocument, 'iframe', true)
      }
      // Block Tab navigation inside the canvas iframe. The author is
      // designing, not using, the page — letting Tab walk through
      // link / button controls inside the iframe surface the browser's
      // default focus outline and traps the keyboard inside the
      // preview. The canvas exposes its own keyboard model
      // (arrow keys / Cmd+navigation) at the parent level.
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      forwardKeyboard(e)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld = false
        setCanvasSpacePanActive(parentDocument, 'iframe', false)
      }
    }
    iframeDoc.addEventListener('keydown', onKeyDown)
    iframeDoc.addEventListener('keyup', onKeyUp)

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
      const html = iframe.ownerDocument?.documentElement
      if (!html) return null
      if (html.dataset.studioCanvasDragging !== '1') return null
      const id = Number(html.dataset.studioCanvasDraggingPointerId ?? NaN)
      return Number.isFinite(id) ? { pointerId: id } : { pointerId: 0 }
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
      iframeDoc.removeEventListener('pointerdown', maybeForward)
      iframeDoc.removeEventListener('pointermove', maybeForward)
      iframeDoc.removeEventListener('pointerup', maybeForward)
      iframeDoc.removeEventListener('pointercancel', maybeForward)
    }
  }, [iframeDoc, iframeRef, isLive])
}
