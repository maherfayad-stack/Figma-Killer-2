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
 * Extracted from `studio-board-perf.e2e.ts` (`perf-01`), which remains the
 * owner of the BUDGETS. Nothing here asserts; it only measures.
 */
import type { Page } from '@playwright/test'

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
