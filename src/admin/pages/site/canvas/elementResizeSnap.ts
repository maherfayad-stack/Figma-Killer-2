/**
 * elementResizeSnap — a resize handle's moving edge snaps to its siblings'
 * and its parent's edges and centres (P2-E / IX-6e), the same pull a free
 * move has, through the same resolver (`computeEdgeSnap`, `boardSnapping.ts`).
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
 * ## Space and threshold
 *
 * Everything here is in the frame document's own CSS px — the space a pointer
 * event inside the iframe reports (`useElementResizeDrag`'s docblock: the
 * zoom is un-projected before the event arrives). The threshold is the
 * screen-px one (IX-5a) divided by the canvas zoom, read once at pointerdown.
 * The guides are painted into the frame's parent-document drag layer
 * (`canvasDragPainter`), never into the frame: canvas DOM is the user's DOM.
 */
import { resizeAxes, type ResizeHandle, type ResizeModifiers } from '@core/studio-runtime'
import { computeEdgeSnap, snapThresholdAtZoom, type SnapGuide, type SnapRect } from './boardSnapping'
import { parentSnapRects, readBoxInsets } from './canvasSnapPeers'
import { clientRectToViewportRect, getViewportZoom } from './canvasDomGeometry'
import { paintCanvasDrag } from './canvasDragPainter'
import { listCanvasDropSurfaces } from './canvasDropSurfaceRegistry'

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
): ResizeSnapStep {
  const guides: SnapGuide[] = []
  let snappedDx = dx
  let snappedDy = dy
  if (edges.x) {
    const edge = (edges.x === 'start' ? rect.x : rect.x + rect.width) + dx
    const snap = computeEdgeSnap('x', edge, { start: rect.y, end: rect.y + rect.height }, peers, threshold)
    if (snap) {
      snappedDx = dx + snap.delta
      guides.push(snap.guide)
    }
  }
  if (edges.y) {
    const edge = (edges.y === 'start' ? rect.y : rect.y + rect.height) + dy
    const snap = computeEdgeSnap('y', edge, { start: rect.x, end: rect.x + rect.width }, peers, threshold)
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
interface RectSource {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
}

/** What a resize snaps against, read once when the handle is pressed. */
export interface ResizeSnapInput {
  /** The element's border box, frame-document px. */
  rect: SnapRect
  /** Its siblings' boxes, and its parent's padding / content box. */
  peers: SnapRect[]
  /** Frame px — `snapThresholdAtZoom` of the canvas zoom at pointerdown. */
  threshold: number
  /** Which edges may snap per axis, before the live modifiers are applied. */
  anchored: { x: boolean; y: boolean }
}

function snapRectOf(source: RectSource | null): SnapRect | null {
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
 * Read the snap peers for a resize of `element`. `resolveRect` maps a node id
 * to its visual box (the caller's `nodeVisualRect` over the node's presented
 * element), so box-less hosts measure as the union of their children.
 */
export function readResizeSnapInput(input: {
  view: Window
  element: HTMLElement
  siblingIds: readonly string[]
  parentId: string | null
  resolveElement: (nodeId: string) => Element | null
  resolveRect: (element: Element) => SnapRect | null
  zoom: number
}): ResizeSnapInput | null {
  const { view, element, siblingIds, parentId, resolveElement, resolveRect, zoom } = input
  const rect = snapRectOf(element)
  if (!rect) return null

  const peers: SnapRect[] = []
  for (const id of siblingIds) {
    const sibling = resolveElement(id)
    const siblingRect = sibling ? resolveRect(sibling) : null
    if (siblingRect) peers.push(siblingRect)
  }
  const parentElement = parentId ? resolveElement(parentId) : null
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
  return {
    rect,
    peers,
    threshold: snapThresholdAtZoom(zoom),
    anchored: { x: flowStartAnchored('x', layout), y: flowStartAnchored('y', layout) },
  }
}

/**
 * Where a resize's guides are painted: the frame's own parent-document drag
 * layer, plus the offset that turns a frame-document point into that layer's
 * space and the canvas zoom — all three from ONE read of two rects, at
 * pointerdown. The layer sits inside `CanvasTransformLayer` with the iframe,
 * so frame-document px and layer px differ only by the iframe's offset in its
 * viewport (the same conversion `measureCanvasDropCandidates` applies).
 *
 * `null` for a frame with no registered drop surface (a Viewer, a test): the
 * resize still snaps, it just draws no guide.
 */
export interface ResizeGuideSurface {
  layer: HTMLElement
  originX: number
  originY: number
  zoom: number
}

export function resolveResizeGuideSurface(iframe: Element | null): ResizeGuideSurface | null {
  if (!iframe) return null
  const surface = listCanvasDropSurfaces().find((candidate) => candidate.iframe === iframe)
  const layer = surface?.dropLayer() ?? null
  if (!surface || !layer) return null
  const origin = clientRectToViewportRect(surface.viewport, iframe.getBoundingClientRect())
  return { layer, originX: origin.left, originY: origin.top, zoom: getViewportZoom(surface.viewport) }
}

/** The canvas zoom a frame is drawn at, from its iframe element alone (no drop surface). */
export function iframeZoom(iframe: Element | null): number {
  if (!iframe || !(iframe instanceof HTMLElement) || iframe.offsetWidth <= 0) return 1
  return iframe.getBoundingClientRect().width / iframe.offsetWidth
}

/** Paint (or, with an empty list, clear) the guides of one resize step. */
export function paintResizeGuides(surface: ResizeGuideSurface | null, guides: readonly SnapGuide[]): void {
  if (!surface) return
  if (guides.length === 0) {
    paintCanvasDrag(surface.layer, null)
    return
  }
  paintCanvasDrag(surface.layer, {
    target: null,
    invalid: null,
    ghost: null,
    guides: guides.map((guide) => {
      const along = guide.axis === 'x' ? surface.originX : surface.originY
      const across = guide.axis === 'x' ? surface.originY : surface.originX
      return { ...guide, position: guide.position + along, start: guide.start + across, end: guide.end + across }
    }),
  })
}
