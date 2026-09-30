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
 * ## The same drag as a portal frame
 *
 * Every rule the portal drag applies is a shared `@core/studio-runtime`
 * module, so a live frame's resize behaves identically:
 *
 *  - geometry: `elementResizeRules.ts`, from `elementResizeMeasure.ts`'s
 *    pointerdown read — `box-sizing`, the live ⇧/⌥ modifiers and a
 *    positioned element's offsets (IX-6a/c/d);
 *  - the Fixed companions (IX-6b, canvas-23): `elementResizeSizing.ts`, fed
 *    the node's stored sizing markers the parent sends with the target
 *    ({@link ResizeTargetContext}) — without them a `flex: 1` item tracked
 *    the cursor and snapped back on release;
 *  - edge snapping (IX-6e, canvas-26): `elementResizeSnapRules.ts`, against
 *    the tree siblings and parent the parent names, at the screen-px
 *    threshold for the zoom it sends. The guides go back over the wire
 *    (`onGuides`) and are painted in the parent, like a portal drag's.
 *
 * ## Preview through a stylesheet, not the element's own `style`
 *
 * During the drag the patch is previewed by stamping the element with
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
 * A companion that CLEARS a property is previewed as the value the cascade
 * gives it without the inline declaration (`readClearedValues`), because a
 * stylesheet can override an inline declaration but never remove one.
 *
 * `!important` on the preview rule is deliberate and runtime-owned: the
 * element's own inline declarations are exactly what the preview has to beat.
 *
 * ## The drag is a gesture (`onGestureChange`)
 *
 * The W×H badge hangs below the element. At the very bottom of a live frame
 * it overflows the body, and a height report taken mid-drag would grow the
 * frame by the badge — permanently, because the fit pin only grows. The
 * runtime freezes its height reports between the two calls, as a portal
 * frame's `beginCanvasGesture` freezes its refit, and reports once after.
 */
import { Value } from '@sinclair/typebox/value'
import { guardDragSession } from './dragSessionGuard'
import { readResizeBoxStart } from './elementResizeMeasure'
import {
  isSizeableDisplay,
  MIN_ELEMENT_SIZE,
  RESIZE_HANDLES,
  resizeElementBox,
  resizeModifiersOf,
  resizeStartStep,
  type ResizeHandle,
} from './elementResizeRules'
import {
  planResizeSizing,
  readClearedValues,
  resizeInlinePatch,
  stylesheetPreviewDeclarations,
  type ResizeInlinePatch,
} from './elementResizeSizing'
import { readResizeSnapInput, resizeSnapEdges, snapRectOf, snapResizeDelta } from './elementResizeSnapRules'
import { presentedElementOf, rectRelativeToBody } from './nodeDom'
import {
  ResizeCommitPatchSchema,
  type ResizeCommitPatch,
  type ResizeSizingMarkers,
  type ResizeSnapContext,
} from './resizeMessages'
import { ALL_SNAP_SOURCES, snapGuidesEqual, type SnapGuide } from './snapRules'

/** The attribute the frame element carries — `selectionChromeCss.ts` styles it. */
export const RESIZE_FRAME_ATTR = 'data-canvas-resize-frame'
/** The attribute each handle carries, naming the direction it drags — `selectionChromeCss.ts` styles it. */
export const RESIZE_HANDLE_ATTR = 'data-canvas-resize-handle'
/**
 * P5-F / IX-25 — the four rotation zones just outside the corners, naming the
 * corner each sits by. Rendered by the portal-mode handles only
 * (`CanvasResizeHandles`); `selectionChromeCss.ts` places and styles them.
 */
export const ROTATE_HANDLE_ATTR = 'data-canvas-rotate-handle'
/** The corners a rotation zone sits outside of. */
export const ROTATE_CORNERS = ['nw', 'ne', 'se', 'sw'] as const
/** On the frame for exactly the length of a rotation; `selectionChromeCss.ts` swaps the cursor under it. */
export const ROTATE_ACTIVE_ATTR = 'data-canvas-rotating'
/** On the frame for exactly the length of a drag; `selectionChromeCss.ts` shows the size badge under it. */
export const RESIZE_ACTIVE_ATTR = 'data-canvas-resizing'
/** The W×H badge inside the frame (IX-18). */
export const RESIZE_SIZE_BADGE_ATTR = 'data-canvas-size-badge'
/** Stamped on the element whose size is being previewed; the preview rule keys on it. */
export const RESIZE_PREVIEW_ATTR = 'data-studio-resize-preview'
export const RESIZE_PREVIEW_STYLE_ID = 'studio-runtime-resize-preview'

/**
 * Write the W×H badge's text: the MEASURED border box, in frame px, rounded —
 * what the user sees, which under `content-box` is more than the `width` the
 * drag writes. Skips the write when the text is unchanged (a same-value
 * `textContent` write still replaces the text node).
 */
export function writeSizeBadge(badge: HTMLElement, width: number, height: number): void {
  const label = `${Math.round(width)} × ${Math.round(height)}`
  if (badge.textContent !== label) badge.textContent = label
}

export interface ResizeTargetRef {
  nodeId: string
  occurrenceIndex: number
}

/** What the parent knows about the target that the frame cannot: its stored sizing markers, and its tree siblings, parent and zoom. */
export interface ResizeTargetContext {
  sizing: ResizeSizingMarkers
  snap: ResizeSnapContext | null
}

const NO_CONTEXT: ResizeTargetContext = { sizing: {}, snap: null }

export interface ResizeHandlesOptions {
  doc: Document
  view: Window
  /** The overlay root the frame mounts in — the rings' own, created lazily by the caller. */
  ensureOverlayRoot(): HTMLElement | null
  /** The element carrying a node ref, or `null` when the frame has none — the target, and every snap peer. */
  resolveTarget(target: ResizeTargetRef): Element | null
  /** A finished drag that changed the element — the caller relays it to the parent. */
  onCommit(target: ResizeTargetRef, patch: ResizeCommitPatch): void
  /** The snap guides of the drag changed (`[]` once it ends) — the caller relays them to the parent. */
  onGuides(guides: readonly SnapGuide[]): void
  /** A drag started (`true`) or ended (`false`) — see "The drag is a gesture" above. */
  onGestureChange(active: boolean): void
  /** The preview moved the element's box — the caller repositions its rings. */
  onPreview(): void
}

export interface ResizeHandlesController {
  /** Shows the handles on `target` (or hides them for `null`); `scaleTool` is `K4`'s scale tool, `context` what the parent knows — both read at pointerdown. */
  setTarget(target: ResizeTargetRef | null, scaleTool: boolean, context?: ResizeTargetContext): void
  /** Re-reads the target's box — the caller's ring reposition pass calls this. */
  reposition(): void
  /** Drops the held preview; the source now carries the size, or the target moved on. */
  clearPreview(): void
  dispose(): void
}

/** The wire form of a patch: a clear is `null` (the source's own "remove this key"), and only what the wire accepts goes out. */
function toCommitPatch(patch: ResizeInlinePatch): ResizeCommitPatch | null {
  const wire = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null]))
  return Value.Check(ResizeCommitPatchSchema, wire) ? wire : null
}

export function installResizeHandles(options: ResizeHandlesOptions): ResizeHandlesController {
  const { doc, view, ensureOverlayRoot, resolveTarget, onCommit, onGuides, onGestureChange, onPreview } = options

  let frame: HTMLDivElement | null = null
  let sizeBadge: HTMLDivElement | null = null
  let target: ResizeTargetRef | null = null
  let context: ResizeTargetContext = NO_CONTEXT
  let element: HTMLElement | null = null
  let scaleTool = false
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
    sizeBadge = doc.createElement('div')
    sizeBadge.setAttribute(RESIZE_SIZE_BADGE_ATTR, 'true')
    frame.appendChild(sizeBadge)
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
    // IX-18 — the badge reads the SAME measured box the frame was just placed
    // on, so it can never disagree with the handles around it.
    if (endDrag && sizeBadge) writeSizeBadge(sizeBadge, rect.width, rect.height)
  }

  function setTarget(next: ResizeTargetRef | null, nextScaleTool: boolean, nextContext: ResizeTargetContext = NO_CONTEXT): void {
    scaleTool = nextScaleTool
    context = nextContext
    const changed = next?.nodeId !== target?.nodeId || next?.occurrenceIndex !== target?.occurrenceIndex
    if (changed) {
      endDrag?.(false)
      clearPreview()
    }
    target = next
    const own = next ? resolveTarget(next) : null
    const presented = own ? presentedElementOf(view, own) : null
    element = presented && isSizeableDisplay(view.getComputedStyle(presented).display, presented.localName) ? presented : null
    if (!element) {
      hide()
      return
    }
    reposition()
  }

  function writePreview(el: HTMLElement, patch: ResizeInlinePatch | null, cleared: Readonly<Record<string, string>>): void {
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
    const declarations = stylesheetPreviewDeclarations(patch ?? {}, cleared).map(([name, value]) => `${name}: ${value} !important`)
    previewStyle.textContent = declarations.length > 0 ? `[${RESIZE_PREVIEW_ATTR}] { ${declarations.join('; ')}; }` : ''
  }

  function clearPreview(): void {
    previewed?.removeAttribute(RESIZE_PREVIEW_ATTR)
    previewed = null
    previewStyle?.remove()
    previewStyle = null
  }

  /** A snap peer's presented element — the same "what the user sees" descent the target gets. */
  function resolvePeer(ref: ResizeTargetRef): Element | null {
    const own = resolveTarget(ref)
    return own ? presentedElementOf(view, own) : null
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
    const keepRatio = scaleTool
    const start = readResizeBoxStart(view, dragged)
    // IX-6b — the Fixed companions, and what each cleared one renders at.
    const plan = planResizeSizing(view, dragged, start, context.sizing)
    const cleared = readClearedValues(view, dragged, plan)
    // IX-6e — what the moving edge snaps to, read once, before the first write.
    const snap = context.snap
    const snapInput = snap
      ? readResizeSnapInput({
          view,
          element: dragged,
          siblings: snap.siblings,
          parent: snap.parent,
          resolveElement: resolvePeer,
          resolveRect: snapRectOf,
          zoom: snap.zoom,
          // P5-F — the board's ruler guides and the editor's snap toggles do
          // not cross the wire yet (`ResizeSnapContext` carries neither): a
          // live frame snaps to its peers only, with both toggles on.
          guideLines: [],
          preferences: ALL_SNAP_SOURCES,
        })
      : null
    const startX = event.clientX
    const startY = event.clientY
    let pointer = { x: startX, y: startY }
    let modifiers = resizeModifiersOf(event, keepRatio)
    let last = resizeStartStep(start)
    let guides: readonly SnapGuide[] = []
    let postedGuides: readonly SnapGuide[] = []

    try {
      handleEl.setPointerCapture(event.pointerId)
    } catch (_err) {
      // A capture the browser refuses (a pointer already released) is not
      // fatal — the document-level listeners below still drive the drag.
    }

    const postGuides = () => {
      if (snapGuidesEqual(guides, postedGuides)) return
      postedGuides = guides
      onGuides(guides)
    }

    // Coalesced to ONE write per animation frame: a pointermove stream runs
    // well past 60Hz, and every preview write lays the page out again.
    let pendingFrame: number | null = null
    const raf = view.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
    const caf = view.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame
    const applyPending = () => {
      pendingFrame = null
      writePreview(dragged, resizeInlinePatch(start, last, plan), cleared)
      reposition()
      onPreview()
      postGuides()
    }
    const step = () => {
      const dx = pointer.x - startX
      const dy = pointer.y - startY
      const snapped = snapInput
        ? snapResizeDelta(
            resizeSnapEdges(handle, modifiers, start.offsets !== null, snapInput.anchored),
            snapInput.rect,
            dx,
            dy,
            snapInput.peers,
            snapInput.threshold,
          )
        : { dx, dy, guides: [] }
      guides = snapped.guides
      last = resizeElementBox(handle, start, snapped.dx, snapped.dy, modifiers, MIN_ELEMENT_SIZE)
      pendingFrame ??= raf(applyPending)
    }
    const onMove = (moveEvent: PointerEvent) => {
      pointer = { x: moveEvent.clientX, y: moveEvent.clientY }
      modifiers = resizeModifiersOf(moveEvent, keepRatio)
      step()
    }
    const finish = (commit: boolean) => {
      endDrag = null
      disposeGuard()
      frame?.removeAttribute(RESIZE_ACTIVE_ATTR)
      if (pendingFrame !== null) caf(pendingFrame)
      doc.removeEventListener('pointermove', onMove, true)
      doc.removeEventListener('pointerup', onUp, true)
      doc.removeEventListener('pointercancel', onCancel, true)
      doc.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('keyup', onKey, true)
      try {
        handleEl.releasePointerCapture(event.pointerId)
      } catch (_err) {
        // Already released with the pointer — nothing to undo.
      }
      guides = []
      postGuides()
      const patch = commit ? resizeInlinePatch(start, last, plan) : null
      const wire = patch ? toCommitPatch(patch) : null
      if (!patch || !wire) {
        // Nothing to wait for from the source: a cancelled drag, one that came
        // back to its start, or a patch the wire would refuse — drop the
        // preview now.
        clearPreview()
        reposition()
        onPreview()
        onGestureChange(false)
        return
      }
      // The preview stays up (see the module doc) — write it once more so the
      // last pointer position is what stays on screen, then hand the patch out.
      writePreview(dragged, patch, cleared)
      reposition()
      onPreview()
      onGestureChange(false)
      onCommit(draggedTarget, wire)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    // IX-6c — ⇧/⌥ take effect the moment they change, not on the next move.
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.type === 'keydown' && keyEvent.key === 'Escape') {
        finish(false)
        return
      }
      if (keyEvent.key !== 'Shift' && keyEvent.key !== 'Alt') return
      // A bare Alt release focuses the browser's menu on Windows, which would
      // blur the page and abandon the drag through the guard below.
      if (keyEvent.key === 'Alt') keyEvent.preventDefault()
      modifiers = resizeModifiersOf(keyEvent, keepRatio)
      step()
    }
    endDrag = finish
    frame?.setAttribute(RESIZE_ACTIVE_ATTR, 'true')
    onGestureChange(true)
    // Seeded from the start box so the first painted frame already reads right.
    if (sizeBadge) writeSizeBadge(sizeBadge, start.width + start.insetWidth, start.height + start.insetHeight)

    // ERR-12 — registered BEFORE the session's own listeners, so a move with
    // the button already up finishes the drag before it is read as a step.
    const disposeGuard = guardDragSession({
      documents: [doc],
      focusWindow: view,
      onReleaseLost: () => finish(true),
      onAbandon: () => finish(false),
    })
    // Capture phase, deliberately: `gestureForwarding.ts` stops a design-mode
    // pointer's propagation at the document in ITS capture listener, and a
    // release that lands on the page (a browser that refused the pointer
    // capture above) would otherwise never reach a bubble listener here —
    // and the drag would never end. Same object, same phase: both run.
    doc.addEventListener('pointermove', onMove, true)
    doc.addEventListener('pointerup', onUp, true)
    doc.addEventListener('pointercancel', onCancel, true)
    doc.addEventListener('keydown', onKey, true)
    doc.addEventListener('keyup', onKey, true)
  }

  return {
    setTarget,
    reposition,
    clearPreview,
    dispose() {
      endDrag?.(false)
      clearPreview()
      frame?.removeEventListener('pointerdown', onPointerDown)
      frame?.remove()
      frame = null
      sizeBadge = null
      element = null
      target = null
    },
  }
}
