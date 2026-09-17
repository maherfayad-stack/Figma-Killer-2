/**
 * overlayMeasureScheduler — WHEN `BreakpointSelectionOverlay` re-measures.
 *
 * ## What this replaced (S4)
 *
 * The overlay used to arm an uncapped `requestAnimationFrame` loop for as long
 * as `hasOverlayWork` was true — i.e. forever while anything was selected or
 * hovered, once per MOUNTED FRAME. A board with eight frames and one selected
 * node ran eight loops at 60 Hz over an idle canvas, which is enough to keep
 * the main thread from ever sleeping and to defeat frame virtualization's
 * whole point.
 *
 * The loop existed because the overlay tracks an element inside another
 * document and any of a dozen things can move it. That is a real problem, but
 * polling is the wrong answer to it: every one of those dozen things is an
 * event. This module subscribes to them and measures once per event instead.
 *
 * ## The two modes
 *
 * **Continuous** — a real per-frame loop, armed ONLY while something is
 * changing the geometry on every frame and no event can fire per frame:
 *
 *   - a page-mutating pointer gesture (`canvasGesture.ts` — the element
 *     resize drag),
 *   - a reorder drag or an animation replay (passed in as `continuous`,
 *     because both are render-visible state the overlay already holds),
 *   - a pan/zoom (`canvasViewportActivity.ts` — the live transform is a ref
 *     that never changes identity and the store commit is 100 ms late, so the
 *     gesture publishes itself),
 *   - the window between a bridge frame's `hmr:before` and `hmr:after`, where
 *     the frame's whole DOM is being swapped out from under us and the
 *     same-origin observers below cannot see into it at all.
 *
 * **Event-driven** — the default, and the point of the module. Zero rAF
 * callbacks per second on an idle board with a live selection. A measurement
 * is scheduled (coalesced to at most one per animation frame) by:
 *
 *   - a `ResizeObserver` on the frame body/root AND on each element the
 *     overlay is currently tracking — a late-loading image inside a
 *     fixed-height container resizes an element without mutating the DOM or
 *     the body, so the per-element observation is not redundant with the
 *     frame-level one,
 *   - a `MutationObserver` over the frame document (tree mutations, class and
 *     style attribute changes, injected stylesheets in `<head>`),
 *   - scroll inside the frame (capture phase — scroll does not bubble),
 *   - the adapter's `frame:resize` (the bridge-mode equivalent of the
 *     `ResizeObserver`, for a frame whose document we cannot reach),
 *   - a parent-window resize, which also invalidates the cached parent-document
 *     anchor because the canvas root's own rect moved,
 *   - and the overlay's own React effects (selection change, committed
 *     pan/zoom), which call `schedule()` directly.
 *
 * ## Why the mutation observer skips `overlayRoot`
 *
 * The overlay's WRITE phase sets inline styles on ring/badge elements that live
 * inside `overlayRoot`, which is inside the observed document. Counting those
 * as "the page changed" would make every measurement schedule another one.
 * `appliedOverlayPlacements` (`canvasSelectionOverlayPositioning.ts`) already
 * no-ops unchanged writes, so the loop would terminate after one extra pass —
 * but "terminates eventually" is how the permanent loop this module replaces
 * got written in the first place. Filtering is exact and costs one `contains`.
 */

import type { CanvasRectSource } from './canvasDomGeometry'
import { isCanvasGestureActive, onCanvasGestureChange } from './canvasGesture'
import { isCanvasViewportActive, onCanvasViewportActivityChange } from './canvasViewportActivity'
import { listFrameAdapters, onFrameAdapterRegistryChange } from './frameAdapter/canvasFrameAdapterRegistry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'

/**
 * Hard ceiling on the `hmr:before → hmr:after` continuous window. The bridge
 * runtime always sends the closing message, but a frame that crashed during
 * the swap never will, and an unbounded hold would resurrect exactly the
 * permanent loop this module exists to delete.
 */
const HMR_HOLD_CEILING_MS = 2000

/**
 * A `ResizeObserver` target, duck-typed.
 *
 * The overlay's tracked "elements" are `CanvasRectSource`s — the measurement
 * path only ever asks them for `getBoundingClientRect()`/`children`, so a
 * zero-DOM fragment node resolves to something that is not an `Element` at all.
 * And a real element arrives from ANOTHER REALM (the frame's document), where
 * `instanceof Element` is false against the parent window's constructor. Hence
 * `nodeType === 1` rather than either check — the same duck-typing
 * `nodeVisualRect` settled on, for the same two reasons.
 */
function asObservableElement(target: CanvasRectSource | null): Element | null {
  if (!target || typeof target !== 'object') return null
  return (target as Partial<Node>).nodeType === 1 ? (target as unknown as Element) : null
}

export interface OverlayMeasureSchedulerOptions {
  /** The frame's iframe element — both the measurement subject and the event source. */
  iframeElement: HTMLIFrameElement | null
  /**
   * The in-iframe overlay root the overlay writes its rings into, so the
   * mutation observer can ignore the overlay's own writes. `null` in live mode
   * and during the brief startup window before the injector's effect has run.
   */
  overlayRoot: HTMLElement | null
  /**
   * Run one measurement pass. Called from the rAF pump — never synchronously
   * from `createOverlayMeasureScheduler` itself, so the caller may close over
   * state that is still being initialised.
   */
  measure: () => void
  /**
   * Drop the cached parent-document anchor before the next pass. Called only
   * for events that moved the PARENT document's geometry (a window resize),
   * which the overlay's own in-iframe rect comparison cannot detect.
   */
  invalidateAnchor: () => void
  /**
   * True when render-visible state already says a continuous gesture is in
   * flight (a reorder drag, an animation replay). The scheduler is recreated
   * when this flips, which is twice per drag — cheap next to a frame of work.
   */
  continuous: boolean
}

export interface OverlayMeasureScheduler {
  /** Measure on the next animation frame. Coalesces; no-ops after `dispose`. */
  schedule(): void
  /**
   * The elements the overlay is currently tracking, so their size changes
   * schedule a measurement. Called from the measurement pass itself with the
   * elements it just resolved; a no-op when the set is unchanged.
   */
  observe(targets: readonly (CanvasRectSource | null)[]): void
  dispose(): void
}

export function createOverlayMeasureScheduler(
  options: OverlayMeasureSchedulerOptions,
): OverlayMeasureScheduler {
  const { iframeElement, overlayRoot, measure, invalidateAnchor } = options

  let disposed = false
  let frame = 0
  const holds = new Set<string>()
  if (options.continuous) holds.add('render')
  if (isCanvasGestureActive()) holds.add('gesture')
  if (isCanvasViewportActive()) holds.add('viewport')

  const pump = () => {
    frame = 0
    if (disposed) return
    measure()
    if (holds.size > 0) schedule()
  }

  const schedule = () => {
    if (disposed || frame !== 0) return
    frame = requestAnimationFrame(pump)
  }

  let hmrCeiling: ReturnType<typeof setTimeout> | null = null

  const setHold = (reason: string, active: boolean) => {
    if (active) holds.add(reason)
    else holds.delete(reason)
    // Entering continuous mode starts the loop; LEAVING it takes the one
    // settle measurement the geometry needs, because nothing was recomputed
    // while the hold was up. Both are exactly `schedule()`.
    schedule()
  }

  const cleanups: Array<() => void> = []
  cleanups.push(onCanvasGestureChange((active) => setHold('gesture', active)))
  cleanups.push(onCanvasViewportActivityChange((active) => setHold('viewport', active)))

  const handleWindowResize = () => {
    invalidateAnchor()
    schedule()
  }
  window.addEventListener('resize', handleWindowResize)
  cleanups.push(() => window.removeEventListener('resize', handleWindowResize))

  // ── ResizeObserver: the frame's own box, plus whatever the overlay tracks ──
  const pinned = new Set<Element>()
  let tracked: ReadonlySet<Element> = new Set()
  const observed = new Set<Element>()
  const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => schedule())
  cleanups.push(() => resizeObserver?.disconnect())

  const syncObserved = () => {
    if (!resizeObserver) return
    for (const element of observed) {
      if (pinned.has(element) || tracked.has(element)) continue
      resizeObserver.unobserve(element)
      observed.delete(element)
    }
    for (const element of [...pinned, ...tracked]) {
      if (observed.has(element)) continue
      resizeObserver.observe(element)
      observed.add(element)
    }
  }

  // ── The frame document's own observers (portal mode only) ─────────────────
  let frameDocument: Document | null = null
  let documentCleanups: Array<() => void> = []

  const bindFrameDocument = () => {
    const next = resolvePortalDocument(iframeElement)
    if (next === frameDocument) return
    for (const off of documentCleanups) off()
    documentCleanups = []
    pinned.clear()
    frameDocument = next
    if (!next) {
      syncObserved()
      return
    }

    // Scroll does not bubble — capture, on the document, catches every
    // scrollable ancestor inside the frame.
    const handleScroll = () => schedule()
    next.addEventListener('scroll', handleScroll, true)
    documentCleanups.push(() => next.removeEventListener('scroll', handleScroll, true))

    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          // The overlay's own ring writes — see this module's docblock.
          if (overlayRoot?.contains(record.target)) continue
          schedule()
          return
        }
      })
      observer.observe(next.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      documentCleanups.push(() => observer.disconnect())
    }

    pinned.add(next.documentElement)
    if (next.body) pinned.add(next.body)
    syncObserved()
  }

  // ── The frame adapter's runtime events (bridge mode's only signal) ────────
  let adapterCleanups: Array<() => void> = []

  const bindAdapter = () => {
    for (const off of adapterCleanups) off()
    adapterCleanups = []
    if (!iframeElement) return
    const adapter = listFrameAdapters().get(iframeElement)
    if (!adapter) return
    adapterCleanups.push(adapter.on('hmr:before', () => {
      if (hmrCeiling) clearTimeout(hmrCeiling)
      hmrCeiling = setTimeout(() => {
        hmrCeiling = null
        setHold('hmr', false)
      }, HMR_HOLD_CEILING_MS)
      setHold('hmr', true)
    }))
    adapterCleanups.push(adapter.on('hmr:after', () => {
      if (hmrCeiling) clearTimeout(hmrCeiling)
      hmrCeiling = null
      setHold('hmr', false)
    }))
    adapterCleanups.push(adapter.on('frame:resize', () => schedule()))
  }

  bindAdapter()
  bindFrameDocument()
  // The overlay and `IframeFrameSurface` are siblings, so either effect may run
  // first; re-resolve whenever the registry changes rather than polling for it.
  cleanups.push(onFrameAdapterRegistryChange(() => {
    bindAdapter()
    bindFrameDocument()
    schedule()
  }))
  cleanups.push(() => {
    for (const off of adapterCleanups) off()
    adapterCleanups = []
    for (const off of documentCleanups) off()
    documentCleanups = []
  })

  // One measurement for the state that made this scheduler exist (a fresh
  // selection, a new iframe, a gesture just starting).
  schedule()

  return {
    schedule,
    observe: (targets) => {
      const next = new Set<Element>()
      for (const target of targets) {
        const element = asObservableElement(target)
        if (element) next.add(element)
      }
      if (next.size === tracked.size) {
        let identical = true
        for (const element of next) {
          if (tracked.has(element)) continue
          identical = false
          break
        }
        if (identical) return
      }
      tracked = next
      syncObserved()
    },
    dispose: () => {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      if (hmrCeiling) clearTimeout(hmrCeiling)
      hmrCeiling = null
      for (const off of cleanups) off()
    },
  }
}
