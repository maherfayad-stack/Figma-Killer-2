/**
 * canvasDragSession — the `frameCandidateIndex` behind an element drag, and
 * the pure geometry a live drag session asks of it.
 *
 * ## Why an index at all (D2 G6)
 *
 * The old drag did two FORCED LAYOUT READS per raw `pointermove`
 * (`viewport.getBoundingClientRect()` inside `getViewportLocalPoint`, then
 * again inside `getViewportZoom`) on top of a `setState`. A trackpad or a
 * 1000 Hz mouse raises pointermove well past the frame rate, so a gesture
 * that changes nothing about layout was invalidating and re-reading layout
 * dozens of times per painted frame — the measured shape of G6.
 *
 * Every input those two reads recover is CONSTANT for the length of a drag:
 *
 *  - the candidate rects, because a reorder drag does not reflow the page it
 *    is dragging inside (the store is written once, on `pointerup`);
 *  - the viewport's client origin and the canvas scale, because the transform
 *    layer only moves when the canvas pans or zooms.
 *
 * So both are measured ONCE at `beginDrag` and re-measured only when one of
 * those two assumptions is actually violated:
 *
 *  - **a real reflow** — a `ResizeObserver` on the frame body marks the index
 *    `stale`, and the next rAF rebuilds the candidate rects;
 *  - **a real transform change** — the LIVE `transformRef` from `useCanvas()`
 *    (never the store's `zoom`/`panX`/`panY`, which are the ~100 ms-debounced
 *    COMMIT values and therefore lag a gesture by design) is compared against
 *    the transform the origin was measured under. Auto-pan is the case that
 *    makes this necessary: it moves the layer under a stationary pointer.
 *
 * Candidate rects themselves survive a pan or a zoom untouched, because they
 * are stored in VIEWPORT-LOCAL (frame-space) coordinates — `left` is
 * `(clientLeft - viewportClientLeft) / scale`, and a pure translate or scale
 * of the whole transform layer cancels out of both terms. Only the
 * client→frame-space conversion of the POINTER needs a fresh origin.
 *
 * ## Bridge frames
 *
 * A Tier 2 frame's document is cross-origin: there is nothing to scan and no
 * body to observe. Its candidates are asked for over the wire, once at
 * `pointerdown` and again only when the index goes stale (a reparse under the
 * gesture), and they arrive a round trip later — in practice long before the
 * pointer clears the activation distance. Until they do the index is empty,
 * which resolves exactly like a pointer over no candidate: no drop target.
 *
 * ## What this module deliberately does not do
 *
 * It holds no React state, touches no DOM outside the two measurement calls,
 * and knows nothing about the store. The session that owns it
 * (`useCanvasReorderDrag`) writes the store exactly once, on `pointerup`.
 */
import type { PageNode, NodeTree } from '@core/page-tree'
import type { CanvasDropCandidate } from './canvasDnd'
import { measureCanvasDropCandidates, measureDropCandidatesThroughAdapter } from './canvasDomGeometry'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { CanvasTransform } from './math'

/** A point in the parent document's client coordinate space. */
export interface ClientPoint {
  x: number
  y: number
}

/**
 * Everything opening a drag session needs, in whichever coordinate space the
 * press was captured.
 *
 * Lives here rather than in `useCanvasReorderDrag` because it is the contract
 * between the session and BOTH of its activation points — the selection
 * toolbar's hand-grab handle (parent document) and `useCanvasBodyDragTrigger`
 * (inside the frame's iframe) — and a shape one of them imported from the
 * other would make the two look asymmetrical when they are not.
 */
export interface CanvasDragOrigin {
  pointerId: number
  /**
   * PARENT-document client coordinates, always. Every subsequent pointermove
   * reaches the session's window listeners in that space (either natively, or
   * translated by `IframeFrameSurface`'s relay), so an origin measured in any
   * other space would make the activation distance and the first resolved
   * drop target wrong by the iframe's offset.
   */
  clientX: number
  clientY: number
  /** Node ids this gesture proposes to move, before locked/root filtering. */
  candidateIds: readonly string[]
  /** The one of `candidateIds` the gesture is "about", when it has an opinion. */
  preferredDraggedId: string | null
  /** Node to select once the gesture stops being a click — see the session's own doc. */
  selectOnActivate: string | null
  frameId: string | null
  /** K2 — Alt was already held at `pointerdown`, so the ghost reads `+` from the first frame. */
  altKey: boolean
  /** K6 — ⌘/Ctrl was already held at `pointerdown`: place by coordinates, not by order. */
  freeKey: boolean
}

/**
 * Everything a drag session measures once and then reuses: the drop
 * candidates of one frame, plus the conversion from parent-document client
 * coordinates into the frame-space those rects live in.
 */
export interface FrameCandidateIndex {
  candidates: CanvasDropCandidate[]
  /** `viewport.getBoundingClientRect().left` at the last origin refresh. */
  originX: number
  /** `viewport.getBoundingClientRect().top` at the last origin refresh. */
  originY: number
  /** Live canvas zoom (1 = 100%) at the last origin refresh. */
  scale: number
  /**
   * The canvas transform the origin above was measured under, or `null` when
   * no live `transformRef` was available (tests, a frame outside
   * `CanvasTransformLayer`). `null` disables the transform check entirely
   * rather than refreshing on every frame — a surface with no live transform
   * has nothing that could move the origin mid-gesture.
   */
  transform: CanvasTransform | null
  /**
   * Set by the frame body's `ResizeObserver`: the page inside the frame
   * reflowed, so `candidates` no longer describes it. The next rAF rebuilds
   * them. Named `stale` rather than `dirty` because the rects are still
   * usable (and used) until the rebuild lands — a drag must never show
   * nothing while it re-measures.
   */
  stale: boolean
  /** Bumped per bridge-frame request, so only the newest answer is applied. */
  measureGeneration: number
  /** Called when a bridge frame's candidates land — see `buildFrameCandidateIndex`. */
  onMeasured: (() => void) | null
}

/**
 * Measure a frame's drop candidates and the client→frame-space conversion, once.
 *
 * `onMeasured` is called when candidates land LATER than this call — a
 * bridge frame's answer is a round trip (see `measureCandidatesInto`), so the
 * session asks for a frame when it arrives rather than waiting for the next
 * pointer move to notice it.
 */
export function buildFrameCandidateIndex(
  viewport: HTMLElement,
  tree: NodeTree<PageNode>,
  iframe: HTMLIFrameElement | null,
  transform: CanvasTransform | null,
  onMeasured?: () => void,
): FrameCandidateIndex {
  const index: FrameCandidateIndex = {
    candidates: [],
    originX: 0,
    originY: 0,
    scale: 1,
    transform: transform ? { ...transform } : null,
    stale: false,
    measureGeneration: 0,
    onMeasured: onMeasured ?? null,
  }
  measureCandidatesInto(index, viewport, tree, iframe)
  refreshIndexOrigin(index, viewport, transform)
  return index
}

/** The frame's adapter when it is a Tier 2 BRIDGE frame (a cross-origin document), else `null`. */
function bridgeAdapterOf(iframe: HTMLIFrameElement | null): FrameDocumentAdapter | null {
  if (!iframe) return null
  const adapter = listFrameAdapters().get(iframe)
  return adapter && !isPortalFrameAdapter(adapter) ? adapter : null
}

/**
 * Fill `index.candidates`. A portal frame is one synchronous DOM scan. A
 * bridge frame's document is cross-origin, so its candidates come over the
 * wire (`measureDropCandidatesThroughAdapter`) and land a round trip later:
 * the previous candidates stay in use until then (a drag must never show
 * nothing while it re-measures), and an answer that a newer request has
 * superseded is dropped.
 */
function measureCandidatesInto(
  index: FrameCandidateIndex,
  viewport: HTMLElement,
  tree: NodeTree<PageNode>,
  iframe: HTMLIFrameElement | null,
): void {
  const adapter = bridgeAdapterOf(iframe)
  if (!adapter || !iframe) {
    index.candidates = measureCanvasDropCandidates(viewport, tree, iframe)
    return
  }
  index.measureGeneration += 1
  const generation = index.measureGeneration
  measureDropCandidatesThroughAdapter(adapter, viewport, iframe, tree)
    .then((candidates) => {
      if (index.measureGeneration !== generation) return
      index.candidates = candidates
      index.onMeasured?.()
    })
    .catch((err: unknown) => {
      // A frame mid-reload does not answer; the drag keeps what it had and the
      // next reflow (or the next drag) asks again.
      console.warn('[canvasDragSession] bridge drop candidates failed:', err)
    })
}

/**
 * Bring `index` up to date with whatever has actually changed, and nothing
 * else. Both halves are no-ops in the common case — a pointer moving over a
 * still page on a still canvas costs zero layout reads here.
 */
export function refreshFrameCandidateIndex(
  index: FrameCandidateIndex,
  viewport: HTMLElement,
  tree: NodeTree<PageNode>,
  iframe: HTMLIFrameElement | null,
  transform: CanvasTransform | null,
): void {
  if (index.stale) {
    measureCandidatesInto(index, viewport, tree, iframe)
    index.stale = false
  }
  if (transformMoved(index.transform, transform)) {
    refreshIndexOrigin(index, viewport, transform)
  }
}

function transformMoved(previous: CanvasTransform | null, next: CanvasTransform | null): boolean {
  // No live transform on either side: nothing can have moved the origin that
  // this comparison would catch — see `FrameCandidateIndex.transform`.
  if (!previous || !next) return false
  return previous.zoom !== next.zoom || previous.panX !== next.panX || previous.panY !== next.panY
}

/**
 * The one place this module reads layout. Kept separate from the candidate
 * scan because the two go stale for completely different reasons and at
 * completely different prices: this is a single `getBoundingClientRect()`,
 * the scan is one per `[data-node-id]` in the frame.
 */
function refreshIndexOrigin(
  index: FrameCandidateIndex,
  viewport: HTMLElement,
  transform: CanvasTransform | null,
): void {
  const rect = viewport.getBoundingClientRect()
  index.originX = rect.left
  index.originY = rect.top
  // Same scale recovery `getViewportZoom` performs, from the rect we are
  // already holding: the viewport element is scaled by the canvas transform,
  // its `offsetWidth` is its untransformed layout width.
  index.scale = viewport.offsetWidth > 0 ? rect.width / viewport.offsetWidth : 1
  index.transform = transform ? { ...transform } : null
}

/** A parent-document client point, in the frame-space `index.candidates` is measured in. */
export function indexLocalPoint(index: FrameCandidateIndex, point: ClientPoint): ClientPoint {
  const scale = index.scale > 0 ? index.scale : 1
  return {
    x: (point.x - index.originX) / scale,
    y: (point.y - index.originY) / scale,
  }
}

/**
 * Shift-constrained pointer position: the pointer is projected onto whichever
 * axis it has travelled further along since the drag started, so a horizontal
 * intention cannot drift into a vertical reorder and vice versa.
 *
 * Applied in CLIENT space, before the frame-space conversion, so the axis the
 * user constrained is the one they see on screen rather than one recovered
 * through a scale.
 */
export function constrainToDragAxis(origin: ClientPoint, point: ClientPoint): ClientPoint {
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: point.x, y: origin.y }
    : { x: origin.x, y: point.y }
}
