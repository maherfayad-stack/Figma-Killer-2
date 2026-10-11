/**
 * resizeSession — the geometry of one element resize inside a live (Tier 2)
 * frame: the part of the drag only the frame can see (`live-13`).
 *
 * ## What is where (SB-4)
 *
 * The handles, the pointer capture and the W×H badge are the PARENT's
 * (`CanvasResizeHandles`, `useBridgeResizeDrag`), the same elements and the same
 * drag session a same-origin frame gets — nothing is drawn inside a live frame's
 * document any more. The parent owns the POLICY (which node, and whether its
 * module can carry an inline style at all — `resizeOffer.ts`) and the WRITE (the
 * commit reaches the user's source through the store, never from here). This
 * module owns what the frame alone can read: the element's computed layout, its
 * parent's, the cascade, the snap peers' boxes. It is driven over the wire:
 * `resize:begin` (a handle was pressed), `resize:step` (the pointer moved, in
 * frame px, with ⇧ / ⌥), `resize:end` (released or cancelled).
 *
 * ## The same drag as a portal frame
 *
 * Every rule the portal drag applies is a shared `@core/studio-runtime`
 * module, so a live frame's resize behaves identically:
 *
 *  - geometry: `elementResizeRules.ts`, from `elementResizeMeasure.ts`'s
 *    drag-start read — `box-sizing`, the live ⇧/⌥ modifiers and a positioned
 *    element's offsets (IX-6a/c/d);
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
 * `RESIZE_PREVIEW_ATTR` and writing ONE rule for it into a runtime-owned
 * `<style>`. The portal drag writes `element.style.width` directly and clears it
 * before the store commit, because there React re-renders in the same tick. Here
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
 * The parent's W×H badge hangs below the element and a report of the body's
 * height taken mid-drag would grow the frame under the cursor — permanently,
 * because the fit pin only grows. The runtime freezes its height reports between
 * the two calls, as a portal frame's `beginCanvasGesture` freezes its refit,
 * and reports once after.
 */
import { Value } from '@sinclair/typebox/value'
import { anchorResizePatch, resizeAnchorPlan } from './elementResizeAnchors'
import { readResizeBoxStart } from './elementResizeMeasure'
import {
  isSizeableDisplay,
  MIN_ELEMENT_SIZE,
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
import { presentedElementOf } from './nodeDom'
import {
  ResizeCommitPatchSchema,
  type ResizeAnchors,
  type ResizeCommitPatch,
  type ResizeSizingMarkers,
  type ResizeSnapContext,
} from './resizeMessages'
import { ALL_SNAP_SOURCES, snapGuidesEqual, type SnapGuide } from './snapRules'

/** Stamped on the element whose size is being previewed; the preview rule keys on it. */
export const RESIZE_PREVIEW_ATTR = 'data-studio-resize-preview'
export const RESIZE_PREVIEW_STYLE_ID = 'studio-runtime-resize-preview'

export interface ResizeTargetRef {
  nodeId: string
  occurrenceIndex: number
}

/** What the parent knows about the target that the frame cannot: its stored sizing markers, its tree siblings, parent and zoom, and the offsets its source authors. */
export interface ResizeTargetContext {
  sizing: ResizeSizingMarkers
  snap: ResizeSnapContext | null
  /** PA-8 — which offsets the source anchors the target by; `null` writes the default `left` / `top`. */
  anchors: ResizeAnchors | null
}

const NO_CONTEXT: ResizeTargetContext = { sizing: {}, snap: null, anchors: null }

export interface ResizeSessionOptions {
  doc: Document
  view: Window
  /** The element carrying a node ref, or `null` when the frame has none — the target, and every snap peer. */
  resolveTarget(target: ResizeTargetRef): Element | null
  /** A finished drag that changed the element — the caller relays it to the parent. */
  onCommit(target: ResizeTargetRef, patch: ResizeCommitPatch): void
  /** The snap guides of the drag changed (`[]` once it ends) — the caller relays them to the parent. */
  onGuides(guides: readonly SnapGuide[]): void
  /** A drag started (`true`) or ended (`false`) — see "The drag is a gesture" above. */
  onGestureChange(active: boolean): void
}

export interface ResizeSessionController {
  /** Names the node a drag would resize (or `null`); `scaleTool` is `K4`'s scale tool, `context` what the parent knows — both read at `begin`. */
  setTarget(target: ResizeTargetRef | null, scaleTool: boolean, context?: ResizeTargetContext): void
  /** A handle was pressed. `false` when there is no sizeable target (nothing is previewed or latched then). */
  begin(handle: ResizeHandle): boolean
  /** The pointer moved to (`dx`, `dy`) frame px from where `begin` was pressed, with the modifiers held now. */
  step(dx: number, dy: number, modifiers: { shiftKey: boolean; altKey: boolean }): void
  /** The drag ended: `commit` writes it, otherwise the preview is dropped. A no-op with no drag in flight. */
  end(commit: boolean): void
  /** Drops the held preview; the source now carries the size, or the target moved on. */
  clearPreview(): void
  dispose(): void
}

/** The wire form of a patch: a clear is `null` (the source's own "remove this key"), and only what the wire accepts goes out. */
function toCommitPatch(patch: ResizeInlinePatch): ResizeCommitPatch | null {
  const wire = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? null]))
  return Value.Check(ResizeCommitPatchSchema, wire) ? wire : null
}

export function installResizeSession(options: ResizeSessionOptions): ResizeSessionController {
  const { doc, view, resolveTarget, onCommit, onGuides, onGestureChange } = options

  let target: ResizeTargetRef | null = null
  let context: ResizeTargetContext = NO_CONTEXT
  let element: HTMLElement | null = null
  let scaleTool = false
  let previewed: HTMLElement | null = null
  let previewStyle: HTMLStyleElement | null = null
  let drag: { step(dx: number, dy: number, modifiers: { shiftKey: boolean; altKey: boolean }): void; finish(commit: boolean): void } | null = null

  function setTarget(next: ResizeTargetRef | null, nextScaleTool: boolean, nextContext: ResizeTargetContext = NO_CONTEXT): void {
    scaleTool = nextScaleTool
    context = nextContext
    const changed = next?.nodeId !== target?.nodeId || next?.occurrenceIndex !== target?.occurrenceIndex
    if (changed) {
      drag?.finish(false)
      clearPreview()
    }
    target = next
    const own = next ? resolveTarget(next) : null
    const presented = own ? presentedElementOf(view, own) : null
    element = presented && isSizeableDisplay(view.getComputedStyle(presented).display, presented.localName) ? presented : null
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

  function begin(handle: ResizeHandle): boolean {
    if (!element || !target) return false
    // A second press while one drag is out (a lost release): the old one is over.
    drag?.finish(false)

    const dragged = element
    const draggedTarget = target
    const keepRatio = scaleTool
    const start = readResizeBoxStart(view, dragged)
    // IX-6b — the Fixed companions, and what each cleared one renders at.
    const plan = planResizeSizing(view, dragged, start, context.sizing)
    const cleared = readClearedValues(view, dragged, plan)
    // PA-8 / IX-21 — the offsets the source anchors the layer by, so a W drag on
    // a `right`-anchored layer writes the width alone. Read once, like `plan`.
    const anchors = start.offsets && context.anchors ? resizeAnchorPlan(context.anchors, view.getComputedStyle(dragged)) : null
    const patchAt = (resized: typeof last) => anchorResizePatch(resizeInlinePatch(start, resized, plan), start, resized, anchors)
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
    let last = resizeStartStep(start)
    let guides: readonly SnapGuide[] = []
    let postedGuides: readonly SnapGuide[] = []

    const postGuides = () => {
      if (snapGuidesEqual(guides, postedGuides)) return
      postedGuides = guides
      onGuides(guides)
    }

    const session = {
      step(dx: number, dy: number, held: { shiftKey: boolean; altKey: boolean }) {
        // IX-6c — ⇧/⌥ take effect the moment they change, not on the next move.
        const modifiers = resizeModifiersOf(held, keepRatio)
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
        writePreview(dragged, patchAt(last), cleared)
        postGuides()
      },
      finish(commit: boolean) {
        drag = null
        guides = []
        postGuides()
        const patch = commit ? patchAt(last) : null
        const wire = patch ? toCommitPatch(patch) : null
        if (!patch || !wire) {
          // Nothing to wait for from the source: a cancelled drag, one that came
          // back to its start, or a patch the wire would refuse — drop the
          // preview now.
          clearPreview()
          onGestureChange(false)
          return
        }
        // The preview stays up (see the module doc) — write it once more so the
        // last pointer position is what stays on screen, then hand the patch out.
        writePreview(dragged, patch, cleared)
        onGestureChange(false)
        onCommit(draggedTarget, wire)
      },
    }
    drag = session
    onGestureChange(true)
    return true
  }

  return {
    setTarget,
    begin,
    step: (dx, dy, modifiers) => drag?.step(dx, dy, modifiers),
    end: (commit) => drag?.finish(commit),
    clearPreview,
    dispose() {
      drag?.finish(false)
      clearPreview()
      element = null
      target = null
    },
  }
}
