/**
 * canvasLayerGeometry — where every loose layer is on the board, in board
 * units (P5-G, FC-4): its placement (`boards.json`) plus the size its host box
 * measured inside the free-canvas surface.
 *
 * ## Why a module registry and not the store
 *
 * A host's size is a LAYOUT fact, measured by a `ResizeObserver` inside the
 * surface document. Three readers need it — the selection rings, the pointer
 * hit test, snapping — and the hit test runs on every `pointermove` over the
 * board. A `useEditorStore` selector would re-run on every unrelated store
 * change, which the canvas performance rules forbid, and writing a size into
 * the store would re-render the board on a reflow. Same reasoning as
 * `canvasDropSurfaceRegistry.ts`. The chrome subscribes through
 * `useSyncExternalStore`, which notifies only when a size actually changed.
 *
 * ## Coordinates
 *
 * The surface iframe is UNSCALED inside the board's transform layer, so one CSS
 * pixel inside it is exactly one board unit — a host's `offsetWidth` is its
 * board width, with no zoom to recover.
 */
import type { CanvasLayerPlacement } from '@core/studio-board'

/** The synthetic breakpoint every studio board frame shares (`BoardFrameView`'s `STUDIO_BREAKPOINT_BASE.id`); the surface renders under it too, so class CSS keyed on it matches. */
export const STUDIO_BREAKPOINT_ID = 'studio'

export interface CanvasLayerSize {
  width: number
  height: number
}

/** A loose layer's box on the board. */
export interface CanvasLayerRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

const sizes = new Map<string, CanvasLayerSize>()
const listeners = new Set<() => void>()
let version = 0

/** Record a host's measured size. Notifies only when it changed. */
export function setCanvasLayerSize(id: string, size: CanvasLayerSize): void {
  const previous = sizes.get(id)
  if (previous && previous.width === size.width && previous.height === size.height) return
  sizes.set(id, size)
  version += 1
  for (const listener of listeners) listener()
}

/** Forget a host that unmounted. */
export function forgetCanvasLayerSize(id: string): void {
  if (!sizes.delete(id)) return
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeCanvasLayerGeometry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes whenever a measured size does — the `useSyncExternalStore` snapshot. */
export function canvasLayerGeometryVersion(): number {
  return version
}

/**
 * Every visible, measured layer's board rect, in paint order (lowest first).
 * A layer that has not measured yet (off the surface window, or mounting) has
 * no rect: nothing can be hit or snapped to until it exists on screen.
 */
export function canvasLayerRects(layers: readonly CanvasLayerPlacement[]): CanvasLayerRect[] {
  const rects: CanvasLayerRect[] = []
  for (const layer of layers) {
    if (layer.hidden) continue
    const size = sizes.get(layer.id)
    if (!size) continue
    rects.push({ id: layer.id, x: layer.x, y: layer.y, width: size.width, height: size.height })
  }
  return rects
}

/** The topmost layer under a board point, skipping locked ones. `rects` is in paint order. */
export function canvasLayerAtPoint(
  rects: readonly CanvasLayerRect[],
  point: { x: number; y: number },
  locked: ReadonlySet<string>,
): CanvasLayerRect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const rect = rects[i]!
    if (locked.has(rect.id)) continue
    if (point.x < rect.x || point.x > rect.x + rect.width) continue
    if (point.y < rect.y || point.y > rect.y + rect.height) continue
    return rect
  }
  return null
}

/**
 * The board-origin element's width in board units (`BoardCanvasLayer`'s
 * `.layer`, `data-studio-board-origin`). It is `BOARD_ORIGIN_SPAN` CSS pixels
 * wide and zero tall inside the transform layer, so ONE client rect gives both
 * the board's client origin AND the zoom actually painted — no second source
 * (a transform ref, the store's debounced zoom) that could disagree with what
 * is on screen.
 */
export const BOARD_ORIGIN_SPAN = 1000

export interface BoardOrigin {
  left: number
  top: number
  zoom: number
}

/** The board's client origin and painted zoom, read from the board-origin element. */
export function readBoardOrigin(element: Element): BoardOrigin {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, zoom: rect.width > 0 ? rect.width / BOARD_ORIGIN_SPAN : 1 }
}

/**
 * Whether an element is the EMPTY board itself — the canvas root or the
 * transform layer — rather than anything on it (a frame, a note, chrome).
 * The one test for "this gesture ended on the free canvas": a frame's
 * registered drop viewport can extend past the frame's visible, clipped box
 * (its iframe grows to content), so geometry against the registry over-reports
 * frames; what is actually under the pointer does not.
 */
export function isEmptyBoardTarget(target: EventTarget | Element | null): boolean {
  return target instanceof HTMLElement && (target.dataset.studioCanvasRoot === 'true' || target.dataset.testid === 'canvas-transform-layer')
}

/** The board-origin element of the canvas `root` (or the document), or `null` off a Studio board. */
export function findBoardOrigin(root: ParentNode = document): BoardOrigin | null {
  const element = root.querySelector('[data-studio-board-origin]')
  return element ? readBoardOrigin(element) : null
}

/**
 * A parent-document client point in board units. `boardOrigin` is the client
 * rect of an element sitting at board (0, 0) inside the transform layer — it
 * already carries the pan and the transform layer's own offset — and `zoom`
 * is the LIVE zoom.
 */
export function clientToBoardPoint(
  client: { x: number; y: number },
  boardOrigin: { left: number; top: number },
  zoom: number,
): { x: number; y: number } {
  const scale = zoom > 0 ? zoom : 1
  return { x: (client.x - boardOrigin.left) / scale, y: (client.y - boardOrigin.top) / scale }
}

/** The surface window: a board-space rect the surface iframe covers. */
export interface CanvasLayerWindow {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The window the surface covers: the viewport in board units, plus one margin
 * each side (`frameVirtualization.ts`'s screen-px margin, in board units at
 * this zoom), snapped outward to a coarse grid so a small pan re-fits nothing.
 * Two layers 40,000 units apart never make a 40,000-unit document (design §4.2).
 */
export function canvasLayerWindow(
  view: { zoom: number; panX: number; panY: number; width: number; height: number },
  marginPx: number,
): CanvasLayerWindow {
  const zoom = view.zoom > 0 ? view.zoom : 1
  const grid = 512
  const left = Math.floor((-view.panX - marginPx) / zoom / grid) * grid
  const top = Math.floor((-view.panY - marginPx) / zoom / grid) * grid
  const right = Math.ceil((-view.panX + view.width + marginPx) / zoom / grid) * grid
  const bottom = Math.ceil((-view.panY + view.height + marginPx) / zoom / grid) * grid
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Whether a layer's (estimated) box meets the window — only those mount a host. */
export function layerMeetsWindow(layer: CanvasLayerPlacement, area: CanvasLayerWindow): boolean {
  const size = sizes.get(layer.id)
  // Unmeasured: assume a generous box so a layer just outside still mounts and measures.
  const width = size?.width ?? layer.w ?? 2000
  const height = size?.height ?? 2000
  return (
    layer.x < area.x + area.width &&
    layer.x + width > area.x &&
    layer.y < area.y + area.height &&
    layer.y + height > area.y
  )
}
