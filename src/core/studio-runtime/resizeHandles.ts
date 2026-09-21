/**
 * resizeHandles — the eight drag handles on a selected element, drawn and
 * dragged INSIDE the frame document (`live-13`).
 *
 * A portal frame's handles are React elements the parent portals into the
 * frame's own overlay root (`CanvasResizeHandles.tsx`) and drags from the
 * parent (`useElementResizeDrag.ts`), which a same-origin document allows. A
 * Tier 2 bridge frame is cross-origin: the parent can neither portal into it
 * nor read the pointer inside it, so the handles have to be the runtime's, on
 * the frame's side of the wire — the same split every ring already lives by
 * (`runtime.ts`, "the frame owns DOM + positioning"). The parent still owns
 * the POLICY (which node, and whether its module can carry an inline style at
 * all — `resizeOffer.ts`) and the WRITE (the commit reaches the user's source
 * through the store, never from here); this module owns the geometry the
 * frame alone can see.
 *
 * ## Preview through a stylesheet, not the element's own `style`
 *
 * During the drag the size is previewed by stamping the element with
 * `PREVIEW_ATTR` and writing ONE rule for it into a runtime-owned `<style>`.
 * The portal drag writes `element.style.width` directly and clears it before
 * the store commit, because there React re-renders in the same tick. Here
 * the commit is a `postMessage`, a file write and a Vite HMR round trip
 * later, and React's re-render will write the SAME `style.width` this drag
 * would have previewed — so an inline preview could never be cleared safely:
 * removing it after the commit deletes React's value, removing it before
 * snaps the element back to its old size for the length of the round trip.
 * A stylesheet rule shares nothing with React's inline style, so it can stay
 * up until the source carries the size (`clearPreview`, on the runtime's
 * `hmr:after`) and is then removed without touching what React wrote. A
 * commit the parent refused never produces that HMR, so the preview lasts
 * until the next target change, where the snap-back is the honest answer.
 *
 * `!important` on the preview rule is deliberate and runtime-owned: the
 * element's own inline width is exactly what the preview has to beat.
 */
import {
  isSizeableDisplay,
  MIN_ELEMENT_SIZE,
  RESIZE_HANDLES,
  resizeElementSize,
  resizeStylePatch,
  type ElementSize,
  type ElementSizePatch,
  type ResizeHandle,
} from './elementResizeRules'
import { presentedElementOf, rectRelativeToBody } from './nodeDom'

/** The attribute the frame element carries — `selectionChromeCss.ts` styles it. */
export const RESIZE_FRAME_ATTR = 'data-canvas-resize-frame'
/** The attribute each handle carries, naming the direction it drags — `selectionChromeCss.ts` styles it. */
export const RESIZE_HANDLE_ATTR = 'data-canvas-resize-handle'
/** Stamped on the element whose size is being previewed; the preview rule keys on it. */
export const RESIZE_PREVIEW_ATTR = 'data-studio-resize-preview'
export const RESIZE_PREVIEW_STYLE_ID = 'studio-runtime-resize-preview'

export interface ResizeTargetRef {
  nodeId: string
  occurrenceIndex: number
}

export interface ResizeHandlesOptions {
  doc: Document
  view: Window
  /** The overlay root the frame mounts in — the rings' own, created lazily by the caller. */
  ensureOverlayRoot(): HTMLElement | null
  /** The element carrying the target's node id, or `null` when the frame has none. */
  resolveTarget(target: ResizeTargetRef): Element | null
  /** A finished drag that changed the size — the caller relays it to the parent. */
  onCommit(target: ResizeTargetRef, patch: ElementSizePatch): void
  /** The preview moved the element's box — the caller repositions its rings. */
  onPreview(): void
}

export interface ResizeHandlesController {
  /** Shows the handles on `target` (or hides them for `null`); `proportional` is `K4`'s scale tool, captured at pointerdown. */
  setTarget(target: ResizeTargetRef | null, proportional: boolean): void
  /** Re-reads the target's box — the caller's ring reposition pass calls this. */
  reposition(): void
  /** The element currently under a live or held preview, or `null` — the caller's layout observer ignores its attribute writes. */
  previewElement(): Element | null
  /** Drops the held preview; the source now carries the size, or the target moved on. */
  clearPreview(): void
  dispose(): void
}

export function installResizeHandles(options: ResizeHandlesOptions): ResizeHandlesController {
  const { doc, view, ensureOverlayRoot, resolveTarget, onCommit, onPreview } = options

  let frame: HTMLDivElement | null = null
  let target: ResizeTargetRef | null = null
  let element: HTMLElement | null = null
  let proportional = false
  let previewed: HTMLElement | null = null
  let previewStyle: HTMLStyleElement | null = null
  let endDrag: ((commit: boolean) => void) | null = null

  function ensureFrame(): HTMLDivElement | null {
    if (frame?.isConnected) return frame
    const root = ensureOverlayRoot()
    if (!root) return null
    frame = doc.createElement('div')
    frame.setAttribute(RESIZE_FRAME_ATTR, 'true')
    frame.style.display = 'none'
    for (const handle of RESIZE_HANDLES) {
      const el = doc.createElement('div')
      el.setAttribute(RESIZE_HANDLE_ATTR, handle)
      frame.appendChild(el)
    }
    frame.addEventListener('pointerdown', onPointerDown)
    root.appendChild(frame)
    return frame
  }

  function hide(): void {
    if (frame) frame.style.display = 'none'
  }

  function reposition(): void {
    if (!element?.isConnected || !doc.body) {
      hide()
      return
    }
    const el = ensureFrame()
    if (!el) return
    const rect = rectRelativeToBody(element, doc.body)
    el.style.display = ''
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`
  }

  function setTarget(next: ResizeTargetRef | null, nextProportional: boolean): void {
    proportional = nextProportional
    const changed = next?.nodeId !== target?.nodeId || next?.occurrenceIndex !== target?.occurrenceIndex
    if (changed) {
      endDrag?.(false)
      clearPreview()
    }
    target = next
    const own = next ? resolveTarget(next) : null
    const presented = own ? presentedElementOf(view, own) : null
    element = presented && isSizeableDisplay(view.getComputedStyle(presented).display) ? presented : null
    if (!element) {
      hide()
      return
    }
    reposition()
  }

  function writePreview(el: HTMLElement, start: ElementSize, next: ElementSize): void {
    if (!previewStyle?.isConnected) {
      previewStyle = doc.createElement('style')
      previewStyle.id = RESIZE_PREVIEW_STYLE_ID
      previewStyle.setAttribute('data-source', 'studio-runtime')
      doc.head?.appendChild(previewStyle)
    }
    if (previewed !== el) {
      previewed?.removeAttribute(RESIZE_PREVIEW_ATTR)
      el.setAttribute(RESIZE_PREVIEW_ATTR, '')
      previewed = el
    }
    const declarations: string[] = []
    if (next.width !== start.width) declarations.push(`width: ${next.width}px !important`)
    if (next.height !== start.height) declarations.push(`height: ${next.height}px !important`)
    previewStyle.textContent = declarations.length > 0 ? `[${RESIZE_PREVIEW_ATTR}] { ${declarations.join('; ')}; }` : ''
  }

  function clearPreview(): void {
    previewed?.removeAttribute(RESIZE_PREVIEW_ATTR)
    previewed = null
    previewStyle?.remove()
    previewStyle = null
  }

  function onPointerDown(event: PointerEvent): void {
    const handleEl = event.target instanceof Element ? event.target.closest<HTMLElement>(`[${RESIZE_HANDLE_ATTR}]`) : null
    const handle = handleEl?.getAttribute(RESIZE_HANDLE_ATTR) as ResizeHandle | null
    if (!handleEl || !handle || !element || !target || event.button !== 0) return
    // A drag on a handle is not a click on the element underneath it.
    event.preventDefault()
    event.stopPropagation()

    const dragged = element
    const draggedTarget = target
    const keepRatio = proportional
    const rect = dragged.getBoundingClientRect()
    const start: ElementSize = { width: rect.width, height: rect.height }
    const startX = event.clientX
    const startY = event.clientY
    let last = start

    try {
      handleEl.setPointerCapture(event.pointerId)
    } catch (_err) {
      // A capture the browser refuses (a pointer already released) is not
      // fatal — the document-level listeners below still drive the drag.
    }

    // Coalesced to ONE write per animation frame: a pointermove stream runs
    // well past 60Hz, and every preview write lays the page out again.
    let pendingFrame: number | null = null
    const raf = view.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
    const caf = view.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame
    const applyPending = () => {
      pendingFrame = null
      writePreview(dragged, start, last)
      reposition()
      onPreview()
    }
    const onMove = (moveEvent: PointerEvent) => {
      last = resizeElementSize(handle, start, moveEvent.clientX - startX, moveEvent.clientY - startY, MIN_ELEMENT_SIZE, keepRatio)
      pendingFrame ??= raf(applyPending)
    }
    const finish = (commit: boolean) => {
      endDrag = null
      if (pendingFrame !== null) caf(pendingFrame)
      doc.removeEventListener('pointermove', onMove, true)
      doc.removeEventListener('pointerup', onUp, true)
      doc.removeEventListener('pointercancel', onCancel, true)
      doc.removeEventListener('keydown', onKeyDown, true)
      try {
        handleEl.releasePointerCapture(event.pointerId)
      } catch (_err) {
        // Already released with the pointer — nothing to undo.
      }
      const patch = commit ? resizeStylePatch(handle, start, last, keepRatio) : null
      if (!patch) {
        // Nothing to wait for from the source: a cancelled drag, or one that
        // came back to its start — drop the preview now.
        clearPreview()
        reposition()
        onPreview()
        return
      }
      // The preview stays up (see the module doc) — write it once more so the
      // last pointer position is what stays on screen, then hand the patch out.
      writePreview(dragged, start, last)
      reposition()
      onPreview()
      onCommit(draggedTarget, patch)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') finish(false)
    }
    endDrag = finish

    // Capture phase, deliberately: `gestureForwarding.ts` stops a design-mode
    // pointer's propagation at the document in ITS capture listener, and a
    // release that lands on the page (a browser that refused the pointer
    // capture above) would otherwise never reach a bubble listener here —
    // and the drag would never end. Same object, same phase: both run.
    doc.addEventListener('pointermove', onMove, true)
    doc.addEventListener('pointerup', onUp, true)
    doc.addEventListener('pointercancel', onCancel, true)
    doc.addEventListener('keydown', onKeyDown, true)
  }

  return {
    setTarget,
    reposition,
    previewElement: () => previewed,
    clearPreview,
    dispose() {
      endDrag?.(false)
      clearPreview()
      frame?.removeEventListener('pointerdown', onPointerDown)
      frame?.remove()
      frame = null
      element = null
      target = null
    },
  }
}
