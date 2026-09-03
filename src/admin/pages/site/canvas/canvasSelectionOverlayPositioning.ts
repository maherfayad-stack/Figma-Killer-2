import type { CSSProperties } from 'react'
import type {
  CanvasOverlayRect,
} from './canvasOverlayGeometry'
import type {
  CanvasDropAxis,
  CanvasDropTarget,
  CanvasRect,
} from './canvasDnd'

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
 *
 * `measure` is a plain measurement function rather than a whole
 * `CanvasOverlayMeasureSession` — the affinity rings live in the in-iframe
 * overlay root now (WS-5.1), so the caller passes `measureIframeLocalRect`
 * (no zoom/offset conversion needed); the signature stays generic so a
 * caller that genuinely needs parent-document coordinates could still pass
 * `session.measure`.
 */
export function measureSelectorHighlightRects(
  selector: string | null,
  iframeDoc: Document,
  measure: (target: HTMLElement | null) => CanvasOverlayRect | null,
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
    const rect = measure(matches[i])
    if (rect) rects.push(rect)
  }
  return rects
}

/**
 * Styling for an affinity ring created OUTSIDE the in-iframe overlay root —
 * the live-mode / transient-startup fallback (see `BreakpointSelectionOverlay`'s
 * `usingIframeOverlay`). `className` is the caller's pre-composed CSS Module
 * class string (this module doesn't import CSS Modules itself, to stay
 * decoupled from any one component's stylesheet); `mode` is the same
 * scoped/fixed value the selection toolbar already uses.
 */
export interface LegacySelectorRingStyle {
  className: string
  mode: 'scoped' | 'fixed'
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
  legacyStyle?: LegacySelectorRingStyle | null,
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
      // Inside the in-iframe overlay root (WS-5.1, `legacyStyle` omitted):
      // hashed CSS Module class names from the parent document don't exist
      // inside the iframe, so appearance comes ONLY from
      // `CanvasSelectionOverlayInjector`'s `[data-canvas-selector-highlight-ring]`
      // rule. In the live-mode / transient-startup fallback (`legacyStyle`
      // provided), the ring is portaled into the PARENT document instead,
      // where the CSS Module class is what actually paints it.
      ring.setAttribute('data-canvas-selector-highlight-ring', 'true')
      if (legacyStyle) {
        ring.className = legacyStyle.className
        ring.setAttribute('data-canvas-ring-mode', legacyStyle.mode)
      }
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

/**
 * Publish the current selection's canvas-root-relative rect as the
 * `--selection-anchor-{x,y,w,h}` custom-property channel (WS-5.1) — the
 * sanctioned inline-style exception in CLAUDE.md. `positionToolbar` /
 * `positionInspector` above still own the actual left/top math (offset +
 * clamp), computed from the SAME rect passed here; this channel exists
 * alongside that so the anchor value is inspectable independent of which
 * piece of parent-doc chrome consumes it, without threading a rect object
 * through more props than necessary.
 *
 * Deliberately NOT written every RAF tick — see `BreakpointSelectionOverlay`'s
 * `anchorDirtyRef`, which gates calls to this to once per selection change and
 * once per pan/zoom commit. A `null` rect clears the channel to zero rather
 * than removing the properties, so a stale reader never sees a `NaN`/empty
 * `calc()`.
 */
export function publishSelectionAnchor(
  element: HTMLElement | null,
  rect: CanvasOverlayRect | null,
): void {
  if (!element) return
  const r = rect ?? { x: 0, y: 0, width: 0, height: 0 }
  element.style.setProperty('--selection-anchor-x', `${r.x}px`)
  element.style.setProperty('--selection-anchor-y', `${r.y}px`)
  element.style.setProperty('--selection-anchor-w', `${r.width}px`)
  element.style.setProperty('--selection-anchor-h', `${r.height}px`)
}

const NODE_BADGE_GAP = 4
const NODE_BADGE_FALLBACK_HEIGHT = 20

interface AppliedBadgePlacement {
  x: number
  y: number
  label: string
}

/** Last placement + label applied per badge — same no-op-when-unchanged idea as `appliedOverlayPlacements`. */
const appliedBadgePlacements = new WeakMap<HTMLElement, AppliedBadgePlacement | 'hidden'>()

/**
 * Position the node-name badge (WS-5.1) just above its ring's top-left
 * corner, Figma-style — or just below when there's no room above (the ring
 * sits at the very top of the frame). `ringRect` is iframe-local (the SAME
 * rect the selection ring for this node was just positioned with), so no
 * extra measurement pass. `label` is the node's tag or display name; a
 * `null` rect or label hides the badge.
 */
export function positionNodeBadge(
  badge: HTMLElement | null,
  ringRect: CanvasOverlayRect | null,
  label: string | null,
): void {
  if (!badge) return
  if (!ringRect || !label) {
    if (appliedBadgePlacements.get(badge) !== 'hidden') {
      badge.style.display = 'none'
      appliedBadgePlacements.set(badge, 'hidden')
    }
    return
  }

  const prev = appliedBadgePlacements.get(badge)
  if (
    prev !== undefined &&
    prev !== 'hidden' &&
    prev.x === ringRect.x &&
    prev.y === ringRect.y &&
    prev.label === label
  ) {
    return
  }

  if (badge.textContent !== label) badge.textContent = label
  badge.style.display = ''
  // Measured AFTER `textContent`/`display` are current, so `offsetHeight`
  // reflects the label actually being shown this tick.
  const badgeHeight = badge.offsetHeight || NODE_BADGE_FALLBACK_HEIGHT
  const aboveY = ringRect.y - badgeHeight - NODE_BADGE_GAP
  const y = aboveY >= 0 ? aboveY : ringRect.y + NODE_BADGE_GAP
  badge.style.transform = `translate(${ringRect.x}px, ${y}px)`
  appliedBadgePlacements.set(badge, { x: ringRect.x, y: ringRect.y, label })
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

// ---------------------------------------------------------------------------
// Rect predicates — asked by the overlay's RAF tick every frame, to decide
// whether anything actually moved (and, in dev, whether a measurement came
// back sane). They live here, with the rect type and everything else that
// reasons about `CanvasOverlayRect`, rather than as private helpers in the
// one component that happens to call them.
// ---------------------------------------------------------------------------

/** Two nullable rects are equal when every field matches (or both are null). */
export function overlayRectsEqual(a: CanvasOverlayRect | null, b: CanvasOverlayRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** `null` (frame doesn't own the node — legitimate) or every field a finite number. */
export function overlayRectIsFinite(rect: CanvasOverlayRect | null): boolean {
  if (!rect) return true
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}
