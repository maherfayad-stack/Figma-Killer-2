/**
 * canvasNewLayerPlacement (PA-3) — where a layer that does not exist yet goes
 * when a gesture with a pointer creates it: a draw, an Assets-panel drop, an OS
 * file drop. ONE decision for all of them.
 *
 * ## The rule
 *
 * `resolvePlacement` (`@core/studio-runtime`) decides from the parent's kind:
 *
 *   - a FREE FRAME (positioned, every child absolute, or empty) places its
 *     children by their own insets, so the new layer lands absolute at the
 *     pointer — no modifier needed;
 *   - an AUTO-LAYOUT or FLOW parent inserts in flow (the honest answer in a
 *     React tree) unless ⌘/Ctrl is held, which asks for a position instead.
 *
 * ## The offsets
 *
 * Measured against the parent's REAL containing block with
 * `containingBlockOffsets` — padding box, border, scroll, scale — never
 * `offsetLeft` against `offsetParent` (the `left:-421px` bug class). The new
 * layer's parent IS its containing block, so a parent that does not establish
 * one (static, no transform) cannot take an absolute child: ⌘ there refuses
 * with K6's remedy rather than placing the layer against a distant ancestor.
 *
 * Portal frames only: a live (Tier 2) frame's document is cross-origin, so its
 * parent cannot be inspected and the layer stays a flow insert.
 *
 * Everything but the two `measure…` functions is pure.
 */
import {
  childPlacementPositions,
  containingBlockBoxOf,
  containingBlockOffsets,
  establishesContainingBlock,
  inlineOffsetProperty,
  parentPlacementKind,
  resolvePlacement,
  type BoxRect,
  type ContainingBlockBox,
  type InlineOffsetProperty,
  type ParentPlacementKind,
} from '@core/studio-runtime'
import type { InsertLocation } from '@site/store/insertLocation'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'
import { ownElementForNode } from './canvasNodeLookup'

/** What a placement needs to know about the parent a new layer lands in. */
export interface NewLayerParent {
  kind: ParentPlacementKind
  /** The parent's box in frame-viewport coordinates, for `containingBlockOffsets`. */
  block: ContainingBlockBox
  /** Does an absolute child of this parent stay inside it (positioned, transformed, …)? */
  containsAbsolute: boolean
  /** Computed `direction`, for the inline offset property. */
  direction: string
}

export type NewLayerPlacement =
  /** Insert at the drop line's flow index. */
  | { kind: 'flow' }
  /** `position: absolute` at these offsets from the parent's padding box. */
  | { kind: 'absolute'; property: InlineOffsetProperty; inline: number; top: number }
  | { kind: 'refused'; reason: 'static-parent' | 'unmeasured' }

export type AbsoluteNewLayerPlacement = Extract<NewLayerPlacement, { kind: 'absolute' }>

const FLOW: NewLayerPlacement = { kind: 'flow' }

/**
 * Decide where a new layer whose top-left corner is `rect` (frame-viewport
 * space; width / height are the layer's own, `0` when it has none yet) goes.
 * `parent` is `null` when the parent could not be measured — a plain gesture
 * still inserts in flow, a placed one refuses.
 */
export function planNewLayerPlacement(
  parent: NewLayerParent | null,
  rect: BoxRect,
  modifierHeld: boolean,
): NewLayerPlacement {
  const outcome = resolvePlacement({ parentKind: parent?.kind ?? 'flow', childPosition: null, modifierHeld })
  if (outcome === 'reorder') return FLOW
  if (!parent) return { kind: 'refused', reason: 'unmeasured' }
  // An absolute child of a parent that is not a containing block would be
  // placed by some distant ancestor.
  if (!parent.containsAbsolute) return { kind: 'refused', reason: 'static-parent' }
  const property = inlineOffsetProperty(parent.direction)
  const offsets = containingBlockOffsets(rect, parent.block)
  return { kind: 'absolute', property, inline: property === 'left' ? offsets.left : offsets.right, top: offsets.top }
}

/** The inline styles that pin a new layer at its placement, React-style keys. */
/**
 * Where among the parent's children a layer PLACED by position goes: the end.
 * A free frame has no reading order - every child is placed by its own insets -
 * so the pointer-derived flow index means nothing there, and the end is the top
 * of the stacking order, which is where a layer just drawn belongs. (It also
 * keeps a new node from taking over the source id of the sibling it was
 * inserted before.) A flow landing keeps the index the drop line showed.
 */
export function locationForPlacement(location: InsertLocation, placement: NewLayerPlacement): InsertLocation {
  return placement.kind === 'absolute' ? { parentId: location.parentId, index: undefined } : location
}

export function newLayerPlacementStyles(placement: NewLayerPlacement | null): Record<string, string> {
  if (placement?.kind !== 'absolute') return {}
  return { position: 'absolute', [placement.property]: `${placement.inline}px`, top: `${placement.top}px` }
}

// ── The DOM half ─────────────────────────────────────────────────────────────

/**
 * The placement kind of a rendered parent: its own computed `display` /
 * `position`, and the `position` of every element child that takes part in
 * layout (`display: none` takes no space and decides nothing).
 */
export function placementKindOfElement(view: Window, element: HTMLElement): ParentPlacementKind {
  const style = view.getComputedStyle(element)
  return parentPlacementKind({ display: style.display, position: style.position }, childPlacementPositions(view, element))
}

/**
 * The element a layer inserted into `element` is really written inside.
 *
 * The page root is a synthetic `<body>`: a layer dropped on the frame's
 * background (below the screen's own root, in the gutter around it) has the
 * body as its tree parent, but a component returns ONE root element and the
 * codemod writes the newcomer at the end of THAT. Measuring the body asked
 * "is this a free frame?" of a box whose only child is a relative `<main>`, so
 * an all-absolute screen read as flow and a drawn layer lost its position (R4 #4).
 */
function sourceContainerElement(element: HTMLElement | null): HTMLElement | null {
  
  if (!element || element.dataset.moduleId !== 'base.body') return element
  // Duck-typed: the frame's elements come from another realm, so `instanceof HTMLElement` is false for all of them.
  const roots = Array.from(element.children).filter((child) => child.hasAttribute('data-node-id'))
  return roots.length === 1 ? (roots[0] as HTMLElement) : element
}

/** One computed-style read of the parent and its children, one rect read — at gesture end, never per move. */
export function measureNewLayerParent(doc: Document, parentId: string): NewLayerParent | null {
  const element = sourceContainerElement(ownElementForNode(doc, parentId))
  const view = doc.defaultView
  if (!element || !view || typeof view.getComputedStyle !== 'function') return null
  const style = view.getComputedStyle(element)
  return {
    kind: placementKindOfElement(view, element),
    block: containingBlockBoxOf(view, element),
    containsAbsolute: establishesContainingBlock(style),
    direction: style.direction,
  }
}

export interface ClientRectLike {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The placement for a new layer drawn / dropped at `clientRect` (editor-document
 * client px) into node `parentId` of the frame hosted by `iframe`. The client
 * rect becomes frame-viewport space by the iframe's own offset and scale, so
 * the offsets are in the CSS px the source stores whatever the canvas zoom.
 */
export function newLayerPlacementAt(
  iframe: HTMLIFrameElement | null,
  parentId: string,
  clientRect: ClientRectLike,
  modifierHeld: boolean,
): NewLayerPlacement {
  const doc = iframe ? resolvePortalDocument(iframe) : null
  if (!iframe || !doc) return FLOW
  const frameRect = iframe.getBoundingClientRect()
  const scaleX = iframe.clientWidth > 0 ? frameRect.width / iframe.clientWidth : 1
  const scaleY = iframe.clientHeight > 0 ? frameRect.height / iframe.clientHeight : 1
  return planNewLayerPlacement(
    measureNewLayerParent(doc, parentId),
    {
      left: (clientRect.x - frameRect.left) / scaleX,
      top: (clientRect.y - frameRect.top) / scaleY,
      width: clientRect.width / scaleX,
      height: clientRect.height / scaleY,
    },
    modifierHeld,
  )
}
