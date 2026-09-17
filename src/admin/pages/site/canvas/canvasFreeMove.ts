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
 * ## Snapping
 *
 * Free movement without alignment is worse than reordering, so the moved rect
 * snaps to its SIBLINGS' edges and centres through `computeSnap` — the same
 * pure resolver board furniture already uses, at the same "closest wins, at
 * most one snap per axis" contract. Peers are read once from the drag
 * session's candidate index, because siblings do not move while one element
 * is being positioned.
 *
 * Everything below is pure except `readFreeMoveBase` (which reads computed
 * style) and `previewFreeMove` / `clearFreeMovePreview` (which write one
 * element's own inline style, the same preview-then-commit shape
 * `useElementResizeDrag` uses — preview dropped BEFORE the store commit, so
 * React's re-render is the last thing to touch the property).
 */
import { registry } from '@core/module-engine'
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
import { computeSnap, type SnapGuide, type SnapRect } from './boardSnapping'
import type { CanvasDropCandidate, CanvasRect } from './canvasDnd'
import { paintCanvasDrag, type CanvasDragGhost } from './canvasDragPainter'
import { presentedElementForNode } from './canvasNodeLookup'

/** Snap distance in FRAME-space pixels. Matches the board's own feel. */
export const FREE_MOVE_SNAP_PX = 6

/** Which physical/logical property the horizontal offset is written to. */
export type FreeMoveInlineProperty = 'left' | 'inset-inline-start'

export interface FreeMovePlan {
  /** The element whose own inline style the gesture writes. */
  element: HTMLElement
  inlineProperty: FreeMoveInlineProperty
  /**
   * `+1` for `left`, `-1` for `inset-inline-start`: a drag to visual-right
   * increases `left` but DECREASES the distance from an RTL inline start.
   */
  inlineSign: 1 | -1
  /** The property's value at drag start, in frame-space px. */
  baseInline: number
  baseTop: number
  /**
   * The element is not positioned yet, so the commit must also write
   * `position: absolute` — see this module's doc for why writing `left`/`top`
   * alone would be a no-op.
   */
  needsAbsolute: boolean
  /** Sibling rects to snap against, frame space, measured once. */
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

/** One frame of a free move: where the element goes, and what to draw. */
export interface FreeMoveStep {
  inline: number
  top: number
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
  top: string
  insetInlineStart: string
}

/** True when this element already decides its own position through `left`/`top`. */
export function isPositionedFreely(position: string): boolean {
  return position === 'absolute' || position === 'fixed'
}

/**
 * Whether a ⌘-drag may write a position onto an element with this computed
 * style inside a parent with that one, and which property it would write.
 *
 * Pure. The DOM half (finding the element, the parent, and the sibling rects)
 * is {@link resolveFreeMove}.
 */
export function planFreeMoveProperties(
  own: FreeMoveStyleInput,
  parentPosition: string,
): { inlineProperty: FreeMoveInlineProperty; inlineSign: 1 | -1; needsAbsolute: boolean } | null {
  const alreadyFree = isPositionedFreely(own.position)
  // `fixed` is contained by the viewport, not by the parent, so the parent's
  // own position is not a question for it.
  if (!alreadyFree && parentPosition === 'static') return null

  const rtl = own.direction === 'rtl'
  return {
    inlineProperty: rtl ? 'inset-inline-start' : 'left',
    inlineSign: rtl ? -1 : 1,
    needsAbsolute: !alreadyFree,
  }
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
    top: computed.top,
    insetInlineStart: computed.insetInlineStart,
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

  const siblingIds = new Set(getParent(tree, nodeId)?.children ?? [])
  siblingIds.delete(nodeId)
  const peers: SnapRect[] = []
  for (const candidate of candidates) {
    if (!siblingIds.has(candidate.nodeId)) continue
    peers.push({
      x: candidate.rect.left,
      y: candidate.rect.top,
      width: candidate.rect.width,
      height: candidate.rect.height,
    })
  }

  return {
    ok: true,
    plan: {
      element,
      ...properties,
      ...readFreeMoveBase(element, own, properties.inlineProperty),
      peers,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    },
  }
}

/** The property's current value in px, or `0` when it is `auto` / unreadable. */
function lengthOrZero(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The offset the gesture starts from.
 *
 * Prefers the property the write will actually target, so a drag continues
 * from where the source already says the element is. Falls back to the
 * element's own offset inside its offset parent — which IS its containing
 * block, both for an element that is already absolute and for one that is
 * about to become absolute — for the `auto` case, so an element positioned
 * only by flow does not jump to the container's corner on the first pixel.
 */
export function readFreeMoveBase(
  element: HTMLElement,
  style: FreeMoveStyleInput,
  inlineProperty: FreeMoveInlineProperty,
): { baseInline: number; baseTop: number } {
  const rawInline = inlineProperty === 'left' ? style.left : style.insetInlineStart
  const inlineAuto = Number.isNaN(Number.parseFloat(rawInline))
  const topAuto = Number.isNaN(Number.parseFloat(style.top))
  return {
    baseInline: inlineAuto ? element.offsetLeft : lengthOrZero(rawInline),
    baseTop: topAuto ? element.offsetTop : lengthOrZero(style.top),
  }
}

/**
 * One frame of the gesture: apply the pointer delta, snap to siblings, and
 * report the guides to draw.
 *
 * `dx`/`dy` are FRAME-space deltas (client pixels already divided by the
 * canvas scale). Snapping runs on the element's rect in the same space, so a
 * guide drawn at a peer's edge is drawn exactly where that edge is.
 */
export function stepFreeMove(plan: FreeMovePlan, dx: number, dy: number): FreeMoveStep {
  const moved: SnapRect = {
    x: plan.rect.x + dx,
    y: plan.rect.y + dy,
    width: plan.rect.width,
    height: plan.rect.height,
  }
  const snapped = computeSnap(moved, plan.peers, FREE_MOVE_SNAP_PX)
  // The snap is expressed as a correction to the rect; the same correction
  // applies to the offset, because the two differ only by the constant
  // distance between the containing block and the frame's origin.
  const snappedDx = snapped.x - plan.rect.x
  const snappedDy = snapped.y - plan.rect.y
  return {
    inline: plan.baseInline + snappedDx * plan.inlineSign,
    top: plan.baseTop + snappedDy,
    guides: snapped.guides,
    rect: { x: snapped.x, y: snapped.y, width: moved.width, height: moved.height },
  }
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
  plan.element.style.setProperty(plan.inlineProperty, `${Math.round(step.inline)}px`)
  plan.element.style.setProperty('top', `${Math.round(step.top)}px`)
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
  plan.element.style.removeProperty(plan.inlineProperty)
  plan.element.style.removeProperty('top')
  if (plan.needsAbsolute) plan.element.style.removeProperty('position')
}

/** The inline-style patch the store commits — one element, one `style={{…}}`. */
export function freeMoveStylePatch(
  plan: FreeMovePlan,
  step: FreeMoveStep,
): Record<string, string> {
  return {
    ...(plan.needsAbsolute ? { position: 'absolute' } : {}),
    [plan.inlineProperty]: `${Math.round(step.inline)}px`,
    top: `${Math.round(step.top)}px`,
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
  ghost: CanvasDragGhost
}): FreeMoveStep | null {
  const { layer, resolution, draggedId, rect, dx, dy, ghost } = input
  if (!resolution.ok) {
    const constraint = explainStaticParentConstraint(resolution.refusal.parentLabel)
    paintCanvasDrag(layer, {
      target: null,
      invalid: rect ? { overId: draggedId, rect, axis: 'vertical', constraint } : null,
      ghost,
    })
    return null
  }

  const step = stepFreeMove(resolution.plan, dx, dy)
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
