/**
 * startCanvasFraming — giving up is settling, so a later selection never
 * frames the board.
 *
 * The reported bug: on the first selection on a board that was slow to open
 * (test4, a cold open), every frame jumped ~300 px. The board's framing retried
 * for ~3 s, found no laid-out frames, and gave up WITHOUT recording the key —
 * so the next run of the effect, which is the user's first click on another
 * frame (it activates that page, so `canvasPageId` changes), framed the board
 * then. Nothing moves that the user did not move.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { startCanvasFraming } from '@site/canvas/canvasFocusTarget'

// A hand-driven clock: the retry timer is the thing under test, and 200
// retries at 16ms is not something to wait out.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let queue: Array<{ id: number; run: () => void }>
let nextId: number

beforeEach(() => {
  queue = []
  nextId = 1
  globalThis.setTimeout = ((run: () => void) => {
    const id = nextId
    nextId += 1
    queue.push({ id, run })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    queue = queue.filter((entry) => entry.id !== id)
  }) as unknown as typeof clearTimeout
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

/** Run timers until none are pending. Returns how many fired. */
function drain(): number {
  let fired = 0
  while (queue.length > 0) {
    queue.shift()!.run()
    fired += 1
  }
  return fired
}

describe('startCanvasFraming', () => {
  it('settles when the frames finally exist', () => {
    let laidOut = false
    let settled = 0
    startCanvasFraming({ center: () => laidOut, readView: () => '1:0:0', settle: () => { settled += 1 } })
    expect(settled).toBe(0)
    laidOut = true
    drain()
    expect(settled).toBe(1)
  })

  it('settles when it gives up on a board whose frames never lay out (the cold-open jump)', () => {
    let settled = 0
    startCanvasFraming({ center: () => false, readView: () => '1:0:0', settle: () => { settled += 1 } })
    // 200 retries, then it stops. Before this settled, the key stayed
    // unrecorded and the user's first click on another frame framed the board.
    expect(drain()).toBe(200)
    expect(settled).toBe(1)
  })

  it('stands down for good when the user moved the view while it waited', () => {
    let view = '1:0:0'
    let centered = 0
    let settled = 0
    startCanvasFraming({
      center: () => {
        centered += 1
        return false
      },
      readView: () => view,
      settle: () => { settled += 1 },
    })
    expect(centered).toBe(1)
    view = '0.5:-200:40' // a pan / zoom the user made
    drain()
    expect(centered).toBe(1) // never framed over their view
    expect(settled).toBe(1)
  })

  it('the cleanup cancels a pending retry', () => {
    let centered = 0
    const cancel = startCanvasFraming({
      center: () => {
        centered += 1
        return false
      },
      readView: () => '1:0:0',
      settle: () => {},
    })
    cancel()
    drain()
    expect(centered).toBe(1)
  })
})
