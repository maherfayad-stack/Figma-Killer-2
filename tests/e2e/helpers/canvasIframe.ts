/**
 * canvasIframe — the ONE way a spec reaches into a board frame's canvas
 * document.
 *
 * ## Why a bare `frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)` is wrong
 *
 * A board frame of a Tier-2 (`run-project`) project — the DEFAULT tier, so
 * every fixture a spec copies or authors — renders `LiveBoardFrame`, which
 * mounts TWO canvas iframes at once until the live frame says `ready`:
 *
 *   - the Tier-0 fallback (a portal `BreakpointFrame`, same-origin, visible),
 *   - the bridge iframe (the project's own dev server), inside
 *     `[data-testid="live-board-frame-bridge"]`, which carries `hidden`.
 *
 * Both carry `title="Canvas frame for …"`. So `frame.frameLocator(SELECTOR)`
 * matches two elements and Playwright throws a strict-mode violation the
 * first time the spec acts through it, and `expect(frame.locator(SELECTOR))
 * .toHaveCount(1)` waits for a hand-off that never comes in a fixture whose
 * dev server cannot boot (no `node_modules`, or not a Vite project: every e2e
 * fixture). Once the live frame IS ready, the fallback unmounts and the bridge
 * iframe is the only one, and it is shown.
 *
 * Either way exactly one of them is the one the user is looking at: the one
 * that is displayed. That is the iframe these helpers pick. A hidden bridge
 * iframe (`display: none` through its wrapper's `hidden`) is never visible,
 * and a Tier-0/1 frame has only one iframe to begin with, so the rule needs
 * no knowledge of the trust tier.
 *
 * Every spec reaches a canvas iframe through these helpers. A spec that
 * wants the BRIDGE frame specifically (it asserts on live-frame behaviour)
 * says so with {@link liveBridgeIframe} rather than hoping `.first()` lands on
 * it.
 */
import type { FrameLocator, Locator, Page } from '@playwright/test'

/** Selector for a design-mode canvas iframe, visible or not — two of them in one Tier-2 board frame, see above. */
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

/** The wrapper `LiveBoardFrame` keeps the bridge iframe in; `hidden` until the live frame is ready. */
const LIVE_BRIDGE_WRAPPER = '[data-testid="live-board-frame-bridge"]'

/**
 * The displayed canvas iframe(s) inside `scope` — one per board frame. Scope
 * it to one board frame (`[data-page-id]`, `board-frame-body`) to get exactly
 * one; scoped to the page it yields one per mounted board frame.
 */
export function visibleCanvasIframe(scope: Locator | Page): Locator {
  return scope.locator(CANVAS_FRAME_IFRAME_SELECTOR).filter({ visible: true })
}

/**
 * The document of the displayed canvas iframe in `scope` (see the module doc
 * for why it is not simply the first match). Lazy, like any `FrameLocator`:
 * it re-resolves on every action, so a fallback that hands off to a ready
 * live frame mid-spec is followed rather than acted on after it is gone.
 */
export function canvasContentFrame(scope: Locator | Page): FrameLocator {
  return visibleCanvasIframe(scope).contentFrame()
}

/**
 * The live (bridge) canvas iframe of one board frame, once that live frame is
 * READY — its wrapper has dropped `hidden`. For specs that assert on
 * live-frame behaviour and must never silently measure the portal fallback.
 */
export function liveBridgeIframe(boardFrame: Locator): Locator {
  return boardFrame.locator(`${LIVE_BRIDGE_WRAPPER}:not([hidden]) ${CANVAS_FRAME_IFRAME_SELECTOR}`)
}

/** Which document a board frame shows once it has settled — see {@link settleCanvasFrameMode}. */
export type CanvasFrameMode = 'portal' | 'live'

/** A dev server that reads `stopped` this long after the board opened was never started for it (not live-capable), not about to boot. */
const STOPPED_GRACE_MS = 5_000

/**
 * Wait until `boardFrame` has settled on the document it will KEEP, and say
 * which one it is.
 *
 * A Tier-2 board frame shows the portal fallback while its live frame boots,
 * then swaps to the live (bridge) iframe the moment it is `ready`. Studio runs
 * only the project's OWN Vite (`projectPackageBin.ts`, never one above the
 * project), so the tracked fixtures, which carry no `node_modules`, stay on the
 * fallback; a fixture that copies this checkout's Vite into itself
 * (`liveAnimatedFixture.ts`) really swaps, some seconds into a spec. A spec
 * that clicks before it acts on one document and asserts after it on the
 * other: the selection ring of a portal frame is drawn INSIDE its iframe, a
 * live frame's in the editor document. Waiting for the dev server to settle
 * first (ready and shown, or finally not ready) takes the race out.
 *
 * `projectDir` is the project the board shows — the dev server's status is
 * read from the product's own route, the same one the canvas polls.
 */
export async function settleCanvasFrameMode(
  page: Page,
  boardFrame: Locator,
  projectDir: string,
  timeoutMs = 120_000,
): Promise<CanvasFrameMode> {
  const deadline = Date.now() + timeoutMs
  let stoppedSince: number | null = null
  for (;;) {
    if ((await liveBridgeIframe(boardFrame).count()) > 0) return 'live'
    // No bridge at all: a Tier-0/1 frame, which only ever shows the portal.
    if ((await boardFrame.locator(LIVE_BRIDGE_WRAPPER).count()) === 0) return 'portal'
    const res = await page.request.get(`/admin/api/studio/dev-server/status?dir=${encodeURIComponent(projectDir)}`)
    // 409: the project is not at Tier 2 after all, so nothing will boot.
    if (!res.ok()) return 'portal'
    const body: unknown = await res.json()
    const phase = typeof body === 'object' && body !== null && 'phase' in body ? String(body.phase) : ''
    if (phase === 'failed') return 'portal'
    if (phase === 'stopped') {
      stoppedSince ??= Date.now()
      if (Date.now() - stoppedSince > STOPPED_GRACE_MS) return 'portal'
    } else {
      stoppedSince = null
    }
    if (Date.now() > deadline) {
      throw new Error(`settleCanvasFrameMode: the board frame's dev server was still "${phase}" after ${timeoutMs} ms`)
    }
    await page.waitForTimeout(500)
  }
}

const SELECTION_RING = '[data-canvas-selection-ring="true"]'

/** The selection rings of `boardFrame` in the document `mode` draws them in: inside a portal frame's iframe, in the editor document for a live frame. */
export function selectionRings(page: Page, boardFrame: Locator, mode: CanvasFrameMode): Locator {
  return mode === 'live' ? page.locator(SELECTION_RING) : canvasContentFrame(boardFrame).locator(SELECTION_RING)
}
