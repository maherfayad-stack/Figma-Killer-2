/**
 * `frameTreeMountQueue.ts` — one frame's node tree at a time, closest to the
 * viewport centre first. The component-level proof that frames now commit one
 * by one is `frameTreeMountOneByOne.test.tsx`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { frameTreeMountQueueState, requestFrameTreeMount, type FrameTreeMountTicket } from '@site/canvas/frameTreeMountQueue'

/** A stand-in element: a box in a 1000 × 800 window (centre 500, 400). */
function box(left: number, top: number, width = 100, height = 100): Element {
  return {
    ownerDocument: { defaultView: { innerWidth: 1000, innerHeight: 800 } },
    getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height }),
  } as unknown as Element
}

const open: FrameTreeMountTicket[] = []
function request(element: Element | null, grants: string[], name: string): FrameTreeMountTicket {
  const ticket = requestFrameTreeMount(() => element, () => grants.push(name))
  open.push(ticket)
  return ticket
}

afterEach(() => {
  for (const ticket of open.splice(0)) ticket.release()
})

describe('frameTreeMountQueue', () => {
  it('grants the first request at once, and nothing else until it is released', () => {
    const grants: string[] = []
    const a = request(box(0, 0), grants, 'a')
    request(box(450, 350), grants, 'b')
    request(box(0, 0), grants, 'c')
    expect(grants).toEqual(['a'])
    expect(frameTreeMountQueueState()).toEqual({ waiting: 2, granted: true })
    a.release()
    expect(grants).toEqual(['a', 'b'])
  })

  it('hands the grant to the waiting frame closest to the viewport centre', () => {
    const grants: string[] = []
    const first = request(box(0, 0), grants, 'first')
    request(box(2000, 2000), grants, 'far')
    request(box(700, 300), grants, 'near')
    request(null, grants, 'detached')
    request(box(300, 250, 400, 300), grants, 'straddles-centre')
    first.release()
    expect(grants.at(-1)).toBe('straddles-centre')
    open.at(-1)!.release()
    expect(grants.at(-1)).toBe('near')
    open[2]!.release()
    expect(grants.at(-1)).toBe('far')
    open[1]!.release()
    expect(grants).toEqual(['first', 'straddles-centre', 'near', 'far', 'detached'])
  })

  it('a waiting frame that leaves is never granted, and releasing twice hands on nothing extra', () => {
    const grants: string[] = []
    const a = request(box(0, 0), grants, 'a')
    const b = request(box(0, 0), grants, 'b')
    request(box(0, 0), grants, 'c')
    b.release()
    a.release()
    a.release()
    expect(grants).toEqual(['a', 'c'])
    expect(frameTreeMountQueueState()).toEqual({ waiting: 0, granted: true })
  })
})
