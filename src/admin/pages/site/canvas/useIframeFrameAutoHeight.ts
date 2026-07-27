import { useEffect, type RefObject } from 'react'
import { resolveCanvasFrameHeight } from './iframeFrameHeight'
import { CANVAS_VIEWPORT_HEIGHT } from './resolveViewportUnits'
import { collectScrollDeficits, resolveFrameFitHeight } from './resolveFrameFitHeight'
import {
  getIframeObserverConstructors,
  getIframeObserverDocument,
  observeIframeMutations,
} from './iframeFrameObservers'

interface UseIframeFrameAutoHeightOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  iframeDoc: Document | null
  isLive: boolean
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
 */
export function useIframeFrameAutoHeight({
  iframeRef,
  iframeDoc,
  isLive,
}: UseIframeFrameAutoHeightOptions): void {
  useEffect(() => {
    if (isLive || !iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
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
      if (rafId === null) rafId = requestAnimationFrame(measure)
    }

    measure()

    const ro = new FrameResizeObserver(scheduleMeasure)
    ro.observe(observerBody)
    ro.observe(observerRoot)
    const mo = observeIframeMutations(FrameMutationObserver, observerDocument, () => {
      selfResizes = 0
      // Real content changed, so the fit has to be re-derived from scratch —
      // otherwise an edit that REMOVES content leaves the frame stuck at the
      // height the old content needed. Re-fitting is monotonic from the viewport
      // height again, so this is the only place the pin can shrink, and it takes
      // a user edit to get here.
      pinnedHeight = CANVAS_VIEWPORT_HEIGHT
      fitPasses = 0
      if (observerDocument.body) {
        observerDocument.body.style.height = `${CANVAS_VIEWPORT_HEIGHT}px`
      }
      scheduleMeasure()
    })
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
      mo?.disconnect()
    }
  }, [iframeDoc, iframeRef, isLive])
}
