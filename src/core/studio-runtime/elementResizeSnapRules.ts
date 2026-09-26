/**
 * elementResizeSnapRules — a resize handle's moving edge snaps to its
 * siblings' and its parent's edges and centres (P2-E / IX-6e), the same pull
 * a free move has, through the same resolver (`computeEdgeSnap`,
 * `snapRules.ts`). Shared by both resize hosts: the portal drag
 * (`useElementResizeDrag.ts`) and the live frame's own handles
 * (`resizeHandles.ts`) — before this lived in `@core/studio-runtime`, a live
 * frame's resize did not snap at all (canvas-26).
 *
 * ## Snap the edge that actually moves — and only that one
 *
 * A snap guide is a promise: "this edge is now exactly on that one". A resize
 * can only keep it for an edge whose position the drag decides:
 *
 *  - **`position: absolute | fixed`** — every handle moves its own edge (IX-6d
 *    moves `left`/`top` so the opposite edge stays put), so every handle snaps.
 *  - **A flow element** — its POSITION is produced by layout. Growing it moves
 *    the end edge only when layout keeps the start edge where it is: block
 *    flow, a flex item packed at the start of the main axis, a stretched or
 *    start-aligned cross axis, a start-aligned grid item — all left-to-right
 *    for the inline axis ({@link flowStartAnchored}). There the E and S
 *    handles snap. A W/N handle on a flow element grows it towards its END
 *    (the delta is inverted, `elementResizeRules.ts`), and a centred item
 *    grows both ways, so no edge is under the cursor to snap: those do not.
 *  - **⌥ (from the centre)** moves both edges by the delta, and **⇧ on a
 *    corner** lets the other axis win the scale — no single edge follows the
 *    pointer, so neither snaps. ⇧ on an edge handle still snaps that edge.
 *
 * The pointer is snapped, not the result: the corrected delta goes through
 * `resizeElementBox` like any other, so box-sizing, the floor and the offsets
 * are all still that module's business.
 *
 * ## Ruler guides and the toggles (P5-F)
 *
 * The moving edge snaps to the board's ruler guides as well (IX-5c), converted
 * into the frame document's px once at pointerdown (`resizeGuideLines`, editor-side),
 * and both snap toggles apply (IX-5e) through the same `snapSourcesFor` a move
 * uses. Equal spacing is a MOVE snap only: a resize changes a size, and "the
 * same gap as its neighbours" is a position question.
 *
 * ## Space and threshold
 *
 * Everything here is in the frame document's own CSS px — the space a pointer
 * event inside the iframe reports (`useElementResizeDrag`'s docblock: the
 * zoom is un-projected before the event arrives). The threshold is the
 * screen-px one (IX-5a) divided by the canvas zoom, read once at pointerdown;
 * a live frame cannot see the zoom, so the parent sends it with
 * `setResizeTarget` (`resizeMessages.ts`). The guides are painted into the
 * frame's parent-document drag layer (`elementResizeGuides.ts`), never into
 * the frame: canvas DOM is the user's DOM. A live frame posts its guides
 * (`resize:guides`) and the parent paints them the same way.
 */
import { resizeAxes, type ResizeHandle, type ResizeModifiers } from './elementResizeRules'
import { parentSnapRects, readBoxInsets } from './snapPeerRules'
import {
  computeEdgeSnap,
  snapSourcesFor,
  snapThresholdAtZoom,
  type SnapGuide,
  type SnapLine,
  type SnapRect,
  type SnapSourceToggles,
} from './snapRules'

/** Which edge of each axis follows the pointer: the start (W/N), the end (E/S), or none. */
export interface ResizeSnapEdges {
  x: 'start' | 'end' | null
  y: 'start' | 'end' | null
}

/** The layout facts {@link flowStartAnchored} reads, as a structural type (unit-testable without a DOM). */
export interface FlowLayoutInput {
  parentDisplay: string
  flexDirection: string
  justifyContent: string
  alignItems: string
  justifyItems: string
  /** The element's own `align-self` / `justify-self`. */
  alignSelf: string
  justifySelf: string
  /** The element's inline direction. */
  direction: string
}

const START_PACKED = new Set(['normal', 'start', 'flex-start', 'self-start', 'stretch', 'left', 'baseline', 'first baseline'])

function startPacked(value: string): boolean {
  return START_PACKED.has(value.trim())
}

/**
 * Whether layout keeps the element's START edge on `axis` fixed while it
 * grows — i.e. whether growth moves the end edge by exactly the growth.
 */
export function flowStartAnchored(axis: 'x' | 'y', layout: FlowLayoutInput): boolean {
  // The inline axis runs right-to-left under RTL: its start edge is the right one.
  if (axis === 'x' && layout.direction === 'rtl') return false
  const display = layout.parentDisplay.trim()
  if (display === 'flex' || display === 'inline-flex') {
    const direction = layout.flexDirection.trim()
    if (direction.endsWith('-reverse')) return false
    const mainAxis = direction.startsWith('column') ? 'y' : 'x'
    if (axis === mainAxis) return startPacked(layout.justifyContent)
    const cross = layout.alignSelf.trim() === 'auto' ? layout.alignItems : layout.alignSelf
    return startPacked(cross)
  }
  if (display === 'grid' || display === 'inline-grid') {
    if (axis === 'x') {
      const inline = layout.justifySelf.trim() === 'auto' ? layout.justifyItems : layout.justifySelf
      return startPacked(inline)
    }
    const block = layout.alignSelf.trim() === 'auto' ? layout.alignItems : layout.alignSelf
    return startPacked(block)
  }
  // Block (and inline-block, flow-root, list-item…) flow: start-anchored.
  return true
}

/** Which edges follow the pointer for `handle`. See the module doc for the rule. */
export function resizeSnapEdges(
  handle: ResizeHandle,
  modifiers: ResizeModifiers,
  positioned: boolean,
  anchored: { x: boolean; y: boolean },
): ResizeSnapEdges {
  const axes = resizeAxes(handle)
  if (modifiers.fromCenter) return { x: null, y: null }
  if (modifiers.proportional && axes.width && axes.height) return { x: null, y: null }
  const edgeFor = (owned: boolean, startSide: boolean, anchoredAxis: boolean): 'start' | 'end' | null => {
    if (!owned) return null
    if (positioned) return startSide ? 'start' : 'end'
    return !startSide && anchoredAxis ? 'end' : null
  }
  return {
    x: edgeFor(axes.width, handle.includes('w'), anchored.x),
    y: edgeFor(axes.height, handle.includes('n'), anchored.y),
  }
}

/** A snapped pointer delta, and the guides to draw for it (frame-document px). */
export interface ResizeSnapStep {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/**
 * Snap the pointer delta so each following edge lands on the closest peer
 * edge within `threshold`. `rect` is the element's border box at pointerdown.
 */
export function snapResizeDelta(
  edges: ResizeSnapEdges,
  rect: SnapRect,
  dx: number,
  dy: number,
  peers: readonly SnapRect[],
  threshold: number,
  lines: readonly SnapLine[] = [],
): ResizeSnapStep {
  const guides: SnapGuide[] = []
  let snappedDx = dx
  let snappedDy = dy
  if (edges.x) {
    const edge = (edges.x === 'start' ? rect.x : rect.x + rect.width) + dx
    const snap = computeEdgeSnap('x', edge, { start: rect.y, end: rect.y + rect.height }, peers, threshold, lines)
    if (snap) {
      snappedDx = dx + snap.delta
      guides.push(snap.guide)
    }
  }
  if (edges.y) {
    const edge = (edges.y === 'start' ? rect.y : rect.y + rect.height) + dy
    const snap = computeEdgeSnap('y', edge, { start: rect.x, end: rect.x + rect.width }, peers, threshold, lines)
    if (snap) {
      snappedDy = dy + snap.delta
      guides.push(snap.guide)
    }
  }
  return { dx: snappedDx, dy: snappedDy, guides }
}

// ---------------------------------------------------------------------------
// The one read, at pointerdown
// ---------------------------------------------------------------------------

/** Anything with a border-box rect — an element, or a test double. */
export interface RectSource {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
}

/** What a resize snaps against, read once when the handle is pressed. */
export interface ResizeSnapInput {
  /** The element's border box, frame-document px. */
  rect: SnapRect
  /** Its siblings' boxes, and its parent's padding / content box - empty when object snapping is off. */
  peers: readonly SnapRect[]
  /** The board's ruler guides in frame-document px - empty when guide snapping is off. */
  lines: readonly SnapLine[]
  /** Frame px — `snapThresholdAtZoom` of the canvas zoom at pointerdown. */
  threshold: number
  /** Which edges may snap per axis, before the live modifiers are applied. */
  anchored: { x: boolean; y: boolean }
}

/** A border-box rect as a snap rect; `null` for a box-less (zero-sized) source. */
export function snapRectOf(source: RectSource | null): SnapRect | null {
  if (!source) return null
  const rect = source.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

/** The element whose box lays this one out: the DOM parent, past any `display: contents` host. */
function layoutParentOf(view: Window, element: Element): Element | null {
  let parent = element.parentElement
  while (parent && view.getComputedStyle(parent).display === 'contents') parent = parent.parentElement
  return parent
}

/**
 * Read the snap peers for a resize of `element`. `siblings` and `parent` are
 * whatever the host names nodes by — canonical ids in a portal frame, stamp
 * refs in a live one — and `resolveElement` finds each one's presented
 * element. `resolveRect` maps that element to its visual box: the portal's
 * `nodeVisualRect`, so a box-less host measures as the union of its children;
 * a live frame uses {@link snapRectOf} and skips a box-less peer.
 */
export function readResizeSnapInput<K>(input: {
  view: Window
  element: HTMLElement
  siblings: readonly K[]
  parent: K | null
  resolveElement: (key: K) => Element | null
  resolveRect: (element: Element) => SnapRect | null
  zoom: number
  /**
   * The board's ruler guides, already in frame-document px (the editor's
   * `resizeGuideLines`, `canvas/elementResizeGuides.ts`); a live frame's
   * runtime has no board and passes `[]`.
   */
  guideLines: readonly SnapLine[]
  /** The user's snap toggles; a live frame passes `ALL_SNAP_SOURCES`. */
  preferences: SnapSourceToggles
}): ResizeSnapInput | null {
  const { view, element, siblings, parent, resolveElement, resolveRect, zoom, guideLines, preferences } = input
  const rect = snapRectOf(element)
  if (!rect) return null

  const peers: SnapRect[] = []
  for (const key of siblings) {
    const sibling = resolveElement(key)
    const siblingRect = sibling ? resolveRect(sibling) : null
    if (siblingRect) peers.push(siblingRect)
  }
  const parentElement = parent !== null ? resolveElement(parent) : null
  const parentRect = parentElement ? resolveRect(parentElement) : null
  if (parentElement && parentRect) peers.push(...parentSnapRects(parentRect, readBoxInsets(view, parentElement)))

  const own = view.getComputedStyle(element)
  const layoutParent = layoutParentOf(view, element)
  const parentStyle = layoutParent ? view.getComputedStyle(layoutParent) : null
  const layout: FlowLayoutInput = {
    parentDisplay: parentStyle?.display ?? 'block',
    flexDirection: parentStyle?.flexDirection ?? 'row',
    justifyContent: parentStyle?.justifyContent ?? 'normal',
    alignItems: parentStyle?.alignItems ?? 'normal',
    justifyItems: parentStyle?.justifyItems ?? 'normal',
    alignSelf: own.alignSelf || 'auto',
    justifySelf: own.justifySelf || 'auto',
    direction: own.direction || 'ltr',
  }
  const sources = snapSourcesFor(preferences, peers, guideLines)
  return {
    rect,
    peers: sources.peers,
    lines: sources.options.lines ?? [],
    threshold: snapThresholdAtZoom(zoom),
    anchored: { x: flowStartAnchored('x', layout), y: flowStartAnchored('y', layout) },
  }
}

