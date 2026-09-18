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
  liveIframes: number
  boardFrames: number
  posters: number
  placeholders: number
  domNodes: number
}

/** Live (mounted) canvas iframes, board frames on the board, and rendered posters. */
export async function readBoardCounts(page: Page): Promise<BoardCounts> {
  return page.evaluate(() => ({
    liveIframes: document.querySelectorAll('iframe[title^="Canvas frame"]').length,
    boardFrames: document.querySelectorAll('[data-testid="board-frame-body"]').length,
    posters: document.querySelectorAll('[data-testid="board-frame-poster"]').length,
    placeholders: document.querySelectorAll('[data-testid="board-frame-placeholder"]').length,
    domNodes: document.getElementsByTagName('*').length,
  }))
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
