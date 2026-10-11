/**
 * useFramePosterCapture — takes a mounted board frame's picture into
 * `framePosters` once its content has settled (WS-5.3, rebuilt in SB-2).
 *
 * ## When
 *
 * Whenever the frame holds a live, fully-committed document and the store has
 * no picture for its current key (`posterKey.ts`: content hash + axes +
 * width). That is a deliberate reversal of P2-I: the picture used to be taken
 * only as a frame LEFT the screen, because `html-to-image` cost 85-1,160 ms of
 * main thread and could not be run under the user's hands. It also meant a
 * frame evicted before the board went quiet never got one. The rasterizer is
 * now a serialize + one SVG paint (`posterRasterizer.ts`), so the picture is
 * refreshed in the background while the frame is live and idle, and is already
 * there when the frame is evicted, reopened or panned past.
 *
 * "Idle" is `framePosterQueue`'s decision, unchanged: nothing runs until the
 * board has been quiet, one capture per macrotask, withdrawn when the frame
 * unmounts or its key changes before its turn.
 *
 * ## Which document
 *
 * Portal frames only. A frame mounted in bridge mode (a cross-origin Tier-2
 * document) has no `Document` this thread may read; `LiveBoardFrame` mounts
 * the same-origin fallback beside it until it reports ready, and that is the
 * one rasterized (`findVisibleIframe`). Once the bridge frame is ready it is
 * skipped, same deferral as `live-05`.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { resolvePortalDocument } from '../frameAdapter/resolvePortalDocument'
import { framePosters } from './framePosters'
import { cancelFramePoster, requestFramePoster } from './framePosterQueue'
import { rasterizeFrameDocument } from './posterRasterizer'

/** The User Timing entry every poster capture records (name of a `performance.measure`). */
export const POSTER_CAPTURE_MEASURE = 'studio:poster-capture'

/** Longest edge of a captured poster, in device pixels. */
const POSTER_MAX_EDGE = 480

/**
 * The first `<iframe>` under `containerEl` that is NOT sitting behind a
 * `hidden` ancestor. A Tier-2 `LiveBoardFrame` can hold two — the
 * Tier-0-fallback (visible while `!ready`) and the bridge iframe (`hidden`
 * until `ready`) — and this makes "capture the visible one" an explicit rule.
 */
function findVisibleIframe(containerEl: HTMLElement): HTMLIFrameElement | null {
  for (const iframe of containerEl.querySelectorAll('iframe')) {
    if (!iframe.closest('[hidden]')) return iframe
  }
  return null
}

interface PosterNeed {
  /** The store already holds a picture for exactly this key. */
  hasPoster: boolean
  /** The frame holds a live iframe. */
  isMounted: boolean
  /** The iframe's node tree has committed (an empty mid-mount document would be photographed blank). */
  isContentReady: boolean
}

/** Whether this frame should ask for a picture now. */
export function framePosterNeeded({ hasPoster, isMounted, isContentReady }: PosterNeed): boolean {
  return isMounted && isContentReady && !hasPoster
}

export function useFramePosterCapture(
  frameBodyRef: RefObject<HTMLElement | null>,
  pageId: string,
  key: string,
  width: number,
  hasPoster: boolean,
  isMounted: boolean,
  isContentReady: boolean,
): void {
  // The key the frame wants NOW: a capture that finishes after an edit must not overwrite the newer picture.
  const currentKeyRef = useRef(key)
  useEffect(() => {
    currentKeyRef.current = key
  }, [key])

  useEffect(() => {
    if (!framePosterNeeded({ hasPoster, isMounted, isContentReady })) return

    // This effect instance's identity in the shared queue, so a re-request replaces its pending entry.
    const token = {}
    requestFramePoster(token, async () => {
      if (framePosters.has(key)) return
      const iframe = frameBodyRef.current && findVisibleIframe(frameBodyRef.current)
      const doc = iframe && resolvePortalDocument(iframe)
      if (!iframe || !doc?.documentElement) return
      await capturePoster(doc, iframe, { pageId, key }, width, currentKeyRef)
    })
    return () => cancelFramePoster(token)
  }, [frameBodyRef, pageId, key, width, hasPoster, isMounted, isContentReady])
}

async function capturePoster(
  doc: Document,
  iframe: HTMLIFrameElement,
  { pageId, key }: { pageId: string; key: string },
  width: number,
  currentKeyRef: RefObject<string>,
): Promise<void> {
  try {
    const captureWidth = iframe.clientWidth || width
    const captureHeight = iframe.clientHeight || captureWidth
    if (captureWidth <= 0 || captureHeight <= 0) return
    const startedAt = performance.now()
    const blob = await rasterizeFrameDocument(doc, { width: captureWidth, height: captureHeight, maxEdge: POSTER_MAX_EDGE })
    if (!blob || currentKeyRef.current !== key) return
    framePosters.put(key, blob)
    // Visible in a DevTools profile, and how the budgets prove how many pictures were taken.
    performance.measure(POSTER_CAPTURE_MEASURE, { start: startedAt, detail: { pageId } })
  } catch (err) {
    // Best-effort — a failed rasterization leaves the plain title placeholder standing.
    console.warn('[useFramePosterCapture] poster capture failed:', err)
  }
}
