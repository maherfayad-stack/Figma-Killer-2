/**
 * livePresenceStore - what the live channel says about the other people on the
 * board: who is here, where their cursors and selections are, and whom this tab
 * is following.
 *
 * A small store of its own, not an editor-store slice. Presence updates arrive
 * at ~30 Hz per peer and must never wake a subscriber that only cares about the
 * page tree; the editor store's slices are all keyed on document state. This
 * store holds nothing that is saved anywhere.
 *
 * `reduceLiveMessage` is the whole protocol-to-state mapping, pure so it is
 * tested without a socket.
 */
import { create } from 'zustand'
import type {
  LiveCursor,
  LiveMember,
  LivePresenceFrame,
  LiveSelection,
  LiveServerMessage,
  LiveViewport,
} from '@core/studio-live'

export type LiveStatus = 'off' | 'connecting' | 'live' | 'reconnecting'

export interface PeerPresence {
  cursor: LiveCursor | null
  selection: LiveSelection | null
  viewport: LiveViewport | null
}

export interface LiveCoreState {
  status: LiveStatus
  epoch: string | null
  /** The project revision as of the last `welcome` / `rev` message. */
  rev: number
  selfId: string | null
  members: Record<string, LiveMember>
  presence: Record<string, PeerPresence>
  followingId: string | null
  /** How many other tabs follow this one (the server tells us). */
  followedByCount: number
}

export const INITIAL_LIVE_STATE: LiveCoreState = {
  status: 'off',
  epoch: null,
  rev: 0,
  selfId: null,
  members: {},
  presence: {},
  followingId: null,
  followedByCount: 0,
}

const EMPTY_PRESENCE: PeerPresence = { cursor: null, selection: null, viewport: null }

function mergeFrame(current: PeerPresence | undefined, frame: LivePresenceFrame): PeerPresence {
  const base = current ?? EMPTY_PRESENCE
  return {
    cursor: frame.cursor === undefined ? base.cursor : frame.cursor,
    selection: frame.selection === undefined ? base.selection : frame.selection,
    viewport: frame.viewport === undefined ? base.viewport : frame.viewport,
  }
}

export function reduceLiveMessage(state: LiveCoreState, message: LiveServerMessage): LiveCoreState {
  switch (message.t) {
    case 'welcome': {
      const members: Record<string, LiveMember> = {}
      for (const member of message.members) members[member.memberId] = member
      const presence: Record<string, PeerPresence> = {}
      for (const frame of message.presence) {
        if (frame.m !== message.you && members[frame.m]) presence[frame.m] = mergeFrame(undefined, frame)
      }
      return {
        ...state,
        status: 'live',
        epoch: message.epoch,
        rev: message.rev,
        selfId: message.you,
        members,
        presence,
        followingId: null,
        followedByCount: 0,
      }
    }
    case 'member-joined':
      return { ...state, members: { ...state.members, [message.member.memberId]: message.member } }
    case 'member-left': {
      const members = { ...state.members }
      const presence = { ...state.presence }
      delete members[message.memberId]
      delete presence[message.memberId]
      return {
        ...state,
        members,
        presence,
        followingId: state.followingId === message.memberId ? null : state.followingId,
      }
    }
    case 'presence-batch': {
      const presence = { ...state.presence }
      for (const frame of message.frames) {
        // A frame for a member we have no roster entry for is ignored: the
        // roster (member-joined) always precedes its presence.
        if (frame.m === state.selfId || !state.members[frame.m]) continue
        presence[frame.m] = mergeFrame(presence[frame.m], frame)
      }
      return { ...state, presence }
    }
    case 'followed-by':
      return { ...state, followedByCount: message.count }
    case 'rev':
      return { ...state, rev: message.rev }
    case 'error':
      return state
  }
}

interface LivePresenceStore extends LiveCoreState {
  apply: (message: LiveServerMessage) => void
  setStatus: (status: LiveStatus) => void
  setFollowing: (memberId: string | null) => void
  reset: () => void
}

export const useLivePresence = create<LivePresenceStore>()((set) => ({
  ...INITIAL_LIVE_STATE,
  apply: (message) => set((state) => reduceLiveMessage(state, message)),
  setStatus: (status) => set({ status }),
  setFollowing: (followingId) => set({ followingId }),
  reset: () => set({ ...INITIAL_LIVE_STATE }),
}))

/**
 * The selections worth drawing: a peer's selection is dropped while its `rev`
 * is behind ours, because node ids are source positions and an edit in between
 * can have moved them. The peer re-announces after it sees the new revision.
 */
export function visiblePeerSelections(
  presence: Record<string, PeerPresence>,
  ownRev: number,
): Array<{ memberId: string; selection: LiveSelection }> {
  const out: Array<{ memberId: string; selection: LiveSelection }> = []
  for (const [memberId, peer] of Object.entries(presence)) {
    if (peer.selection && peer.selection.ids.length > 0 && peer.selection.rev >= ownRev) {
      out.push({ memberId, selection: peer.selection })
    }
  }
  return out
}

/** The members to draw: everyone but this tab, one per user, in join order. */
export function distinctPeers(members: Record<string, LiveMember>, selfId: string | null): LiveMember[] {
  const self = selfId ? members[selfId] : undefined
  const seen = new Set<string>(self ? [self.userId] : [])
  const out: LiveMember[] = []
  for (const member of Object.values(members).sort((a, b) => a.joinedAt - b.joinedAt)) {
    if (member.memberId === selfId || seen.has(member.userId)) continue
    seen.add(member.userId)
    out.push(member)
  }
  return out
}
