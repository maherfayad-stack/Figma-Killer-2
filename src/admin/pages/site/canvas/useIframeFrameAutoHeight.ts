import { useEffect, type RefObject } from 'react'
import { resolveCanvasFrameHeight } from './iframeFrameHeight'
import { CANVAS_VIEWPORT_HEIGHT } from './resolveViewportUnits'
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
 * Keeps design-canvas iframes expanded to their content height, and keeps the
 * frame document's `<body>` height DEFINITE at that same value.
 *
 * Canvas frames should not have their own scrollbars: inner iframe scroll
 * consumes the wheel events that the parent canvas needs for pan/zoom. The
 * self-resize cap prevents viewport-unit feedback loops where growing the
 * iframe changes the child document's `vh` reference and causes endless growth.
 *
 * Why body's height is pinned rather than left `auto`
 * ───────────────────────────────────────────────────
 * A percentage height only resolves against a parent whose height is DEFINITE;
 * against `auto` it degrades to `auto` itself. So with an `auto` body, an
 * authored app-shell chain — `html, body, #root { height: 100% }` on top of a
 * `height: 100%` flex column — collapses to its own content height in the
 * canvas, and every `flex: 1` scroll viewport inside it computes to 0. On the
 * imported eSIM corpus that clipped a screen's entire 1447px body to nothing
 * while the frame showed the header and empty space below it.
 *
 * Pinning body to the frame height is the same move `resolveViewportUnits`
 * makes for `vh`: give authored CSS a definite, device-like viewport to resolve
 * against instead of a value derived from the content it is supposed to size.
 * Grow-to-content still works, because the pin tracks the measured content
 * height rather than a constant — a 3000px document page pins to 3000.
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
    const {
      ResizeObserver: FrameResizeObserver,
      MutationObserver: FrameMutationObserver,
    } = getIframeObserverConstructors(iframe)

    const measure = () => {
      rafId = null
      const body = observerDocument.body
      const html = observerDocument.documentElement
      if (!body || !html) return
      const current = parseFloat(iframe.style.height || '0')
      // Unpin before measuring. A pinned height floors `body.scrollHeight`, so
      // a page whose content got shorter could never shrink back — the same
      // staleness `resolveCanvasFrameHeight` already guards against for
      // `documentElement`. Reading `scrollHeight` next forces the layout that
      // makes this reset take effect.
      body.style.height = 'auto'
      const target = resolveCanvasFrameHeight({
        bodyScrollHeight: body.scrollHeight,
        documentScrollHeight: html.scrollHeight,
        currentFrameHeight: current,
      })
      // Re-pin unconditionally, including on the no-change path below: this is
      // the definite percentage-height basis authored CSS resolves against (see
      // this hook's doc comment), not a consequence of the frame resizing.
      //
      // Floored at the same `min-height` the body reset applies, which is what
      // body's used height already is — so the pin states that height rather
      // than shrinking the frame to a `scrollHeight` measured before layout has
      // settled (or in an environment that reports 0 for it).
      body.style.height = `${Math.max(target, CANVAS_VIEWPORT_HEIGHT)}px`
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
      scheduleMeasure()
    })
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
      mo?.disconnect()
    }
  }, [iframeDoc, iframeRef, isLive])
}
