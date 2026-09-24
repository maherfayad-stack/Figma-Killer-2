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
