import { describe, expect, it } from 'bun:test'
import {
  LIVE_COALESCE_MS,
  LIVE_COLOR_COUNT,
  LIVE_CONTROL_RATE_PER_S,
  LIVE_PRESENCE_RATE_PER_S,
  LIVE_ROOM_CAP,
  LIVE_TTL_MS,
  parseLiveServerMessage,
  type LiveServerMessage,
} from '@core/studio-live'
import { PresenceCoalescer } from '../coalescer'
import { FrameRateLimiter } from '../rateLimit'
import { LIVE_REVALIDATE_MS, ProjectRoom, type LiveConnection, type LiveIdentity } from '../room'

class FakeConn implements LiveConnection {
  sent: LiveServerMessage[] = []
  closed: { code: number; reason?: string } | null = null
  send(data: string): void {
    const message = parseLiveServerMessage(data)
    if (!message) throw new Error(`server sent an invalid frame: ${data}`)
    this.sent.push(message)
  }
  close(code: number, reason?: string): void {
    this.closed = { code, reason }
  }
  of<T extends LiveServerMessage['t']>(t: T): Array<Extract<LiveServerMessage, { t: T }>> {
    return this.sent.filter((m): m is Extract<LiveServerMessage, { t: T }> => m.t === t)
  }
}

function person(id: string, name = id): LiveIdentity {
  return { userId: id, name, avatarUrl: null, kind: 'user' }
}

function joined(room: ProjectRoom, id: string, now = 0, revalidate: (() => Promise<boolean>) | null = null) {
  const conn = new FakeConn()
  const member = room.join(person(id), conn, now, revalidate)
  if (!member) throw new Error('room refused')
  return { conn, member }
}

describe('roster', () => {
  it('welcomes a joiner with the roster and tells the others', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana')
    const b = joined(room, 'ben')
    const welcome = b.conn.of('welcome')[0]
    expect(welcome?.you).toBe(b.member.memberId)
    expect(welcome?.members.map((m) => m.name).sort()).toEqual(['ana', 'ben'])
    expect(welcome?.epoch).toBe(room.epoch)
    expect(a.conn.of('member-joined')[0]?.member.name).toBe('ben')
    expect(b.conn.of('member-joined')).toHaveLength(0)
  })

  it('announces a leave once and forgets the member', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana')
    const b = joined(room, 'ben')
    room.leave(b.member.memberId)
    room.leave(b.member.memberId)
    expect(a.conn.of('member-left')).toHaveLength(1)
    expect(room.size).toBe(1)
  })

  it('keeps one colour per user across tabs and hands out distinct ones across users', () => {
    const room = new ProjectRoom()
    const tabs = [joined(room, 'ana'), joined(room, 'ana'), joined(room, 'ben')]
    expect(tabs[0]?.member.colorIndex).toBe(tabs[1]?.member.colorIndex)
    expect(tabs[2]?.member.colorIndex).not.toBe(tabs[0]?.member.colorIndex)
    for (const t of tabs) expect(t.member.colorIndex).toBeLessThanOrEqual(LIVE_COLOR_COUNT)
  })

  it('refuses the member past the cap and keeps the others', () => {
    const room = new ProjectRoom()
    for (let i = 0; i < LIVE_ROOM_CAP; i++) joined(room, `u${i}`)
    expect(room.isFull()).toBe(true)
    expect(room.join(person('late'), new FakeConn(), 0)).toBeNull()
    expect(room.size).toBe(LIVE_ROOM_CAP)
  })

  it('shows a late joiner the cursors already on the board (but not viewports)', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana')
    room.receive(a.member.memberId, {
      t: 'presence',
      cursor: { x: 5, y: 6 },
      viewport: { x: 0, y: 0, w: 10, h: 10, zoom: 1 },
    }, 1)
    const b = joined(room, 'ben', 2)
    const frame = b.conn.of('welcome')[0]?.presence.find((f) => f.m === a.member.memberId)
    expect(frame?.cursor).toEqual({ x: 5, y: 6 })
    expect(frame?.viewport).toBeUndefined()
  })
})

describe('TTL', () => {
  it('evicts a member that went silent for more than the TTL, and only that one', () => {
    const room = new ProjectRoom()
    const quiet = joined(room, 'quiet', 0)
    const chatty = joined(room, 'chatty', 0)
    room.receive(chatty.member.memberId, { t: 'ping' }, LIVE_TTL_MS)
    room.tick(LIVE_TTL_MS + 1)
    expect(quiet.conn.closed?.code).toBe(1001)
    expect(chatty.conn.closed).toBeNull()
    expect(chatty.conn.of('member-left')[0]?.memberId).toBe(quiet.member.memberId)
    expect(room.size).toBe(1)
  })

  it('does not evict inside the TTL', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana', 0)
    room.tick(LIVE_TTL_MS)
    expect(a.conn.closed).toBeNull()
  })
})

describe('coalescing', () => {
  it('forwards only the newest cursor per member per tick, and never echoes it back', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana')
    const b = joined(room, 'ben')
    for (let i = 1; i <= 50; i++) {
      room.receive(a.member.memberId, { t: 'presence', cursor: { x: i, y: i } }, 1)
    }
    room.tick(LIVE_COALESCE_MS)
    const batches = b.conn.of('presence-batch')
    expect(batches).toHaveLength(1)
    expect(batches[0]?.frames).toEqual([{ m: a.member.memberId, cursor: { x: 50, y: 50 } }])
    expect(a.conn.of('presence-batch')).toHaveLength(0)
  })

  it('sends nothing when nothing changed, and at most one batch per interval', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana')
    const b = joined(room, 'ben')
    room.tick(LIVE_COALESCE_MS)
    expect(b.conn.of('presence-batch')).toHaveLength(0)
    room.receive(a.member.memberId, { t: 'presence', cursor: { x: 1, y: 1 } }, 1)
    room.tick(LIVE_COALESCE_MS + 1) // too soon after the last flush
    expect(b.conn.of('presence-batch')).toHaveLength(0)
    room.tick(LIVE_COALESCE_MS * 2)
    expect(b.conn.of('presence-batch')).toHaveLength(1)
  })

  it('merges fields so a selection survives a later cursor-only frame', () => {
    const coalescer = new PresenceCoalescer()
    coalescer.push('m', { selection: { ids: ['a'], pageId: 'p', rev: 1 } })
    coalescer.push('m', { cursor: { x: 1, y: 1 } })
    coalescer.push('m', { cursor: { x: 2, y: 2 } })
    expect(coalescer.drain()).toEqual([
      { m: 'm', selection: { ids: ['a'], pageId: 'p', rev: 1 }, cursor: { x: 2, y: 2 } },
    ])
    expect(coalescer.drain()).toEqual([])
  })

  it('lets a cleared cursor through (null is a value, not "unchanged")', () => {
    const coalescer = new PresenceCoalescer()
    coalescer.push('m', { cursor: { x: 1, y: 1 } })
    coalescer.push('m', { cursor: null })
    expect(coalescer.drain()).toEqual([{ m: 'm', cursor: null }])
  })

  it('drops a leaver\'s waiting frame', () => {
    const coalescer = new PresenceCoalescer()
    coalescer.push('m', { cursor: { x: 1, y: 1 } })
    coalescer.drop('m')
    expect(coalescer.drain()).toEqual([])
  })
})

describe('follow', () => {
  it('sends viewports only to the member following their owner, and counts followers', () => {
    const room = new ProjectRoom()
    const target = joined(room, 'ana')
    const follower = joined(room, 'ben')
    const bystander = joined(room, 'cy')
    room.receive(follower.member.memberId, { t: 'follow', memberId: target.member.memberId }, 1)
    expect(target.conn.of('followed-by').at(-1)?.count).toBe(1)

    const viewport = { x: 1, y: 2, w: 300, h: 200, zoom: 1 }
    room.receive(target.member.memberId, { t: 'presence', cursor: { x: 9, y: 9 }, viewport }, 2)
    room.tick(LIVE_COALESCE_MS)
    expect(follower.conn.of('presence-batch').at(-1)?.frames[0]?.viewport).toEqual(viewport)
    const seenByBystander = bystander.conn.of('presence-batch').at(-1)?.frames[0]
    expect(seenByBystander?.cursor).toEqual({ x: 9, y: 9 })
    expect(seenByBystander?.viewport).toBeUndefined()

    room.receive(follower.member.memberId, { t: 'follow', memberId: null }, 3)
    expect(target.conn.of('followed-by').at(-1)?.count).toBe(0)
  })

  it('snaps a new follower to the target\'s known viewport and ignores following yourself or a stranger', () => {
    const room = new ProjectRoom()
    const target = joined(room, 'ana')
    const follower = joined(room, 'ben')
    const viewport = { x: 1, y: 2, w: 300, h: 200, zoom: 1 }
    room.receive(target.member.memberId, { t: 'presence', viewport }, 1)
    room.receive(follower.member.memberId, { t: 'follow', memberId: target.member.memberId }, 2)
    expect(follower.conn.of('presence-batch').at(-1)?.frames[0]?.viewport).toEqual(viewport)

    const before = target.conn.of('followed-by').length
    room.receive(follower.member.memberId, { t: 'follow', memberId: follower.member.memberId }, 3)
    room.receive(follower.member.memberId, { t: 'follow', memberId: 'nobody' }, 4)
    expect(target.conn.of('followed-by').at(-1)?.count).toBe(0)
    expect(target.conn.of('followed-by').length).toBeGreaterThanOrEqual(before)
  })

  it('tells the target when a follower leaves', () => {
    const room = new ProjectRoom()
    const target = joined(room, 'ana')
    const follower = joined(room, 'ben')
    room.receive(follower.member.memberId, { t: 'follow', memberId: target.member.memberId }, 1)
    room.leave(follower.member.memberId)
    expect(target.conn.of('followed-by').at(-1)?.count).toBe(0)
  })
})

describe('revision', () => {
  it('advances monotonically and tells everyone', () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana')
    expect(room.bumpRev()).toBe(1)
    expect(room.bumpRev()).toBe(2)
    expect(a.conn.of('rev').map((m) => m.rev)).toEqual([1, 2])
    expect(joined(room, 'ben').conn.of('welcome')[0]?.rev).toBe(2)
  })
})

describe('session re-check', () => {
  it('closes a member whose session no longer grants read access', async () => {
    const room = new ProjectRoom()
    const demoted = joined(room, 'ana', 0, async () => false)
    const fine = joined(room, 'ben', 0, async () => true)
    // Both are alive (heartbeating); only the session check can remove one.
    room.receive(demoted.member.memberId, { t: 'ping' }, LIVE_REVALIDATE_MS)
    room.receive(fine.member.memberId, { t: 'ping' }, LIVE_REVALIDATE_MS)
    room.tick(LIVE_REVALIDATE_MS)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(demoted.conn.closed?.code).toBe(1008)
    expect(fine.conn.closed).toBeNull()
    expect(room.size).toBe(1)
  })

  it('keeps everyone when the auth lookup itself fails', async () => {
    const room = new ProjectRoom()
    const a = joined(room, 'ana', 0, async () => {
      throw new Error('db down')
    })
    room.receive(a.member.memberId, { t: 'ping' }, LIVE_REVALIDATE_MS)
    const original = console.error
    console.error = () => {}
    try {
      room.tick(LIVE_REVALIDATE_MS)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      console.error = original
    }
    expect(a.conn.closed).toBeNull()
  })
})

describe('rate limit', () => {
  it('allows a spec-compliant client and refuses the frame over budget', () => {
    const limiter = new FrameRateLimiter()
    for (let i = 0; i < LIVE_PRESENCE_RATE_PER_S; i++) expect(limiter.allow('presence', 100)).toBe(true)
    expect(limiter.allow('presence', 100)).toBe(false)
    for (let i = 0; i < LIVE_CONTROL_RATE_PER_S; i++) expect(limiter.allow('control', 100)).toBe(true)
    expect(limiter.allow('control', 100)).toBe(false)
  })

  it('opens a fresh budget each second', () => {
    const limiter = new FrameRateLimiter()
    for (let i = 0; i <= LIVE_PRESENCE_RATE_PER_S; i++) limiter.allow('presence', 0)
    expect(limiter.allow('presence', 1_000)).toBe(true)
  })
})
