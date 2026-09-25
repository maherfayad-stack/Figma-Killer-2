/**
 * Canvas frame-timing instrumentation, shared by every spec that puts a number
 * on a board gesture.
 *
 * This lives in one place for a concrete reason, not tidiness: `profileGesture`
 * installs a `requestAnimationFrame` sampler and two `MutationObserver`s on a
 * `window.__studioPerfSample` global. A second copy would mean a second
 * `declare global` for the same property and two subtly different definitions
 * of "worst frame" — and the whole point of these specs is that two runs of the
 * same gesture are comparable.
 *
 * Extracted from `studio-board-perf.e2e.ts` (`perf-01`). The zoom BUDGETS
 * moved here too, for the same reason and after they had been maintained in
 * two places for exactly one wave — see their own docblocks. Nothing here
 * asserts; it only measures and states the number to assert against.
 */
import type { Page } from '@playwright/test'

/**
 * **A ratchet on a defect that is now half fixed, not a 60fps target.**
 *
 * One number, read by `studio-board-perf.e2e.ts` and `studio-feel.e2e.ts`.
 * It was two — both specs measure the same defect on different corpora and
 * both were at 600 — and `perf-01` asked for exactly this hoist so the pair
 * could not be ratcheted apart.
 *
 * ## Where 250 comes from, and what it cannot claim
 *
 * `perf-01` measured a zoom-out that crosses virtualization boundaries at
 * **290-337 ms** on `studio-workspace/maherfayad-stack-eSIM` and left the
 * budget at 600, because both fixes it tried (`useDeferredValue`,
 * staggering) failed. S1 (`perf-07`) made one mount cheap instead of
 * rescheduling the batch. That corpus is no longer on any machine here, so
 * the stand-in was an 18-frame board of the same shape (865 DOM nodes vs the
 * eSIM board's 946), same scripted zoom, same runner, same machine:
 *
 * | 4 → 18 frame mount sweep | before S1 | after S1 |
 * |---|---|---|
 * | worst animation frame | 350 / 354 / 375 ms | 195 / 198 / 200 ms |
 * | mean animation frame | 41 / 46 / 44 ms | 22 / 21 / 21 ms |
 * | frames over 50 ms | 13 / 14 / 13 | 7 / 7 / 7 |
 *
 * 250 ms is ~1.25× the measured worst frame and comfortably BELOW every
 * pre-S1 measurement on either corpus, so the original defect would fail it.
 * It is deliberately not 50 ms: admitting a dozen frames at once still
 * creates a dozen documents and parses four stylesheets into each, which
 * nothing in S1 removes.
 *
 * **Re-measure against the real corpus before tightening further.** A budget
 * calibrated on a stand-in is a ratchet, not a target.
 *
 * ## The trap under the second spec
 *
 * `studio-feel.e2e.ts` runs against the TRACKED `studio-workspace/test4`,
 * whose three frames all fit inside the viewport margin at the opening zoom:
 * its scripted zoom-out mounts nothing at all (3 live iframes before, 3
 * after, on the pre- and post-S1 trees alike). Its zoom assertion is
 * therefore a SMOOTHNESS gate, not a mount gate. S1's mount pool sharpens
 * that further: it holds at least `MIN_FRAME_POOL` (8) live frames, so on a
 * board of 8 frames or fewer every frame stays mounted and there is no mount
 * left to measure. **A gate on the mount path needs a board of at least 9
 * frames.**
 *
 * That gate is `studio-board-perf.e2e.ts`, and since `verify-2` it has one:
 * the committed twelve-frame `studio-workspace/__board-perf-fixture`, which
 * exists for exactly this reason and says so in its own README. Both budgets
 * here are asserted there, on a board where the gesture really does mount.
 */
export const BUDGET_ZOOM_WORST_FRAME_MS = 250

/**
 * The frames that are NOT paying for a mount — the whole gesture, not the one
 * spike. 35 ms is ~1.6× the 22 / 21 / 21 ms mean S1 measured after its three
 * fixes, and below the 41 / 46 / 44 ms it measured before them: loose enough
 * not to flake on machine noise, tight enough that a re-render storm on every
 * wheel tick fails even while the single-mount spike above is still allowed.
 */
export const BUDGET_ZOOM_MEAN_FRAME_MS = 35

/**
 * **How long one real agent turn may take, wall clock, Send to stream close.**
 *
 * Read by `tests/e2e/agent-turn.e2e.ts` (`mcp-25`) — the first gate in this
 * repository backed by a turn that actually spent tokens. `mcp-22` shipped
 * `AGENT_TURN_BUDGETS` (90 s creative / 3 min balanced) as plan targets and
 * had `bench:agent-turn` WARN rather than fail against them, explicitly
 * "until a real turn is measured". This is that measurement.
 *
 * ## Where 300,000 comes from
 *
 * Four real turns, same brief ("Make the hero heading bolder and give the hero
 * card a subtle shadow"), same corpus (a throwaway copy of
 * `studio-workspace/__canonical-fixture`), `balanced` fidelity, the warm
 * `claude` CLI driver, this Windows box, 2026-09-18:
 *
 * | run | wall ms | tool rounds | writeback POSTs | files changed |
 * |---|---|---|---|---|
 * | 1 | 198,788 | 10 | 0 | the hero stylesheet |
 * | 2 |  56,362 |  8 | 0 | the hero stylesheet |
 * | 3 | 173,327 |  9 | 0 | the hero stylesheet |
 * | 4 | 149,801 | 15 | 0 | the hero stylesheet + its screen |
 *
 * Worst 198,788 ms; 1.5x is 298,182; rounded up to a legible five minutes.
 *
 * The spread is 3.5x on an IDENTICAL brief, which is the number to keep in
 * mind before tightening this: the slow runs are the ones where the agent
 * reached for `studio_screenshot` and waited out a capture timeout, and a
 * budget set near the median would fail on the model deciding to look at its
 * own work. **This is a ratchet against a turn that hangs, not a target.**
 *
 * Re-measure by running the spec three times and reading
 * `.tmp/agent-turn-measurement.json`, which it appends to on every run.
 */
export const AGENT_TURN_WALL_MS = 300_000

export interface GestureProfile {
  frames: number
  worstFrameMs: number
  meanFrameMs: number
  framesOver20ms: number
  /** Mutations observed INSIDE the frames layer — the React re-render signal. */
  layerMutations: number
  /** `style` writes on the transform layer — the intended rAF transform commits. */
  transformWrites: number
}

/**
 * Samples `requestAnimationFrame` intervals and DOM mutations while
 * `gesture` runs. Both observers are installed in the page, the gesture is
 * driven from the test side with real `page.mouse` input, then the sample is
 * read back and torn down.
 */
export async function profileGesture(
  page: Page,
  gesture: () => Promise<void>,
): Promise<GestureProfile> {
  await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="board-frames-layer"]')
    const transformLayer = document.querySelector('[data-testid="canvas-transform-layer"]')
    const state = {
      intervals: [] as number[],
      layerMutations: 0,
      transformWrites: 0,
      rafHandle: 0,
      last: performance.now(),
      layerObserver: null as MutationObserver | null,
      transformObserver: null as MutationObserver | null,
    }
    window.__studioPerfSample = state

    const tick = () => {
      const now = performance.now()
      state.intervals.push(now - state.last)
      state.last = now
      state.rafHandle = requestAnimationFrame(tick)
    }
    state.rafHandle = requestAnimationFrame(tick)

    if (layer) {
      state.layerObserver = new MutationObserver((records) => {
        state.layerMutations += records.length
      })
      state.layerObserver.observe(layer, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: false,
      })
    }
    if (transformLayer) {
      state.transformObserver = new MutationObserver((records) => {
        state.transformWrites += records.length
      })
      // Attributes on the transform layer ITSELF only (no subtree) — this is
      // the `style.transform` write `useCanvas.ts` makes once per rAF.
      state.transformObserver.observe(transformLayer, {
        subtree: false,
        childList: false,
        attributes: true,
        attributeFilter: ['style'],
      })
    }
  })

  await gesture()

  return page.evaluate(() => {
    const state = window.__studioPerfSample
    if (!state) throw new Error('perf sample was never installed')
    cancelAnimationFrame(state.rafHandle)
    state.layerObserver?.disconnect()
    state.transformObserver?.disconnect()
    delete window.__studioPerfSample

    // Drop the first interval: it spans the gap between installing the
    // sampler and the gesture's first input, which is idle time, not a
    // rendered frame.
    const intervals = state.intervals.slice(1)
    const total = intervals.reduce((sum, n) => sum + n, 0)
    return {
      frames: intervals.length,
      worstFrameMs: intervals.length > 0 ? Math.max(...intervals) : 0,
      meanFrameMs: intervals.length > 0 ? total / intervals.length : 0,
      framesOver20ms: intervals.filter((n) => n > 20).length,
      layerMutations: state.layerMutations,
      transformWrites: state.transformWrites,
    }
  })
}

export interface BoardCounts {
  /** Every canvas iframe in the document — a hidden live-frame bridge included. Raw cost, not a frame count. */
  liveIframes: number
  /** Board frames holding at least one canvas iframe: the frames virtualization MOUNTED. */
  mountedFrames: number
  boardFrames: number
  /** Board frames with no canvas iframe that show a poster. */
  posters: number
  /** Board frames with no canvas iframe that show a plain placeholder. */
  placeholders: number
  domNodes: number
}

/**
 * The board's frames, each classified ONCE: mounted (holds a canvas iframe),
 * else poster, else placeholder — the same precedence `readFrameStates` in
 * `studio-board-perf.e2e.ts` uses.
 *
 * Per frame, not per element, because one mounted frame is not one iframe: a
 * Tier-2 board frame (`LiveBoardFrame`) holds a hidden bridge iframe next to
 * its fallback until the live frame is ready, and that fallback is either a
 * second canvas iframe or a poster. Counting elements document-wide counted
 * such a frame twice (two iframes, or an iframe and a poster), so "every frame
 * is exactly one of mounted / poster / placeholder" could not hold on any
 * Tier-2 board.
 */
export async function readBoardCounts(page: Page): Promise<BoardCounts> {
  return page.evaluate(() => {
    const bodies = [...document.querySelectorAll('[data-testid="board-frame-body"]')]
    let mountedFrames = 0
    let posters = 0
    let placeholders = 0
    for (const body of bodies) {
      if (body.querySelector('iframe[title^="Canvas frame"]')) mountedFrames += 1
      else if (body.querySelector('[data-testid="board-frame-poster"]')) posters += 1
      else if (body.querySelector('[data-testid="board-frame-placeholder"]')) placeholders += 1
    }
    return {
      liveIframes: document.querySelectorAll('iframe[title^="Canvas frame"]').length,
      mountedFrames,
      boardFrames: bodies.length,
      posters,
      placeholders,
      domNodes: document.getElementsByTagName('*').length,
    }
  })
}

declare global {
  interface Window {
    __studioPerfSample?: {
      intervals: number[]
      layerMutations: number
      transformWrites: number
      rafHandle: number
      last: number
      layerObserver: MutationObserver | null
      transformObserver: MutationObserver | null
    }
  }
}
