/**
 * P2-I (PERF-5) — a poster rasterization (~1 s of main thread per 310-element
 * frame, measured) must not land on the frame the user is working in.
 *
 * Two defects, one test each:
 *
 * 1. `useFramePosterCapture` asked for a poster whenever an ON-SCREEN frame had
 *    none for its current `Page` object — every visible frame at load, and the
 *    edited frame after every edit (an edit makes a new `Page`). Pause 700 ms
 *    after typing and the queue rasterized the very frame being edited.
 *    `framePosterNeeded` is that decision; the e2e twin is
 *    `canvas-feel-budgets.e2e.ts`'s post-edit pause.
 * 2. `framePosterQueue` only listened for input on the editor document. A
 *    press inside a frame never reaches it (only pan-starting presses are
 *    forwarded), so a click or a resize drag in a frame looked like "quiet".
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/useFramePosterCapture.ts
 * @see src/admin/pages/site/canvas/BoardFramesLayer/framePosterQueue.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { framePosterNeeded } from '@site/canvas/BoardFramesLayer/useFramePosterCapture'
import { requestFramePoster, resetFramePosterQueue } from '@site/canvas/BoardFramesLayer/framePosterQueue'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'

describe('framePosterNeeded — when a board frame asks for a poster', () => {
  it('never rasterizes a frame that is on screen — not after an edit, not the first time', () => {
    // After an edit the cached poster is stale (a new `Page`), but the user is
    // looking at the live frame, not at a picture of it.
    expect(framePosterNeeded({ hasFreshPoster: false, isOnScreen: true, isMounted: true })).toBe(false)
  })

  it('captures once the frame has left the screen but is still pooled', () => {
    expect(framePosterNeeded({ hasFreshPoster: false, isOnScreen: false, isMounted: true })).toBe(true)
  })

  it('asks for nothing without a live iframe, or with a fresh poster', () => {
    expect(framePosterNeeded({ hasFreshPoster: false, isOnScreen: false, isMounted: false })).toBe(false)
    expect(framePosterNeeded({ hasFreshPoster: true, isOnScreen: false, isMounted: true })).toBe(false)
  })
})

/** Longer than the queue's own quiet period (700 ms), so a drained queue has drained. */
const PAST_QUIET_MS = 1_100
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('framePosterQueue — input inside a canvas frame holds the queue', () => {
  let iframe: HTMLIFrameElement

  beforeEach(() => {
    resetFramePosterQueue()
    iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
  })

  afterEach(() => {
    unregisterFrameAdapter(iframe)
    iframe.remove()
    resetFramePosterQueue()
  })

  it('a press held inside a portal frame is a gesture in progress', async () => {
    const frameDocument = iframe.contentDocument
    if (!frameDocument) throw new Error('happy-dom gave the iframe no document')
    registerFrameAdapter(iframe, new PortalFrameAdapter(frameDocument), 'studio')

    const ran: string[] = []
    requestFramePoster({}, async () => void ran.push('poster'))
    frameDocument.dispatchEvent(new Event('pointerdown'))

    await wait(PAST_QUIET_MS)
    expect(ran).toEqual([])

    frameDocument.dispatchEvent(new Event('pointerup'))
    await wait(PAST_QUIET_MS)
    expect(ran).toEqual(['poster'])
  })
})
