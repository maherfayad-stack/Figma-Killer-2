/**
 * Two decisions, one test each:
 *
 * 1. `framePosterNeeded` (SB-2) — a picture is taken while the frame is live
 *    and settled, whenever the store has none for its content key. P2-I used
 *    to forbid that (a rasterization cost ~1 s of main thread); the SVG
 *    rasterizer made it cheap, and the queue still never runs it under the
 *    user's hands.
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
  it('asks while the frame is live, its content has committed and no picture exists for its key', () => {
    expect(framePosterNeeded({ hasPoster: false, isMounted: true, isContentReady: true })).toBe(true)
  })

  it('does not photograph a mid-mount (empty) document', () => {
    expect(framePosterNeeded({ hasPoster: false, isMounted: true, isContentReady: false })).toBe(false)
  })

  it('asks for nothing without a live iframe, or when the store already has the picture', () => {
    expect(framePosterNeeded({ hasPoster: false, isMounted: false, isContentReady: true })).toBe(false)
    expect(framePosterNeeded({ hasPoster: true, isMounted: true, isContentReady: true })).toBe(false)
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

  it('stops listening to frames once nothing is pending (no standing registry subscriber)', async () => {
    requestFramePoster({}, async () => {})
    await wait(PAST_QUIET_MS)
    // The queue drained, so a frame registering now must not reach it — a
    // registry listener that outlives its purpose runs for every frame of
    // every later board (and for every test file after this one).
    const other = document.createElement('iframe')
    document.body.appendChild(other)
    let reached = false
    const probe = { on: () => { reached = true; return () => {} } } as unknown as PortalFrameAdapter
    registerFrameAdapter(other, probe, 'studio')
    unregisterFrameAdapter(other)
    other.remove()
    expect(reached).toBe(false)
  })
})
