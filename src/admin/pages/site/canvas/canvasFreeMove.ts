/**
 * canvasFreeMove — K6. Moving an element to a POSITION rather than to a place
 * in the child order, without ever lying about what was written.
 *
 * ## The rule this is allowed to bend, and how far
 *
 * §15 decision 3 of the parity plan stands: Studio does not fake absolute
 * placement of flow elements. Dragging an ordinary element still reorders it,
 * and the canvas still shows the reflow that implies. What decision 6 of the
 * feel plan grants is narrower and explicit — a gesture may write `left`/`top`
 * as an INLINE STYLE, which is one JSX element's `style={{…}}` and therefore
 * one honest target, in exactly two cases:
 *
 *  1. the element is ALREADY `position: absolute | fixed`, so `left`/`top` is
 *     the property that already decides where it is; or
 *  2. the user holds ⌘/Ctrl while dragging, AND the element's containing block
 *     is a positioned ancestor. Here the write also includes
 *     `position: absolute` — without it `left`/`top` on a static element does
 *     nothing at all, and writing a declaration that has no effect is exactly
 *     the silent no-op this codebase refuses to ship.
 *
 * Anything else — ⌘-drag on a flow element whose parent is `position: static`
 * — REFUSES, with the one remedy that is actually true: make that parent
 * `position: relative`. Absolutely positioning an element inside a static
 * parent would silently reparent it to the viewport or to some distant
 * ancestor, which is not what the user pointed at.
 *
 * ## RTL
 *
 * In a right-to-left element the physical `left` is the wrong property: the
 * inline axis runs the other way, so a drag to the right must DECREASE the
 * distance from the inline start. The logical `inset-inline-start` is what an
 * RTL author writes, and it is what gets written here — with the horizontal
 * delta negated, because visual-right is inline-start-ward under `direction:
 * rtl`. `top` is unaffected: RTL mirrors the inline axis only, never the
 * block axis.
 *
 * The property is spelled `insetInlineStart` — the key of the element's
 * `style={{…}}` object, which React only reads in camelCase — and the same
 * choice `inlineOffsetProperty` makes for a resize, so the two gestures never
 * write different offsets. Only the in-frame preview, which talks to the
 * CSSOM, converts it to `inset-inline-start` (`cssPropertyName`). This used
 * to write the kebab key into the source (P2-D's finding, fixed in P2-C).
 *
 * ## Which offsets it writes (P5-E, IX-21)
 *
 * The ones the source AUTHORED, not always `left`/`top`. A layer anchored by
 * `right: 24px` that gained a `left` from a drag carries both, and the next
 * width change moves the wrong edge — or, with a `width: auto`, stretches it.
 * So an already-positioned layer moves through the same plan the arrow-key
 * nudge uses (`planNudge` over `authoredOffsets`): `right` alone moves as
 * `right`, `left` + `right` (a stretched layer) both move, `bottom` moves as
 * `bottom`. A `left: 50%` + `translate(-50%)` centring moves as `left`, from
 * its USED px value, so the translate still centres it where it lands. Only a
 * layer that becomes absolute in this gesture (⌘-drag from flow) has nothing
 * authored, and takes `left` (`insetInlineStart` under RTL) and `top`.
 *
 * ## Snapping
 *
 * Free movement without alignment is worse than reordering, so the moved rect
 * snaps to its SIBLINGS' edges and centres, and to its PARENT's padding and
 * content box (edges and centre — P2-E / IX-5b, `canvasSnapPeers.ts`), through
 * `computeSnap` — the same pure resolver board furniture already uses, at the
 * same "closest wins, at most one snap per axis" contract. Peers are read once
 * from the drag session's candidate index (plus one computed-style read for
 * the parent's insets), because nothing but the moved element changes while
 * it is being positioned.
 *
 * The threshold is SCREEN px (IX-5a): `snapThresholdAtZoom` of the session's
 * live zoom, re-read every frame, so the pull feels the same at 50% and 400%.
 *
 * Everything below is pure except `resolveFreeMove` (which reads computed
 * style and layout) and `previewFreeMove` / `clearFreeMovePreview` (which write one
 * element's own inline style, the same preview-then-commit shape
 * `useElementResizeDrag` uses — preview dropped BEFORE the store commit, so
 * React's re-render is the last thing to touch the property).
 */
import { registry } from '@core/module-engine'
import { inlineOffsetProperty, isPositionedFreely } from '@core/studio-runtime'
import {
  explainStaticParentConstraint,
  getNodeHtmlTag,
  getParent,
  type NodeTree,
  type PageNode,
} from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import {
  presentStructuralRefusal,
  STRUCTURAL_REFUSAL_TITLE,
} from '@site/store/slices/site/structuralSourceEdits'
import { computeSnap, snapThresholdAtZoom, type SnapGuide, type SnapRect } from './boardSnapping'
import type { CanvasDropCandidate, CanvasRect } from './canvasDnd'
import { paintCanvasDrag, type CanvasDragGhost } from './canvasDragPainter'
import { presentedElementForNode } from './canvasNodeLookup'
import { cssPropertyName } from './elementResizeSizing'
import { parentSnapRects, readBoxInsets } from './canvasSnapPeers'
import { authoredOffsets, planNudge, type NudgeOffsetProperty, type NudgePlan, type NudgeTerm } from './canvasNodeArrowMove'

export interface FreeMovePlan {
  /** The element whose own inline style the gesture writes. */
  element: HTMLElement
  /**
   * The offsets the gesture moves, each from its value at drag start — the
   * authored ones (IX-21, see the module doc), or `left`/`top` for a layer
   * that only becomes absolute now.
   */
  offsets: NudgePlan
  /**
   * The element is not positioned yet, so the commit must also write
   * `position: absolute` — see this module's doc for why writing the offsets
   * alone would be a no-op. Both axes are written then, moved or not.
   */
  needsAbsolute: boolean
  /** Sibling rects plus the parent's padding / content box, frame space, measured once. */
  peers: SnapRect[]
  /** The moved element's own frame-space rect at drag start. */
  rect: SnapRect
}

/** Why a ⌘-drag cannot write a position here, and which node the remedy acts on. */
export interface FreeMoveRefusal {
  reason: 'static-parent'
  /** The container that would have to become `position: relative`. */
  parentNodeId: string | null
  /** Its tag, for the sentence. */
  parentLabel: string
}

export type FreeMoveResolution =
  | { ok: true; plan: FreeMovePlan }
  | { ok: false; refusal: FreeMoveRefusal }

/** One frame of a free move: how far the element has gone, and what to draw. */
export interface FreeMoveStep {
  /** The SNAPPED visual delta since drag start, frame px. */
  dx: number
  dy: number
  guides: SnapGuide[]
  /** The snapped rect, in frame space — what the ghost and guides are drawn against. */
  rect: SnapRect
}

/**
 * The subset of `CSSStyleDeclaration` this module reads, as a structural type
 * so the resolution below is unit-testable against plain objects — no DOM, no
 * layout, no browser.
 */
export interface FreeMoveStyleInput {
  position: string
  direction: string
  left: string
  right: string
  top: string
  bottom: string
}

/**
 * Whether a ⌘-drag may write a position onto an element with this computed
 * style inside a parent with that one — and whether it must also write
 * `position: absolute`. `null` refuses.
 *
 * Pure. The DOM half (finding the element, the parent, and the sibling rects)
 * is {@link resolveFreeMove}.
 */
export function planFreeMoveProperties(
  own: Pick<FreeMoveStyleInput, 'position'>,
  parentPosition: string,
): { needsAbsolute: boolean } | null {
  const alreadyFree = isPositionedFreely(own.position)
  // `fixed` is contained by the viewport, not by the parent, so the parent's
  // own position is not a question for it.
  if (!alreadyFree && parentPosition === 'static') return null
  return { needsAbsolute: !alreadyFree }
}

/** The layout facts `planFreeMoveOffsets` reads off the element — plain numbers, so it is testable without layout. */
export interface FreeMoveElementBox {
  offsetLeft: number
  offsetTop: number
  offsetWidth: number
  /** The offset parent's `clientWidth` — its padding box, the containing block of an absolute child. */
  containerWidth: number
}

/**
 * The offsets a free move writes, and their values at drag start.
 *
 * An already-positioned element: the AUTHORED offsets (IX-21), each from its
 * used px value — the same `planNudge` the arrow keys use, so a drag and a
 * nudge can never write different properties for one layer.
 *
 * An element becoming absolute now: `left` (`insetInlineStart` under RTL) and
 * `top`, from where layout put it inside its offset parent — which IS its
 * containing block once it is absolute — so it does not jump on the first
 * pixel. Under RTL the inline start is the containing block's RIGHT edge.
 */
export function planFreeMoveOffsets(
  box: FreeMoveElementBox,
  own: FreeMoveStyleInput,
  authored: ReadonlySet<NudgeOffsetProperty>,
  needsAbsolute: boolean,
): NudgePlan {
  if (!needsAbsolute) return planNudge(own, authored)
  const horizontal: NudgeTerm =
    inlineOffsetProperty(own.direction) === 'left'
      ? { property: 'left', sign: 1, base: box.offsetLeft }
      : { property: 'insetInlineStart', sign: -1, base: box.containerWidth - box.offsetLeft - box.offsetWidth }
  return { horizontal: [horizontal], vertical: [{ property: 'top', sign: 1, base: box.offsetTop }] }
}

interface ResolveFreeMoveInput {
  /** The frame's own document. */
  doc: Document
  tree: NodeTree<PageNode>
  /** The node the gesture is about — always the single dragged element. */
  nodeId: string
  /** The drag session's candidate rects, in frame space. Peers are read from here. */
  candidates: readonly CanvasDropCandidate[]
  /** ⌘/Ctrl is held. Without it, only an ALREADY-positioned element moves freely. */
  modifierHeld: boolean
}

/**
 * The DOM half: does this element move freely right now, and if so from what.
 *
 * `null` means "this gesture is an ordinary reorder" — the element is in flow
 * and the user is not asking for anything else. A refusal means the user DID
 * ask (⌘ is held) and the answer is honestly no.
 */
export function resolveFreeMove(input: ResolveFreeMoveInput): FreeMoveResolution | null {
  const { doc, tree, nodeId, candidates, modifierHeld } = input
  const element = presentedElementForNode(doc, nodeId)
  const view = doc.defaultView
  if (!element || !view || typeof view.getComputedStyle !== 'function') return null

  const computed = view.getComputedStyle(element)
  const own: FreeMoveStyleInput = {
    position: computed.position,
    direction: computed.direction,
    left: computed.left,
    right: computed.right,
    top: computed.top,
    bottom: computed.bottom,
  }

  // An already-absolute element moves freely with no modifier at all — its
  // position is ALREADY what `left`/`top` say, so dragging it anywhere else
  // would be the surprising behaviour.
  if (!isPositionedFreely(own.position) && !modifierHeld) return null

  const parentElement = element.parentElement
  const parentPosition = parentElement ? view.getComputedStyle(parentElement).position : 'static'
  const properties = planFreeMoveProperties(own, parentPosition)
  if (!properties) {
    const parentNode = getParent(tree, nodeId)
    return {
      ok: false,
      refusal: {
        reason: 'static-parent',
        parentNodeId: parentNode?.id ?? null,
        // The tag the user would recognise in their own file. Falls back to
        // the parent's own DOM tag (the element is right there) and then to a
        // generic word, so the sentence always names something.
        parentLabel:
          (parentNode ? getNodeHtmlTag(parentNode, registry.get(parentNode.moduleId)) : null)
          ?? parentElement?.tagName.toLowerCase()
          ?? 'container',
      },
    }
  }

  const rect = candidates.find((candidate) => candidate.nodeId === nodeId)?.rect
  if (!rect) return null

  const parentNode = getParent(tree, nodeId)
  const siblingIds = new Set(parentNode?.children ?? [])
  siblingIds.delete(nodeId)
  const peers: SnapRect[] = []
  for (const candidate of candidates) {
    if (candidate.nodeId === parentNode?.id) {
      // IX-5b — the parent's own edges and centre. Its rect is already in the
      // index; only the border + padding widths are a read. The TREE parent's
      // element, not `element.parentElement`: a module may render the child
      // one wrapper-free level down, but the node the user sees as "the
      // parent" is the tree's.
      const parentElementForInsets = presentedElementForNode(doc, candidate.nodeId) ?? parentElement
      const insets = parentElementForInsets
        ? readBoxInsets(view, parentElementForInsets)
        : { border: ZERO_INSETS, padding: ZERO_INSETS }
      peers.push(...parentSnapRects(snapRectOf(candidate.rect), insets))
      continue
    }
    if (!siblingIds.has(candidate.nodeId)) continue
    peers.push(snapRectOf(candidate.rect))
  }

  const node = tree.nodes[nodeId]
  const authored = node
    ? authoredOffsets(node, useEditorStore.getState().site?.styleRules)
    : new Set<NudgeOffsetProperty>()
  const box: FreeMoveElementBox = {
    offsetLeft: element.offsetLeft,
    offsetTop: element.offsetTop,
    offsetWidth: element.offsetWidth,
    containerWidth: (element.offsetParent as HTMLElement | null)?.clientWidth ?? 0,
  }
  return {
    ok: true,
    plan: {
      element,
      offsets: planFreeMoveOffsets(box, own, authored, properties.needsAbsolute),
      needsAbsolute: properties.needsAbsolute,
      peers,
      rect: snapRectOf(rect),
    },
  }
}

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

function snapRectOf(rect: CanvasRect): SnapRect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

/**
 * One frame of the gesture: apply the pointer delta, snap to the peers, and
 * report the guides to draw.
 *
 * `dx`/`dy` are FRAME-space deltas (client pixels already divided by the
 * canvas scale). Snapping runs on the element's rect in the same space, so a
 * guide drawn at a peer's edge is drawn exactly where that edge is. `zoom` is
 * the live canvas zoom, which turns the screen-px threshold into frame px.
 */
export function stepFreeMove(plan: FreeMovePlan, dx: number, dy: number, zoom: number): FreeMoveStep {
  const moved: SnapRect = {
    x: plan.rect.x + dx,
    y: plan.rect.y + dy,
    width: plan.rect.width,
    height: plan.rect.height,
  }
  const snapped = computeSnap(moved, plan.peers, snapThresholdAtZoom(zoom))
  // The snap is expressed as a correction to the rect; the same correction
  // applies to every offset, because each differs from the rect's edge only
  // by a constant for the length of the gesture.
  return {
    dx: snapped.x - plan.rect.x,
    dy: snapped.y - plan.rect.y,
    guides: snapped.guides,
    rect: { x: snapped.x, y: snapped.y, width: moved.width, height: moved.height },
  }
}

/**
 * The offsets at this step, as a React style patch: every term of an axis
 * that moved — both axes for an element becoming absolute, which has no
 * offsets of its own yet.
 */
function offsetsPatch(plan: FreeMovePlan, step: FreeMoveStep): Record<string, string> {
  const patch: Record<string, string> = {}
  const write = (terms: readonly NudgeTerm[], delta: number) => {
    for (const term of terms) patch[term.property] = `${Math.round(term.base + term.sign * delta)}px`
  }
  if (plan.needsAbsolute || step.dx !== 0) write(plan.offsets.horizontal, step.dx)
  if (plan.needsAbsolute || step.dy !== 0) write(plan.offsets.vertical, step.dy)
  return patch
}

/**
 * Show the step on the element itself, at frame rate, with no store round
 * trip — the same preview-then-commit shape `useElementResizeDrag` uses, and
 * for the same reason: the selection ring re-measures the real element, so it
 * follows for free.
 *
 * `position` is previewed too when the element is about to become absolute,
 * because otherwise the offsets would visibly do nothing until the drop.
 */
export function previewFreeMove(plan: FreeMovePlan, step: FreeMoveStep): void {
  if (plan.needsAbsolute) plan.element.style.setProperty('position', 'absolute')
  for (const [property, value] of Object.entries(offsetsPatch(plan, step))) {
    plan.element.style.setProperty(cssPropertyName(property), value)
  }
}

/**
 * Drop the preview BEFORE the store commit, never after — the preview and the
 * committed value are the SAME DOM property, so clearing it afterwards deletes
 * exactly what React just wrote, and React will not write it again because
 * from its point of view the style prop did not change. Both happen inside one
 * event handler, so the browser paints once and the intermediate state is
 * never seen.
 */
export function clearFreeMovePreview(plan: FreeMovePlan): void {
  for (const term of [...plan.offsets.horizontal, ...plan.offsets.vertical]) {
    plan.element.style.removeProperty(cssPropertyName(term.property))
  }
  if (plan.needsAbsolute) plan.element.style.removeProperty('position')
}

/** The inline-style patch the store commits — one element, one `style={{…}}`. */
export function freeMoveStylePatch(
  plan: FreeMovePlan,
  step: FreeMoveStep,
): Record<string, string> {
  return {
    ...(plan.needsAbsolute ? { position: 'absolute' } : {}),
    ...offsetsPatch(plan, step),
  }
}

/**
 * One painted frame of a free move — the WRITE phase, called after the caller
 * has finished reading. Returns the step so `pointerup` can commit exactly
 * what was last shown, or `null` when the gesture is refused.
 *
 * A refusal paints the SAME box and chip an out-of-bounds drop already uses
 * (`canvasDragPainter`), so a ⌘-drag that cannot land reads identically to a
 * drag that cannot land — one vocabulary, and the sentence arrives while the
 * pointer is still down.
 */
export function paintFreeMoveFrame(input: {
  layer: HTMLElement | null
  resolution: FreeMoveResolution
  draggedId: string
  /** The dragged element's own candidate rect, for the refusal box. */
  rect: CanvasRect | undefined
  /** Pointer travel since the drag started, in frame space. */
  dx: number
  dy: number
  /** Live canvas zoom — the snap threshold is screen px (IX-5a). */
  zoom: number
  ghost: CanvasDragGhost
}): FreeMoveStep | null {
  const { layer, resolution, draggedId, rect, dx, dy, zoom, ghost } = input
  if (!resolution.ok) {
    const constraint = explainStaticParentConstraint(resolution.refusal.parentLabel)
    paintCanvasDrag(layer, {
      target: null,
      invalid: rect ? { overId: draggedId, rect, axis: 'vertical', constraint } : null,
      ghost,
    })
    return null
  }

  const step = stepFreeMove(resolution.plan, dx, dy, zoom)
  previewFreeMove(resolution.plan, step)
  paintCanvasDrag(layer, { target: null, invalid: null, guides: step.guides, ghost })
  return step
}

/**
 * Open the `RefusalDialog` for a refused ⌘-drag, with its one-click remedy.
 *
 * Calls the store's own shared presenter with the store's own `getState` /
 * `setState` rather than adding a store action for one gesture: this is the
 * SAME function every refused structural gesture goes through, so the wording,
 * the dedup key and the toast-vs-dialog split cannot drift for this one.
 * `nodeId` is the CONTAINER, because the remedy acts on the container.
 */
export function presentFreeMoveRefusal(refusal: FreeMoveRefusal): void {
  presentStructuralRefusal(
    STRUCTURAL_REFUSAL_TITLE.freeMove,
    explainStaticParentConstraint(refusal.parentLabel),
    {
      ...(refusal.parentNodeId ? { nodeId: refusal.parentNodeId } : {}),
      getState: useEditorStore.getState,
      set: useEditorStore.setState,
    },
  )
}
