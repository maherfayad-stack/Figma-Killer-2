import type { CSSProperties } from 'react'
import { cn } from '@ui/cn'
import type {
  CanvasOverlayMeasureSession,
  CanvasOverlayRect,
} from './canvasOverlayGeometry'
import type {
  CanvasDropAxis,
  CanvasDropTarget,
  CanvasRect,
} from './canvasDnd'
import styles from './BreakpointSelectionOverlay.module.css'

const TOOLBAR_VERTICAL_OFFSET = 30
const INSPECTOR_VERTICAL_GAP = 12

/** Minimum breathing room between overlay chrome and the canvas edge. */
const GUTTER = 4

/**
 * True when `rect` lies entirely outside the canvas root's visible box. Overlay
 * coords are canvas-root-relative and the root cannot scroll (`overflow: clip`),
 * so its visible box is simply `0,0 → width,height`.
 */
function isFullyOutOfView(rect: CanvasOverlayRect, canvasRect: DOMRect): boolean {
  return (
    rect.x + rect.width <= 0 ||
    rect.x >= canvasRect.width ||
    rect.y + rect.height <= 0 ||
    rect.y >= canvasRect.height
  )
}

/**
 * The part of `rect` inside the canvas root's visible box. Only called after
 * `isFullyOutOfView` has ruled out an empty intersection, so the result always
 * describes real on-screen pixels.
 */
function intersectWithView(rect: CanvasOverlayRect, canvasRect: DOMRect): CanvasOverlayRect {
  const left = Math.max(rect.x, 0)
  const top = Math.max(rect.y, 0)
  return {
    x: left,
    y: top,
    width: Math.min(rect.x + rect.width, canvasRect.width) - left,
    height: Math.min(rect.y + rect.height, canvasRect.height) - top,
  }
}

/**
 * Last placement applied per overlay element ('hidden' or the exact rect).
 * Lets the WRITE phase no-op when nothing moved — same-value style writes
 * are not guaranteed free across engines, and skipping them keeps the
 * steady-state tick read-only.
 */
const appliedOverlayPlacements = new WeakMap<HTMLElement, CanvasOverlayRect | 'hidden'>()

/**
 * Move/resize an overlay div (selection ring, hover ring, affinity ring) to
 * `rect`, in canvas-root scroll-content coordinates (or viewport coordinates
 * in the fixed/body fallback). `rect === null` hides the element — the
 * tracked node is unmounted (page swap, hidden subtree) or the ring is
 * inactive.
 */
export function positionOverlayElement(
  element: HTMLElement | null,
  rect: CanvasOverlayRect | null,
): void {
  if (!element) return
  if (!rect) {
    hideOverlayElement(element)
    return
  }
  const prev = appliedOverlayPlacements.get(element)
  if (
    prev !== undefined &&
    prev !== 'hidden' &&
    prev.x === rect.x &&
    prev.y === rect.y &&
    prev.width === rect.width &&
    prev.height === rect.height
  ) {
    return
  }
  Object.assign(element.style, {
    display: '',
    transform: `translate(${rect.x}px, ${rect.y}px)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  appliedOverlayPlacements.set(element, rect)
}

export function hideOverlayElement(element: HTMLElement | null): void {
  if (!element) return
  if (appliedOverlayPlacements.get(element) === 'hidden') return
  element.style.display = 'none'
  appliedOverlayPlacements.set(element, 'hidden')
}

/**
 * Hard ceiling on how many affinity rings we draw for one selector. A utility
 * class (e.g. `text-muted`) can match hundreds of elements; measuring every one
 * via `getBoundingClientRect()` on each animation frame would jank the canvas.
 * The match count is already surfaced as the selector's usage badge in the
 * panel, so capping the *rings* (a transient hover affordance) is purely a
 * perf guard, not silent data truncation.
 */
const SELECTOR_HIGHLIGHT_RING_CAP = 300

/**
 * READ-phase half of the selector-affinity highlight: measure every element
 * matching `selector` inside the breakpoint iframe (capped). Returns null
 * when the highlight is inactive (clears the pool in the write phase).
 */
export function measureSelectorHighlightRects(
  selector: string | null,
  iframeDoc: Document,
  session: CanvasOverlayMeasureSession,
): CanvasOverlayRect[] | null {
  if (!selector) return null

  // Ambient selectors are arbitrary author/CSS-importer strings; a malformed
  // one makes querySelectorAll throw. Treat that as "matches nothing" rather
  // than letting it bubble out of the RAF loop.
  let matches: NodeListOf<HTMLElement>
  try {
    matches = iframeDoc.querySelectorAll<HTMLElement>(selector)
  } catch {
    return []
  }

  const count = Math.min(matches.length, SELECTOR_HIGHLIGHT_RING_CAP)
  const rects: CanvasOverlayRect[] = []
  for (let i = 0; i < count; i++) {
    const rect = session.measure(matches[i])
    if (rect) rects.push(rect)
  }
  return rects
}

/**
 * WRITE-phase half: sync the orange affinity ring pool under `container` to
 * the measured `rects` — grows the pool as needed, positions each ring, and
 * hides any surplus from a previous, larger match set (rings are reused, not
 * removed). `rects === null` clears the pool.
 */
export function syncSelectorHighlightRings(
  container: HTMLDivElement | null,
  rects: CanvasOverlayRect[] | null,
): void {
  if (!container) return
  if (!rects) {
    hideSurplusRings(container, 0)
    return
  }

  for (let i = 0; i < rects.length; i++) {
    let ring = container.children[i] as HTMLDivElement | undefined
    if (!ring) {
      ring = container.ownerDocument.createElement('div')
      ring.className = cn(styles.ring, styles.selectorHighlight)
      ring.setAttribute('data-canvas-selector-highlight-ring', 'true')
      container.appendChild(ring)
    }
    positionOverlayElement(ring, rects[i])
  }
  hideSurplusRings(container, rects.length)
}

/** Hide every pooled ring from index `keep` onward (they're reused, not removed). */
export function hideSurplusRings(container: HTMLDivElement, keep: number): void {
  for (let i = keep; i < container.children.length; i++) {
    hideOverlayElement(container.children[i] as HTMLElement)
  }
}

/**
 * Anchor the selection toolbar to `union` — the union of the selection-ring
 * rects already measured this tick (no second query/measure pass). Hides the
 * toolbar when there is no measurable selection or when the selection sits
 * entirely outside the canvas root's visible area — otherwise the toolbar
 * would "hang on screen" detached from the element it belongs to. For
 * partial overlap, the canvas root's `overflow: clip` clips it.
 *
 * Scoped path: toolbar lives inside the canvas root (position: absolute), so
 * `left`/`top` are canvas-root-relative — exactly the coordinate space `union`
 * is measured in, because the root cannot scroll (`overflow: clip`). Fixed path
 * (fallback, `canvasRect === null`): toolbar lives in document.body
 * (position: fixed) and the same values are viewport (client) coordinates.
 */
export function positionToolbar(
  toolbar: HTMLDivElement | null,
  union: CanvasOverlayRect | null,
  canvasRect: DOMRect | null,
): void {
  if (!toolbar) return
  if (!union) {
    hideOverlayElement(toolbar)
    return
  }

  if (canvasRect && isFullyOutOfView(union, canvasRect)) {
    hideOverlayElement(toolbar)
    return
  }

  // Keep toolbar actions reachable when a wide selected element overlaps the
  // canvas but its left edge is panned under surrounding editor chrome. Fully
  // out-of-bounds selections are hidden above; clamping here only affects
  // partially visible selections.
  if (canvasRect && toolbar.style.display === 'none') toolbar.style.display = ''
  let x = union.x
  if (canvasRect) {
    const maxX = Math.max(GUTTER, canvasRect.width - toolbar.offsetWidth - GUTTER)
    x = Math.min(Math.max(x, GUTTER), maxX)
  }

  const placement: CanvasOverlayRect = {
    x,
    y: union.y - TOOLBAR_VERTICAL_OFFSET,
    width: union.width,
    height: union.height,
  }
  const prev = appliedOverlayPlacements.get(toolbar)
  if (prev !== undefined && prev !== 'hidden' && prev.x === placement.x && prev.y === placement.y) {
    return
  }

  toolbar.style.display = ''
  toolbar.style.left = `${placement.x}px`
  toolbar.style.top = `${placement.y}px`
  appliedOverlayPlacements.set(toolbar, placement)
}

/**
 * Anchor the in-place mini-inspector just BELOW the selected node's measured
 * rect — `positionToolbar` anchors its chrome ABOVE the selection
 * (`TOOLBAR_VERTICAL_OFFSET`), so anchoring below keeps the two from ever
 * overlapping. `rect` is the SAME rect already measured this tick for the
 * node's selection ring (studio's single-select gate means there is exactly
 * one) — no second measure/`getBoundingClientRect` pass. Hides when there is
 * no measurable rect (the node isn't in THIS frame's iframe — the mechanism
 * that scopes the inspector to whichever studio board frame holds the
 * selected node) or when the selection sits entirely outside the canvas
 * root's visible area, mirroring `positionToolbar`'s out-of-bounds rule.
 *
 * The anchor is the element's VISIBLE region, not its raw rect. A selected
 * element wider or taller than the canvas viewport — or one panned so its top
 * left corner sits off-screen, which is ordinary on a studio board of
 * phone-sized frames — has a raw `rect.x`/`rect.y` far outside the viewport.
 * Clamping that raw corner onto the canvas parked this panel of form controls
 * against the canvas edge, hundreds of pixels from the element it edits, with
 * no visible relationship to it. Intersecting first keeps the panel beside the
 * part of the element the user can actually see.
 */
export function positionInspector(
  inspector: HTMLDivElement | null,
  rect: CanvasOverlayRect | null,
  canvasRect: DOMRect | null,
): void {
  if (!inspector) return
  if (!rect) {
    hideOverlayElement(inspector)
    return
  }

  if (canvasRect && isFullyOutOfView(rect, canvasRect)) {
    hideOverlayElement(inspector)
    return
  }

  if (canvasRect && inspector.style.display === 'none') inspector.style.display = ''
  let x = rect.x
  let anchorBottom = rect.y + rect.height
  if (canvasRect) {
    const visible = intersectWithView(rect, canvasRect)
    const maxX = Math.max(GUTTER, canvasRect.width - inspector.offsetWidth - GUTTER)
    x = Math.min(Math.max(visible.x, GUTTER), maxX)
    anchorBottom = visible.y + visible.height
  }

  const placement: CanvasOverlayRect = {
    x,
    y: anchorBottom + INSPECTOR_VERTICAL_GAP,
    width: rect.width,
    height: rect.height,
  }
  const prev = appliedOverlayPlacements.get(inspector)
  if (prev !== undefined && prev !== 'hidden' && prev.x === placement.x && prev.y === placement.y) {
    return
  }

  inspector.style.display = ''
  inspector.style.left = `${placement.x}px`
  inspector.style.top = `${placement.y}px`
  appliedOverlayPlacements.set(inspector, placement)
}

export function dropIndicatorStyle(target: CanvasDropTarget): CSSProperties {
  if (target.position === 'inside') return rectStyle(target.rect)
  return lineStyle(target.rect, target.position, target.axis)
}

function lineStyle(
  rect: CanvasRect,
  position: 'before' | 'after',
  axis: CanvasDropAxis,
): CSSProperties {
  if (axis === 'horizontal') {
    const x = position === 'before' ? rect.left : rect.right
    return indicatorVars(x, rect.top, 2, rect.height)
  }

  const y = position === 'before' ? rect.top : rect.bottom
  return indicatorVars(rect.left, y, rect.width, 2)
}

export function rectStyle(rect: CanvasRect): CSSProperties {
  return indicatorVars(rect.left, rect.top, rect.width, rect.height)
}

function indicatorVars(x: number, y: number, width: number, height: number): CSSProperties {
  return {
    '--canvas-drop-x': `${x}px`,
    '--canvas-drop-y': `${y}px`,
    '--canvas-drop-w': `${width}px`,
    '--canvas-drop-h': `${height}px`,
  } as CSSProperties
}
