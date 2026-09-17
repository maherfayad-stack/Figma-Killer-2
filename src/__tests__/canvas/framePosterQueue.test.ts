/**
 * framePosterQueue.ts — the two properties the measurement bought (S1).
 *
 * 1. Nothing rasterizes while the board is still busy. A poster capture was
 *    measured at ~350 ms on an 18-frame board; running one inside a pan or a
 *    zoom is a visibly dropped gesture for a picture nobody is looking at yet.
 * 2. Captures run one at a time, so two can never share an animation frame.
 *
 * @see src/admin/pages/site/canvas/BoardFramesLayer/framePosterQueue.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'bun:test'
import {
  cancelFramePoster,
  requestFramePoster,
  resetFramePosterQueue,
} from '@site/canvas/BoardFramesLayer/framePosterQueue'

/** Longer than the queue's own quiet period, so a drained queue has drained. */
const PAST_QUIET_MS = 1_400

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The queue is module state shared with any other file that renders a board
// frame, and `bun test` runs every file in one process — so reset on BOTH
// sides, or a stray request from a neighbouring suite drains into this one.
beforeEach(() => resetFramePosterQueue())
afterEach(() => resetFramePosterQueue())

describe('framePosterQueue', () => {
  it('does not capture while requests are still arriving', async () => {
    const ran: string[] = []
    requestFramePoster({}, async () => void ran.push('a'))
    await wait(300)
    requestFramePoster({}, async () => void ran.push('b'))
    await wait(300)
    requestFramePoster({}, async () => void ran.push('c'))
    // Well past the per-request delay, but the burst never went quiet.
    expect(ran).toEqual([])

    await wait(PAST_QUIET_MS)
    expect(ran.sort()).toEqual(['a', 'b', 'c'])
  })

  it('runs captures one at a time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const capture = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await wait(20)
      inFlight -= 1
    }
    requestFramePoster({}, capture)
    requestFramePoster({}, capture)
    requestFramePoster({}, capture)

    await wait(PAST_QUIET_MS + 300)
    expect(maxInFlight).toBe(1)
  })

  it('withdraws a request whose frame left before its turn came', async () => {
    const ran: string[] = []
    const leaving = {}
    requestFramePoster(leaving, async () => void ran.push('left'))
    requestFramePoster({}, async () => void ran.push('stayed'))
    cancelFramePoster(leaving)

    await wait(PAST_QUIET_MS)
    expect(ran).toEqual(['stayed'])
  })

  it('replaces its own earlier request from the same frame rather than queueing twice', async () => {
    const ran: string[] = []
    const token = {}
    requestFramePoster(token, async () => void ran.push('stale'))
    requestFramePoster(token, async () => void ran.push('fresh'))

    await wait(PAST_QUIET_MS)
    expect(ran).toEqual(['fresh'])
  })
})
