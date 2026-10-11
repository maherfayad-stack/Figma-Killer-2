/**
 * frameChromeScheduler — WHEN a frame's selection chrome re-places itself.
 *
 * ## What this replaced (SB-4)
 *
 * `overlayMeasureScheduler.ts` owned a `MutationObserver` over the frame
 * document, a `ResizeObserver` per tracked element, a scroll listener and the
 * bridge's HMR hold: a second set of observers per frame, beside the ones
 * `geometryDirtySignal.ts` already runs for the rect index. The chrome is now
 * drawn from that index (`frameChromeRects.ts`), so the index's own dirty
 * signal IS the trigger, and this module subscribes to it instead of watching
 * the document again.
 *
 * ## Event driven, with two honest exceptions
 *
 * A pass is scheduled (coalesced into one microtask, so it lands before the
 * browser paints whatever caused it) by:
 *
 *   - `geometry:dirty` for THIS frame (`onFrameGeometryDirty`): content, a
 *     style attribute, a stylesheet, a font, an image, a transition, a scroll
 *     or a viewport resize moved boxes. The pass re-reads the index, which
 *     re-arms the latch;
 *   - the bridge's `hmr:after` and `frame:resize`: the frame swapped its DOM or
 *     changed height;
 *   - a parent-window resize, which also invalidates the cached toolbar anchor
 *     (the canvas root's own rect moved);
 *   - the end of a pan / zoom, for the toolbar and inspector anchor (the rings
 *     themselves follow the board's transform with no pass at all);
 *   - the owner's own effects (selection change, hover target, committed
 *     transform), which call `schedule()` directly.
 *
 * Two things move boxes with no event, and get a per-frame loop for exactly as
 * long as they last: a page-mutating pointer gesture (`canvasGesture.ts`, the
 * element resize drag, whose dirty signals arrive per frame anyway but whose
 * settle pass is still wanted) and the owner's `continuous` flag (a reorder
 * drag, an animation replay). An idle board with a live selection runs zero
 * callbacks.
 *
 * A pass is asynchronous (the index read is a promise: a bridge frame is a real
 * round trip), so passes never overlap: a request that arrives mid-pass is
 * remembered and runs once when the current one finishes.
 */
import { isCanvasGestureActive, onCanvasGestureChange } from './canvasGesture'
import { onCanvasViewportActivityChange } from './canvasViewportActivity'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { onFrameAdapterRegistryChange } from './frameAdapter/canvasFrameAdapterRegistry'
import { onFrameGeometryDirty } from './frameGeometry/frameGeometryRegistry'

export interface FrameChromeSchedulerOptions {
  /** The frame's iframe element: the key its dirty signal is filtered on. */
  iframeElement: HTMLIFrameElement | null
  /** One placement pass. May be async; never run concurrently with itself. */
  measure: () => void | Promise<void>
  /**
   * Drop the cached toolbar / inspector anchor before the next pass. Called
   * only for events that moved the PARENT document's geometry (a window resize).
   */
  invalidateAnchor: () => void
  /**
   * True when render-visible state already says something moves boxes with no
   * event (a reorder drag, an animation replay).
   */
  continuous: boolean
}

export interface FrameChromeScheduler {
  /** Place on the next microtask. Coalesces; no-ops after `dispose`. */
  schedule(): void
  dispose(): void
}

export function createFrameChromeScheduler(options: FrameChromeSchedulerOptions): FrameChromeScheduler {
  const { iframeElement, measure, invalidateAnchor } = options

  let disposed = false
  let queued = false
  let running = false
  let rerun = false
  let frame = 0
  const holds = new Set<string>()
  if (options.continuous) holds.add('render')
  if (isCanvasGestureActive()) holds.add('gesture')

  const pump = async (): Promise<void> => {
    queued = false
    if (disposed) return
    if (running) {
      rerun = true
      return
    }
    running = true
    try {
      await measure()
    } catch (err) {
      console.error('[frameChromeScheduler] placement pass failed:', err)
    } finally {
      running = false
    }
    if (disposed) return
    if (rerun) {
      rerun = false
      schedule()
    }
    if (holds.size > 0) armFrame()
  }

  function schedule(): void {
    if (disposed || queued) return
    queued = true
    queueMicrotask(() => void pump())
  }

  function armFrame(): void {
    if (disposed || frame !== 0 || holds.size === 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      schedule()
    })
  }

  const setHold = (reason: string, active: boolean): void => {
    if (active) holds.add(reason)
    else holds.delete(reason)
    // Entering a hold starts the loop; LEAVING one takes the settle pass the
    // geometry needs, because nothing was recomputed while the hold was up.
    schedule()
  }

  const cleanups: Array<() => void> = []
  cleanups.push(onCanvasGestureChange((active) => setHold('gesture', active)))
  // A pan needs no pass (the rings ride the board's transform); one settle pass
  // when it ends re-anchors the toolbar and inspector against where it rested.
  cleanups.push(onCanvasViewportActivityChange((active) => {
    if (!active) schedule()
  }))

  const handleWindowResize = (): void => {
    invalidateAnchor()
    schedule()
  }
  window.addEventListener('resize', handleWindowResize)
  cleanups.push(() => window.removeEventListener('resize', handleWindowResize))

  cleanups.push(onFrameGeometryDirty((dirty) => {
    if (dirty === iframeElement) schedule()
  }))

  // The bridge's own signals. The overlay and `IframeFrameSurface` are
  // siblings, so the adapter may register after this scheduler exists: re-bind
  // whenever the registry changes rather than polling for it.
  let adapterCleanups: Array<() => void> = []
  const bindAdapter = (): void => {
    for (const off of adapterCleanups) off()
    adapterCleanups = []
    if (!iframeElement) return
    const adapter = listFrameAdapters().get(iframeElement)
    if (!adapter) return
    adapterCleanups.push(adapter.on('hmr:after', schedule))
    adapterCleanups.push(adapter.on('frame:resize', schedule))
  }
  bindAdapter()
  cleanups.push(onFrameAdapterRegistryChange(() => {
    bindAdapter()
    schedule()
  }))
  cleanups.push(() => {
    for (const off of adapterCleanups) off()
    adapterCleanups = []
  })

  // One pass for the state that made this scheduler exist (a fresh selection, a
  // new iframe, a gesture just starting).
  schedule()
  armFrame()

  return {
    schedule,
    dispose: () => {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      for (const off of cleanups) off()
    },
  }
}
