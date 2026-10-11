/**
 * pressRing — the press queue: what a press owes the store runs after the press
 * has been painted, in order, once — and never later than the gesture needs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { afterPressPaint, flushPressQueue } from '@site/canvas/pressRing'

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let timers: Array<{ id: number; ms: number; run: () => void }>
let nextId: number

interface FakeWindow {
  win: Window
  frames: Array<() => void>
  listeners: Map<string, () => void>
}

function fakeWindow(): FakeWindow {
  const frames: Array<() => void> = []
  const listeners = new Map<string, () => void>()
  const win = {
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Window
  return { win, frames, listeners }
}

beforeEach(() => {
  timers = []
  nextId = 1
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    const id = nextId
    nextId += 1
    timers.push({ id, ms, run })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id)
  }) as unknown as typeof clearTimeout
})

afterEach(() => {
  flushPressQueue()
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

/** Fire the timer with the smallest delay, as a browser would. */
function fireNextTimer(): void {
  const next = [...timers].sort((a, b) => a.ms - b.ms)[0]
  if (!next) throw new Error('no timer pending')
  timers = timers.filter((timer) => timer.id !== next.id)
  next.run()
}

describe('afterPressPaint', () => {
  it('runs nothing in the press task, then everything queued, in order, in one task after a frame', () => {
    const { win, frames } = fakeWindow()
    const ran: string[] = []
    afterPressPaint(win, () => ran.push('activate page'))
    afterPressPaint(win, () => ran.push('select'))
    expect(ran).toEqual([])

    frames.shift()!() // the frame runs: the ring is painted with it
    expect(ran).toEqual([])
    fireNextTimer() // the task after it
    expect(ran).toEqual(['activate page', 'select'])
  })

  it('runs at once when the gesture moves on: a release, a context menu, a key', () => {
    for (const type of ['pointerup', 'contextmenu', 'keydown', 'dblclick']) {
      const { win, listeners } = fakeWindow()
      const ran: string[] = []
      afterPressPaint(win, () => ran.push(type))
      listeners.get(type)!()
      expect(ran).toEqual([type])
    }
  })

  it('runs on a short timer where no frame ever comes (a backgrounded tab)', () => {
    const { win } = fakeWindow() // its requestAnimationFrame never calls back
    const ran: string[] = []
    afterPressPaint(win, () => ran.push('select'))
    fireNextTimer()
    expect(ran).toEqual(['select'])
  })

  it('an explicit flush (a press that became a drag) runs the queue once and stops waiting', () => {
    const { win, frames } = fakeWindow()
    const ran: string[] = []
    afterPressPaint(win, () => ran.push('select'))
    flushPressQueue()
    expect(ran).toEqual(['select'])
    // Whatever frame or timer was already on its way finds nothing left to run.
    frames.shift()?.()
    while (timers.length > 0) fireNextTimer()
    expect(ran).toEqual(['select'])
  })

  it('a press on another frame ends the previous frame’s wait first, rather than queueing behind a dead window', () => {
    const first = fakeWindow()
    const second = fakeWindow()
    const ran: string[] = []
    afterPressPaint(first.win, () => ran.push('first'))
    afterPressPaint(second.win, () => ran.push('second'))
    expect(ran).toEqual(['first'])
    second.frames.shift()!()
    fireNextTimer()
    expect(ran).toEqual(['first', 'second'])
    expect(timers.filter((timer) => timer.ms === 0)).toEqual([])
  })
})
