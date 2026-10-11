import { describe, expect, it } from 'bun:test'
import type { LiveMember, LiveServerMessage } from '@core/studio-live'
import {
  INITIAL_LIVE_STATE,
  distinctPeers,
  reduceLiveMessage,
  visiblePeerSelections,
  type LiveCoreState,
} from '../livePresenceStore'

function member(id: string, userId = id, joinedAt = 1): LiveMember {
  return { memberId: id, userId, name: id, avatarUrl: null, colorIndex: 1, kind: 'user', joinedAt }
}

function run(messages: LiveServerMessage[], from: LiveCoreState = INITIAL_LIVE_STATE): LiveCoreState {
  return messages.reduce(reduceLiveMessage, from)
}

const welcome: LiveServerMessage = {
  t: 'welcome',
  epoch: 'e1',
  rev: 3,
  you: 'me',
  members: [member('me'), member('ana')],
  presence: [{ m: 'ana', cursor: { x: 1, y: 2 } }],
}

describe('reduceLiveMessage', () => {
  it('welcome sets the roster, the revision and goes live', () => {
    const state = run([welcome])
    expect(state.status).toBe('live')
    expect(state.selfId).toBe('me')
    expect(state.rev).toBe(3)
    expect(Object.keys(state.members).sort()).toEqual(['ana', 'me'])
    expect(state.presence.ana?.cursor).toEqual({ x: 1, y: 2 })
    expect(state.presence.me).toBeUndefined()
  })

  it('a second welcome (reconnect, new epoch) replaces the old roster instead of merging', () => {
    const state = run([
      welcome,
      { t: 'member-joined', member: member('bob') },
      { ...welcome, epoch: 'e2', members: [member('me2'), member('cy')], you: 'me2', presence: [] },
    ])
    expect(Object.keys(state.members).sort()).toEqual(['cy', 'me2'])
    expect(state.epoch).toBe('e2')
    expect(state.followingId).toBeNull()
  })

  it('merges presence frames field by field and treats null as a clear', () => {
    const state = run([
      welcome,
      { t: 'presence-batch', frames: [{ m: 'ana', selection: { ids: ['n'], pageId: 'p', rev: 3 } }] },
      { t: 'presence-batch', frames: [{ m: 'ana', cursor: { x: 9, y: 9 } }] },
    ])
    expect(state.presence.ana?.cursor).toEqual({ x: 9, y: 9 })
    expect(state.presence.ana?.selection?.ids).toEqual(['n'])
    const cleared = run([{ t: 'presence-batch', frames: [{ m: 'ana', cursor: null }] }], state)
    expect(cleared.presence.ana?.cursor).toBeNull()
    expect(cleared.presence.ana?.selection?.ids).toEqual(['n'])
  })

  it('ignores presence for someone not on the roster and for ourselves', () => {
    const state = run([
      welcome,
      { t: 'presence-batch', frames: [{ m: 'ghost', cursor: { x: 1, y: 1 } }, { m: 'me', cursor: { x: 2, y: 2 } }] },
    ])
    expect(state.presence.ghost).toBeUndefined()
    expect(state.presence.me).toBeUndefined()
  })

  it('a leaver takes their cursor with them and ends following them', () => {
    const state = run([welcome], { ...INITIAL_LIVE_STATE })
    const following = run([{ t: 'member-left', memberId: 'ana' }], { ...state, followingId: 'ana' })
    expect(following.members.ana).toBeUndefined()
    expect(following.presence.ana).toBeUndefined()
    expect(following.followingId).toBeNull()
  })

  it('tracks the revision and the follower count', () => {
    const state = run([welcome, { t: 'rev', rev: 4 }, { t: 'followed-by', count: 2 }])
    expect(state.rev).toBe(4)
    expect(state.followedByCount).toBe(2)
  })
})

describe('visiblePeerSelections', () => {
  it('hides a selection stamped with an older revision than ours', () => {
    const presence = {
      fresh: { cursor: null, viewport: null, selection: { ids: ['a'], pageId: 'p', rev: 5 } },
      stale: { cursor: null, viewport: null, selection: { ids: ['b'], pageId: 'p', rev: 4 } },
      empty: { cursor: null, viewport: null, selection: { ids: [], pageId: 'p', rev: 9 } },
      none: { cursor: null, viewport: null, selection: null },
    }
    expect(visiblePeerSelections(presence, 5).map((s) => s.memberId)).toEqual(['fresh'])
    expect(visiblePeerSelections(presence, 4).map((s) => s.memberId).sort()).toEqual(['fresh', 'stale'])
  })
})

describe('distinctPeers', () => {
  it('lists others once per person, in join order, never ourselves', () => {
    const members = {
      me: member('me', 'u-me', 1),
      meTab2: member('meTab2', 'u-me', 2),
      ana: member('ana', 'u-ana', 3),
      anaTab2: member('anaTab2', 'u-ana', 4),
      bob: member('bob', 'u-bob', 5),
    }
    expect(distinctPeers(members, 'me').map((m) => m.memberId)).toEqual(['ana', 'bob'])
  })
})
