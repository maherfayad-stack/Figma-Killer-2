import { useEffect, type RefObject } from 'react'
import {
  collectScrollDeficits,
  createFrameFitMutationScheduler,
  FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
  resolveFrameFitHeight,
} from '@core/studio-runtime'
import { isCanvasGestureActive, onCanvasGestureSettle } from './canvasGesture'
import { resolveCanvasFrameHeight } from './iframeFrameHeight'
import { CANVAS_VIEWPORT_HEIGHT } from './resolveViewportUnits'
import {
  getIframeObserverConstructors,
  getIframeObserverDocument,
  observeIframeMutations,
} from './iframeFrameObservers'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'

interface UseIframeFrameAutoHeightOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** Portal-mode-only — the escape hatch this hook's own portal branch still uses directly, alongside `adapter`, since its DOM-observer wiring is far more than a single `Document` reference. */
  iframeDoc: Document | null
  adapter: FrameDocumentAdapter | null
  /**
   * Whether the frame grows to its content at all. `false` for a live frame
   * (it scrolls natively) and for P5-G's free-canvas surface (a fixed window
   * over the board — its hosts are absolutely positioned and contribute no
   * content height to fit to).
   */
  fitToContent: boolean
}

/**
 * Sizes a design-canvas frame so the whole screen is visible at once: `<body>`
 * gets a definite height grown until nothing inside needs to scroll, and the
 * iframe element tracks that.
 *
 * Canvas frames should not have their own scrollbars: inner iframe scroll
 * consumes the wheel events that the parent canvas needs for pan/zoom. The
 * self-resize cap prevents viewport-unit feedback loops where growing the
 * iframe changes the child document's `vh` reference and causes endless growth.
 *
 * Two separate numbers, and they are not interchangeable:
 *
 *   - `resolveFrameFitHeight` → body's DEFINITE height. Owns the percentage
 *     basis (an authored `body { height: 100% }` chain resolves against it
 *     instead of collapsing) and the no-scroll guarantee. Grows only, from
 *     `CANVAS_VIEWPORT_HEIGHT`, because content height depends on the pin and a
 *     rule that could shrink it would flicker. See that module.
 *   - `resolveCanvasFrameHeight` → the iframe element's height on the parent
 *     canvas. Follows the document; owns shrinking back down when a page gets
 *     shorter.
 *
 * Nothing here writes a measured value into body: body is only ever the fitted
 * pin, which is what keeps the pin ⇄ relayout loop open.
 *
 * Bridge-mode branch (`live-05`, STATE.md, Batch 5): a cross-origin frame
 * cannot be observed from the parent at all (no `contentDocument` access),
 * so `runtime.ts` runs the BODY-pinning half of this same logic in-frame
 * (the SAME `resolveFrameFitHeight`/`collectScrollDeficits` pair, ported
 * into `@core/studio-runtime` for exactly this) and reports the result via
 * an outbound `frame:resize` message. This hook's bridge branch is only the
 * OTHER half — translating that reported height into the outer `<iframe>`
 * element's own height on the parent canvas, via the same
 * `resolveCanvasFrameHeight` shrink-capable smoothing portal mode uses.
 * `frame:resize` carries a single `body.scrollHeight` reading (not a
 * separate `documentElement.scrollHeight`, which only exists as a distinct
 * quantity due to a same-origin iframe-viewport-flooring quirk that doesn't
 * apply to a value read fresh, in-frame, every fit pass) — passing that one
 * value for BOTH of `resolveCanvasFrameHeight`'s inputs correctly collapses
 * its portal-only "stuck at the stale floor" branch to a no-op and always
 * falls through to trusting the reported height directly, which is exactly
 * right here.
 */
export function useIframeFrameAutoHeight({
  iframeRef,
  iframeDoc,
  adapter,
  fitToContent,
}: UseIframeFrameAutoHeightOptions): void {
  useEffect(() => {
    if (!fitToContent) return
    const iframe = iframeRef.current
    if (!iframe) return

    if (!isPortalFrameAdapter(adapter)) {
      if (!adapter) return
      let current = parseFloat(iframe.style.height || '0')
      return adapter.on('frame:resize', ({ height }) => {
        const target = resolveCanvasFrameHeight({
          bodyScrollHeight: height,
          documentScrollHeight: height,
          currentFrameHeight: current,
        })
        if (Math.abs(current - target) <= 0.5) return
        iframe.style.height = `${target}px`
        current = target
      })
    }

    if (!iframeDoc) return
    const observerDocument = getIframeObserverDocument(iframe, iframeDoc)
    const observerBody = observerDocument.body
    const observerRoot = observerDocument.documentElement
    if (!observerBody || !observerRoot) return

    const MAX_SELF_RESIZES = 60
    let selfResizes = 0
    let rafId: number | null = null
    // Body's current definite height. Only ever grows while a document is
    // mounted (see `resolveFrameFitHeight` for why shrinking would flicker); a
    // real DOM change resets it so an edited page can get shorter again.
    let pinnedHeight = CANVAS_VIEWPORT_HEIGHT
    let fitPasses = 0
    const {
      ResizeObserver: FrameResizeObserver,
      MutationObserver: FrameMutationObserver,
    } = getIframeObserverConstructors(iframe)

    const measure = () => {
      rafId = null
      const body = observerDocument.body
      const html = observerDocument.documentElement
      if (!body || !html) return

      // Grow body until nothing inside the frame needs to scroll. Reading
      // `scrollHeight`/`clientHeight` forces the layout that makes the previous
      // pass's pin take effect, so successive passes see real numbers.
      const fitted = resolveFrameFitHeight({
        pinnedHeight,
        scrollDeficits: collectScrollDeficits(observerDocument),
        passesUsed: fitPasses,
      })
      if (fitted !== null) {
        pinnedHeight = fitted
        fitPasses += 1
        body.style.height = `${fitted}px`
      }

      const current = parseFloat(iframe.style.height || '0')
      const target = resolveCanvasFrameHeight({
        bodyScrollHeight: body.scrollHeight,
        documentScrollHeight: html.scrollHeight,
        currentFrameHeight: current,
      })
      if (Math.abs(current - target) <= 0.5) {
        selfResizes = 0
        return
      }
      if (selfResizes >= MAX_SELF_RESIZES) return
      iframe.style.height = `${target}px`
      selfResizes += 1
    }
    const scheduleMeasure = () => {
      // While a pointer gesture is resizing something INSIDE the frame, the
      // body's size changes every frame — and refitting here would resize the
      // iframe element in the parent document and relayout the whole canvas,
      // once per pointermove, with the frame visibly growing under the cursor
      // the user is dragging. `canvasGesture`'s settle pass runs `measure`
      // once when the drag ends, against the final content. See its docblock.
      if (isCanvasGestureActive()) return
      if (rafId === null) rafId = requestAnimationFrame(measure)
    }

    measure()

    // The settle pass is why the skip above is safe: the ResizeObserver will
    // not necessarily fire again after a gesture, because the layout finished
    // changing while its events were being ignored.
    const releaseSettle = onCanvasGestureSettle(scheduleMeasure)

    const ro = new FrameResizeObserver(scheduleMeasure)
    ro.observe(observerBody)
    ro.observe(observerRoot)
    // Real content changed, so the fit has to be re-derived from scratch —
    // otherwise an edit that REMOVES content leaves the frame stuck at the
    // height the old content needed. Re-fitting is monotonic from the viewport
    // height again, so this is the only place the pin can shrink, and it takes
    // a user edit to get here. Coalesced through `frameFitMutationScheduler`
    // so inline-text-edit keystrokes (one `characterData` mutation each)
    // don't each pay the O(all elements) `collectScrollDeficits` scan this
    // triggers, and so the editor's own selection chrome (a hover ring
    // mounting under `<body>`, PERF-2) never triggers it at all — see that
    // module's doc for both rules.
    const scheduler = createFrameFitMutationScheduler({
      textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
      // A portal frame's DOM changes structurally only when the user does
      // something, and a delete should shrink the frame right away.
      structuralDebounceMs: 0,
      onSettle: () => {
        selfResizes = 0
        pinnedHeight = CANVAS_VIEWPORT_HEIGHT
        fitPasses = 0
        if (observerDocument.body) {
          observerDocument.body.style.height = `${CANVAS_VIEWPORT_HEIGHT}px`
        }
        scheduleMeasure()
      },
    })
    const mo = observeIframeMutations(FrameMutationObserver, observerDocument, (records) => {
      scheduler.handle(records)
    })
    return () => {
      releaseSettle()
      if (rafId !== null) cancelAnimationFrame(rafId)
      scheduler.dispose()
      ro.disconnect()
      mo?.disconnect()
    }
  }, [iframeDoc, iframeRef, fitToContent, adapter])
}
