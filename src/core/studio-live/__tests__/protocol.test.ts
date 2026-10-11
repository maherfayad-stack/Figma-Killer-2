import { describe, expect, it } from 'bun:test'
import {
  LIVE_COLOR_COUNT,
  LIVE_MAX_SELECTION_IDS,
  encodeLiveMessage,
  liveColorVar,
  parseLiveClientMessage,
  parseLiveServerMessage,
  pickColorIndex,
  transformToFollow,
  visibleBoardRect,
} from '..'

const member = {
  memberId: 'm1',
  userId: 'u1',
  name: 'Alex',
  avatarUrl: null,
  colorIndex: 3,
  kind: 'user',
  joinedAt: 1,
}

describe('client frames', () => {
  it('accepts each frame kind', () => {
    for (const frame of [
      { t: 'hello' },
      { t: 'ping' },
      { t: 'follow', memberId: 'm2' },
      { t: 'follow', memberId: null },
      { t: 'presence' },
      { t: 'presence', cursor: { x: 1.5, y: -20 } },
      { t: 'presence', cursor: null, selection: { ids: ['a:1:2'], pageId: 'home', rev: 4 } },
      { t: 'presence', viewport: { x: 0, y: 0, w: 1200, h: 800, zoom: 0.5 } },
    ]) {
      expect(parseLiveClientMessage(JSON.stringify(frame))).not.toBeNull()
    }
  })

  it('refuses anything else', () => {
    const refused: unknown[] = [
      { t: 'edit', file: 'pages/Home.tsx' },
      { t: 'presence', cursor: { x: Number.NaN, y: 0 } },
      { t: 'presence', cursor: { x: 9e9, y: 0 } },
      { t: 'presence', cursor: { x: 0, y: 0, z: 1 } },
      { t: 'presence', extra: true },
      { t: 'presence', selection: { ids: [''], pageId: null, rev: 0 } },
      { t: 'presence', selection: { ids: ['a'], pageId: null, rev: -1 } },
      { t: 'presence', selection: { ids: Array.from({ length: LIVE_MAX_SELECTION_IDS + 1 }, (_, i) => `n${i}`), pageId: null, rev: 0 } },
      { t: 'presence', viewport: { x: 0, y: 0, w: 0, h: 10, zoom: 1 } },
      { t: 'follow' },
      { t: 'follow', memberId: '' },
      { t: 'welcome' },
      null,
      'hello',
      [],
    ]
    for (const frame of refused) expect(parseLiveClientMessage(JSON.stringify(frame))).toBeNull()
  })

  it('never throws on junk and refuses non-JSON', () => {
    for (const raw of ['', '{', 'null', '123', '{"t":', '\u0000', '{"t":"presence","cursor":{"x":"1","y":2}}']) {
      expect(parseLiveClientMessage(raw)).toBeNull()
    }
    // Light fuzz: random key/value soup is refused or accepted, never thrown.
    const values = [null, 0, -1, 'x', [], {}, { x: 1, y: 2 }, true]
    const keys = ['t', 'cursor', 'selection', 'viewport', 'memberId', 'ids']
    let seed = 7
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 500; i++) {
      const frame: Record<string, unknown> = {}
      for (const key of keys) if (rand() > 0.5) frame[key] = values[Math.floor(rand() * values.length)]
      expect(() => parseLiveClientMessage(JSON.stringify(frame))).not.toThrow()
    }
  })
})

describe('server frames', () => {
  it('round-trips welcome and batches', () => {
    const welcome = {
      t: 'welcome',
      epoch: 'e',
      rev: 2,
      you: 'm1',
      members: [member],
      presence: [{ m: 'm1', cursor: { x: 1, y: 2 } }],
    } as const
    expect(parseLiveServerMessage(encodeLiveMessage(welcome))).toEqual(welcome)
    const batch = { t: 'presence-batch', frames: [{ m: 'm1', cursor: null }] } as const
    expect(parseLiveServerMessage(encodeLiveMessage(batch))).toEqual(batch)
  })

  it('refuses a member with an out-of-range colour', () => {
    const bad = { t: 'member-joined', member: { ...member, colorIndex: LIVE_COLOR_COUNT + 1 } }
    expect(parseLiveServerMessage(JSON.stringify(bad))).toBeNull()
  })
})

describe('colours', () => {
  it('maps an index to an accent token and clamps', () => {
    expect(liveColorVar(1)).toBe('var(--accent-1)')
    expect(liveColorVar(99)).toBe('var(--accent-10)')
    expect(liveColorVar(-4)).toBe('var(--accent-1)')
  })

  it('gives the first ten members ten different colours, then the least used', () => {
    const used: number[] = []
    for (let i = 0; i < LIVE_COLOR_COUNT; i++) used.push(pickColorIndex(used))
    expect(new Set(used).size).toBe(LIVE_COLOR_COUNT)
    expect(pickColorIndex(used)).toBe(1)
  })
})

describe('follow maths', () => {
  const geometry = { rootWidth: 1000, rootHeight: 600, offsetX: 80, offsetY: 80 }

  it('frames the target rectangle, centred', () => {
    const target = { x: 100, y: 200, w: 500, h: 300, zoom: 2 }
    const next = transformToFollow(target, geometry, (z) => z)
    expect(next).not.toBeNull()
    const seen = visibleBoardRect(geometry, next!)
    // The followed rectangle's centre is the follower's centre.
    expect(seen.x + seen.w / 2).toBeCloseTo(350)
    expect(seen.y + seen.h / 2).toBeCloseTo(350)
    // And the whole target fits.
    expect(seen.w).toBeGreaterThanOrEqual(500 - 1e-6)
    expect(seen.h).toBeGreaterThanOrEqual(300 - 1e-6)
  })

  it('applies the editor zoom clamp and refuses an unsized viewport', () => {
    const target = { x: 0, y: 0, w: 10, h: 10, zoom: 1 }
    expect(transformToFollow(target, geometry, () => 4)?.zoom).toBe(4)
    expect(transformToFollow(target, { ...geometry, rootWidth: 0 }, (z) => z)).toBeNull()
  })
})
