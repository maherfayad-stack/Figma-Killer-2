/**
 * useFramePosterCapture — rasterizes a board frame's iframe into
 * `frameSnapshotCache` once it settles on screen (WS-5.3).
 *
 * Reuses the exact rasterization mechanism `renderEvidence.ts`
 * (`captureElementScreenshot`, the agent's `site_render_snapshot` tool) already
 * uses for AI vision screenshots: `html-to-image`'s `toCanvas`, walked from
 * the iframe's `documentElement` so the captured background/box matches what
 * the user actually sees. Deliberately does NOT mount a second, offscreen
 * `AgentSnapshotFrame` per board frame — the frame calling this hook is
 * already a live, fully-rendered iframe while it's on screen, so rasterizing
 * it directly costs nothing extra in mounted iframes (virtualization's whole
 * point). `mcp-02` may be extending the `AgentSnapshotFrame` capture path
 * concurrently for a different purpose (frame export/diff) — this hook does
 * not touch that component.
 *
 * Fires once per settled `(page, width)` pair: the effect re-runs whenever
 * `page` (a new object reference on any edit — see `frameSnapshotCache.ts`),
 * `width`, or `isOnScreen` changes, and skips scheduling work when a fresh
 * poster is already cached or a capture for the exact same pair is already in
 * flight.
 *
 * WHEN it fires is `framePosterQueue`'s decision, not this hook's (S1). Each
 * frame used to arm its own settle timer, so a zoom-out that admitted a dozen
 * frames rasterized a dozen documents inside the gesture — ~100 ms of a single
 * 354 ms animation frame, spent on pictures that are only ever looked at once
 * the frame has LEFT the viewport. The queue holds every request until the
 * board has been quiet, then runs them one per macrotask; read its header for
 * the measurement and for why it is a `setTimeout` rather than an rAF/idle
 * chain. Requests are withdrawn when the frame goes back offscreen or
 * unmounts before its turn comes.
 *
 * L8 Phase B (`perf-06`, STATE.md) — called unconditionally by
 * `BoardFrameView` regardless of trust tier, so on a Tier-2
 * (`trust === 'run-project'`) board this ALREADY fires against
 * `LiveBoardFrame`'s Tier-0-fallback subtree (a real same-origin portal)
 * whenever that fallback — not the cross-origin bridge iframe — is the one
 * mounted. `findVisibleIframe` (below) makes that explicit rather than
 * incidental: `LiveBoardFrame` mounts BOTH the fallback and the (`hidden`)
 * bridge iframe at once while not ready, so this picks the one NOT sitting
 * behind a `hidden` ancestor instead of relying on DOM/JSX ordering. Once
 * the frame reaches `ready`, only the (hidden-no-longer, but cross-origin)
 * bridge iframe remains — `resolvePortalDocument` resolves `null` for it and
 * capture is skipped, same deliberate deferral as ever (`live-05`). Known,
 * accepted gap: a live frame that reaches `ready` before this hook's settle
 * delay elapses never gets a poster captured at all — the fallback it would
 * have rasterized has already unmounted by the time the timer fires. Not
 * fixed here: closing that race needs a synchronous capture hooked directly
 * to the bridge adapter's `ready` event (before React's state update swaps
 * the DOM), which is `LiveBoardFrame`'s own concern, not this hook's — see
 * `perf-06`'s STATE.md entry for why Phase B scoped this file only.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { Page } from '@core/page-tree'
import { resolvePortalDocument } from '../frameAdapter/resolvePortalDocument'
import { getFramePoster, setFramePoster } from './frameSnapshotCache'
import { cancelFramePoster, requestFramePoster } from './framePosterQueue'

/** Longest edge of a captured poster, in device pixels — a placeholder is shown small while panned/zoomed out, so it never needs full frame resolution. */
const POSTER_MAX_EDGE = 480

/**
 * The first `<iframe>` under `containerEl` that is NOT sitting behind a
 * `hidden` ancestor. For a Tier 0/1 frame there is only ever one iframe, so
 * this is equivalent to the old `querySelector('iframe')`. For a Tier-2
 * `LiveBoardFrame` (L8 Phase B) there can be TWO — the Tier-0-fallback
 * (visible while `!ready`) and the bridge iframe (kept mounted but
 * `hidden`-toggled off until `ready`) — and this makes "capture the visible
 * one" an explicit rule instead of an accident of JSX/DOM order.
 */
function findVisibleIframe(containerEl: HTMLElement): HTMLIFrameElement | null {
  for (const iframe of containerEl.querySelectorAll('iframe')) {
    if (!iframe.closest('[hidden]')) return iframe
  }
  return null
}

export function useFramePosterCapture(
  frameBodyRef: RefObject<HTMLElement | null>,
  page: Page,
  width: number,
  isOnScreen: boolean,
): void {
  const inFlightRef = useRef<{ page: Page; width: number } | null>(null)
  // This frame's identity in the shared queue, so a re-request replaces its
  // own pending entry instead of queueing a second one.
  const tokenRef = useRef<object>({})

  useEffect(() => {
    if (!isOnScreen) return
    if (getFramePoster(page, width)) return
    if (inFlightRef.current?.page === page && inFlightRef.current.width === width) return

    const token = tokenRef.current
    requestFramePoster(token, async () => {
      const iframe = frameBodyRef.current && findVisibleIframe(frameBodyRef.current)
      // Portal-mode only: `html-to-image` needs a real, same-origin
      // `documentElement` to rasterize — a bridge-registered iframe (or an
      // unregistered one) resolves `null` here and this poster is simply
      // skipped, same deferral as every other pixel-capture concern this
      // migration has logged (`live-05`, STATE.md).
      if (!iframe || !resolvePortalDocument(iframe)?.documentElement) return
      inFlightRef.current = { page, width }
      await capturePoster(iframe, page, width)
    })

    return () => cancelFramePoster(token)
  }, [frameBodyRef, page, width, isOnScreen])
}

async function capturePoster(iframe: HTMLIFrameElement, page: Page, width: number): Promise<void> {
  try {
    const documentElement = resolvePortalDocument(iframe)?.documentElement
    if (!documentElement) return
    const captureWidth = iframe.clientWidth || width
    const captureHeight = iframe.clientHeight || captureWidth
    if (captureWidth <= 0 || captureHeight <= 0) return

    const pixelRatio = Math.min(
      1,
      POSTER_MAX_EDGE / Math.max(1, captureWidth),
      POSTER_MAX_EDGE / Math.max(1, captureHeight),
    )

    const { toCanvas } = await import('html-to-image')
    const canvas = await toCanvas(documentElement, {
      cacheBust: false,
      pixelRatio,
      imagePlaceholder: '',
      width: captureWidth,
      height: captureHeight,
    })
    setFramePoster(page, width, canvas.toDataURL('image/png'))
  } catch (err) {
    // Best-effort — a failed rasterization just leaves the plain title
    // placeholder standing; it is never the only content a user can see.
    console.warn('[useFramePosterCapture] poster capture failed:', err)
  }
}
