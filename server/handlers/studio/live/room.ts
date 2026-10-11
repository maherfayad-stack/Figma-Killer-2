/**
 * ProjectRoom — the in-memory roster and presence state of one project.
 *
 * Nothing here is persisted and nothing here writes: a room is keyed by the
 * project's real path (the same key the write lock uses), holds who is looking
 * at the board and where their cursors are, and forwards that. Edits never
 * pass through it. Importing a writeback or codemod module from this folder is
 * a bug (`studio-live-no-writes.test.ts`).
 *
 * The room is transport-agnostic — it speaks to a {@link LiveConnection} — so
 * the roster, TTL and coalescing rules are unit-tested without a socket.
 *
 * Time is passed in (`tick(now)`), never read, for the same reason.
 */
import {
  LIVE_COALESCE_MS,
  LIVE_ROOM_CAP,
  LIVE_TTL_MS,
  encodeLiveMessage,
  pickColorIndex,
  type LiveClientMessage,
  type LiveMember,
  type LivePresenceFields,
  type LivePresenceFrame,
  type LiveServerMessage,
} from '@core/studio-live'
import { PresenceCoalescer } from './coalescer'

/** What the room needs from a socket. */
export interface LiveConnection {
  send(data: string): void
  close(code: number, reason?: string): void
}

export interface LiveIdentity {
  userId: string
  name: string
  avatarUrl: string | null
  kind: LiveMember['kind']
}

/** How often a member's session is re-checked against the auth store. */
export const LIVE_REVALIDATE_MS = 30_000

interface MemberState {
  member: LiveMember
  conn: LiveConnection
  lastSeenMs: number
  /** Last known cursor/selection/viewport, for a joiner's `welcome`. */
  presence: LivePresenceFields
  followingId: string | null
  /** Resolves `false` once this member's session no longer grants `site.read`. */
  revalidate: (() => Promise<boolean>) | null
}

export class ProjectRoom {
  /** Random per server start: a client that sees it change must resync. */
  readonly epoch = crypto.randomUUID()
  private revision = 0
  private readonly members = new Map<string, MemberState>()
  private readonly coalescer = new PresenceCoalescer()
  private lastFlushMs = 0
  private lastRevalidateMs = 0

  get rev(): number {
    return this.revision
  }

  get size(): number {
    return this.members.size
  }

  isFull(): boolean {
    return this.members.size >= LIVE_ROOM_CAP
  }

  /**
   * Admits a member and sends it `welcome`. `null` when the room is full (the
   * caller closes the socket); the cap is provisional, owner to confirm.
   */
  join(
    identity: LiveIdentity,
    conn: LiveConnection,
    nowMs: number,
    revalidate: (() => Promise<boolean>) | null = null,
  ): LiveMember | null {
    if (this.isFull()) return null
    const memberId = crypto.randomUUID()
    const sameUser = [...this.members.values()].find((s) => s.member.userId === identity.userId)
    // One colour per USER per room, so two tabs of one person look like one.
    const colorIndex = sameUser
      ? sameUser.member.colorIndex
      : pickColorIndex(this.distinctUserColors())
    const member: LiveMember = {
      memberId,
      userId: identity.userId,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      colorIndex,
      kind: identity.kind,
      joinedAt: nowMs,
    }
    const presence: LivePresenceFrame[] = []
    for (const [id, state] of this.members) {
      const { cursor, selection } = state.presence
      presence.push({ m: id, ...(cursor ? { cursor } : {}), ...(selection ? { selection } : {}) })
    }
    this.members.set(memberId, {
      member,
      conn,
      lastSeenMs: nowMs,
      presence: {},
      followingId: null,
      revalidate,
    })
    this.sendTo(conn, {
      t: 'welcome',
      epoch: this.epoch,
      rev: this.revision,
      you: memberId,
      members: [...this.members.values()].map((s) => s.member),
      presence,
    })
    this.broadcast({ t: 'member-joined', member }, memberId)
    return member
  }

  /** A member's socket closed or timed out. Idempotent. */
  leave(memberId: string): void {
    const state = this.members.get(memberId)
    if (!state) return
    this.members.delete(memberId)
    this.coalescer.drop(memberId)
    for (const other of this.members.values()) {
      if (other.followingId === memberId) other.followingId = null
    }
    this.broadcast({ t: 'member-left', memberId })
    if (state.followingId) this.announceFollowers(state.followingId)
  }

  /** Applies one validated client frame. Any frame counts as proof of life. */
  receive(memberId: string, message: LiveClientMessage, nowMs: number): void {
    const state = this.members.get(memberId)
    if (!state) return
    state.lastSeenMs = nowMs
    switch (message.t) {
      case 'presence': {
        const { cursor, selection, viewport } = message
        const fields: LivePresenceFields = {}
        if (cursor !== undefined) fields.cursor = cursor
        if (selection !== undefined) fields.selection = selection
        if (viewport !== undefined) fields.viewport = viewport
        if (cursor !== undefined) state.presence.cursor = cursor
        if (selection !== undefined) state.presence.selection = selection
        if (viewport !== undefined) state.presence.viewport = viewport
        this.coalescer.push(memberId, fields)
        return
      }
      case 'follow':
        this.setFollowing(memberId, state, message.memberId)
        return
      case 'hello':
      case 'ping':
        return
    }
  }

  /** Advances the revision (called when a write session ends) and tells everyone. */
  bumpRev(): number {
    this.revision += 1
    this.broadcast({ t: 'rev', rev: this.revision })
    return this.revision
  }

  /**
   * Drives the room's clock: flushes coalesced presence at most once per
   * `LIVE_COALESCE_MS`, evicts members silent past the TTL and re-checks
   * sessions. An evicted member's socket is closed here.
   */
  tick(nowMs: number): void {
    if (nowMs - this.lastFlushMs >= LIVE_COALESCE_MS) {
      this.lastFlushMs = nowMs
      this.flush()
    }
    for (const [id, state] of [...this.members]) {
      if (nowMs - state.lastSeenMs > LIVE_TTL_MS) {
        state.conn.close(1001, 'presence timeout')
        this.leave(id)
      }
    }
    if (nowMs - this.lastRevalidateMs >= LIVE_REVALIDATE_MS) {
      this.lastRevalidateMs = nowMs
      void this.revalidateAll()
    }
  }

  /** Sends the coalesced frames: each recipient gets everyone's but its own. */
  flush(): void {
    const frames = this.coalescer.drain()
    if (frames.length === 0) return
    for (const [recipientId, recipient] of this.members) {
      const visible: LivePresenceFrame[] = []
      for (const frame of frames) {
        if (frame.m === recipientId) continue
        // A viewport is only worth sending to somebody following its owner.
        if (frame.viewport !== undefined && recipient.followingId !== frame.m) {
          const rest: LivePresenceFrame = { m: frame.m }
          if (frame.cursor !== undefined) rest.cursor = frame.cursor
          if (frame.selection !== undefined) rest.selection = frame.selection
          if (Object.keys(rest).length > 1) visible.push(rest)
        } else {
          visible.push(frame)
        }
      }
      if (visible.length > 0) this.sendTo(recipient.conn, { t: 'presence-batch', frames: visible })
    }
  }

  private async revalidateAll(): Promise<void> {
    for (const [id, state] of [...this.members]) {
      if (!state.revalidate) continue
      const still = await state.revalidate().catch((err: unknown) => {
        console.error('[studio-live] session revalidation failed:', err)
        return true // an auth-store hiccup must not eject everyone; the next sweep retries
      })
      if (!still && this.members.get(id) === state) {
        state.conn.close(1008, 'session no longer permitted')
        this.leave(id)
      }
    }
  }

  private setFollowing(memberId: string, state: MemberState, targetId: string | null): void {
    const previous = state.followingId
    const target = targetId && targetId !== memberId ? this.members.get(targetId) : undefined
    state.followingId = target ? targetId : null
    if (previous && previous !== state.followingId) this.announceFollowers(previous)
    if (state.followingId && target) {
      this.announceFollowers(state.followingId)
      // Snap the follower to where the target already is.
      const { viewport, cursor } = target.presence
      if (viewport) {
        this.sendTo(state.conn, {
          t: 'presence-batch',
          frames: [{ m: state.followingId, viewport, ...(cursor ? { cursor } : {}) }],
        })
      }
    }
  }

  private announceFollowers(targetId: string): void {
    const target = this.members.get(targetId)
    if (!target) return
    let count = 0
    for (const state of this.members.values()) if (state.followingId === targetId) count += 1
    this.sendTo(target.conn, { t: 'followed-by', count })
  }

  private distinctUserColors(): number[] {
    const byUser = new Map<string, number>()
    for (const state of this.members.values()) byUser.set(state.member.userId, state.member.colorIndex)
    return [...byUser.values()]
  }

  private broadcast(message: LiveServerMessage, exceptMemberId?: string): void {
    const raw = encodeLiveMessage(message)
    for (const [id, state] of this.members) {
      if (id === exceptMemberId) continue
      this.trySend(state.conn, raw)
    }
  }

  private sendTo(conn: LiveConnection, message: LiveServerMessage): void {
    this.trySend(conn, encodeLiveMessage(message))
  }

  private trySend(conn: LiveConnection, raw: string): void {
    try {
      conn.send(raw)
    } catch (err) {
      // A socket that throws on send is closing; its own close handler removes it.
      console.error('[studio-live] send failed:', err)
    }
  }
}
