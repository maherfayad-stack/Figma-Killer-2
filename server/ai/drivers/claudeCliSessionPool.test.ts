/**
 * The warm-session registry: who gets reused, who gets respawned, and what is
 * guaranteed to be torn down. No process is ever started here — the pool only
 * ever reads `alive`/`busy` and calls `dispose`, so a fake session is a
 * complete stand-in for a real one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  acquireWarmSession,
  disposeAllWarmSessions,
  disposeWarmSessionsForConversation,
  warmSessionCount,
  type WarmSessionResources,
} from './claudeCliSessionPool'
import type { ClaudeCliWarmSession } from './claudeCliWarmSession'

class FakeSession {
  alive = true
  busy = false
  disposed = 0
}

function resourcesFor(fake: FakeSession, connectorId: string | null = 'connector-1'): WarmSessionResources {
  return {
    session: fake as unknown as ClaudeCliWarmSession,
    connectorId,
    dispose: async () => {
      fake.disposed += 1
      fake.alive = false
    },
  }
}

/**
 * The account every acquire below belongs to unless it says otherwise. The
 * pool is keyed by (user, conversation) since W10, so a test that means "the
 * same session" has to mean the same user too.
 */
const USER = 'user-1'

/** Acquire, recording how many times a new session had to be created. */
function acquirer(sessions: FakeSession[]) {
  let created = 0
  return {
    get created() {
      return created
    },
    acquire: (conversationId: string, fingerprint: string, userId: string = USER) =>
      acquireWarmSession({
        userId,
        conversationId,
        fingerprint,
        create: async () => {
          const fake = new FakeSession()
          sessions.push(fake)
          created += 1
          return resourcesFor(fake)
        },
      }),
  }
}

afterEach(async () => {
  await disposeAllWarmSessions()
})

describe('reuse', () => {
  it('reuses one process across turns with the same fingerprint', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const first = await pool.acquire('conv-1', 'fp-a')
    expect(first.spawnedNow).toBe(true)
    first.endTurn()

    const second = await pool.acquire('conv-1', 'fp-a')
    expect(second.spawnedNow).toBe(false)
    expect(second.session).toBe(first.session)
    second.endTurn()

    expect(pool.created).toBe(1)
    expect(warmSessionCount()).toBe(1)
  })

  it('surfaces the connector id so each turn can re-bind its registries', async () => {
    const pool = acquirer([])
    const lease = await pool.acquire('conv-1', 'fp-a')
    expect(lease.connectorId).toBe('connector-1')
    lease.endTurn()
  })

  it('keeps conversations apart', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)
    const a = await pool.acquire('conv-1', 'fp-a')
    a.endTurn()
    const b = await pool.acquire('conv-2', 'fp-a')
    b.endTurn()
    expect(a.session).not.toBe(b.session)
    expect(warmSessionCount()).toBe(2)
  })
})

describe('respawn', () => {
  it('kills and replaces the process when the fingerprint changes (model, effort, permission mode…)', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const first = await pool.acquire('conv-1', 'fp-a')
    first.endTurn()
    const second = await pool.acquire('conv-1', 'fp-b')

    expect(second.spawnedNow).toBe(true)
    expect(pool.created).toBe(2)
    expect(sessions[0]!.disposed).toBe(1)
    expect(warmSessionCount()).toBe(1)
    second.endTurn()
  })

  it('replaces a process that died between turns', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const first = await pool.acquire('conv-1', 'fp-a')
    first.endTurn()
    sessions[0]!.alive = false

    const second = await pool.acquire('conv-1', 'fp-a')
    expect(second.spawnedNow).toBe(true)
    expect(sessions[0]!.disposed).toBe(1)
    second.endTurn()
  })

  it('never hands out a session that is mid-turn', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const first = await pool.acquire('conv-1', 'fp-a')
    sessions[0]!.busy = true
    const second = await pool.acquire('conv-1', 'fp-a')

    expect(second.spawnedNow).toBe(true)
    second.endTurn()
    first.endTurn()
  })
})

describe('teardown', () => {
  it('disposes the session when a turn discards it, and drops it from the pool', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const lease = await pool.acquire('conv-1', 'fp-a')
    await lease.discard()

    expect(sessions[0]!.disposed).toBe(1)
    expect(warmSessionCount()).toBe(0)
  })

  it('drops a session that died DURING its turn rather than leaving it pooled', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const lease = await pool.acquire('conv-1', 'fp-a')
    sessions[0]!.alive = false
    lease.endTurn()
    await Bun.sleep(0)

    expect(warmSessionCount()).toBe(0)
    expect(sessions[0]!.disposed).toBe(1)
  })

  it('kills a conversation’s session on delete / session restart', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)
    const lease = await pool.acquire('conv-1', 'fp-a')
    lease.endTurn()

    await disposeWarmSessionsForConversation(USER, 'conv-1')
    expect(sessions[0]!.disposed).toBe(1)
    expect(warmSessionCount()).toBe(0)
    // Idempotent — a second delete must not throw.
    await disposeWarmSessionsForConversation(USER, 'conv-1')
  })

  it('bounds the number of live processes, evicting the least recently used idle one', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    // One conversation each for ten DIFFERENT users, so what is being measured
    // is the global ceiling and not the per-user one.
    for (let i = 0; i < 10; i += 1) {
      const lease = await pool.acquire(`conv-${i}`, 'fp-a', `user-${i}`)
      lease.endTurn()
      // Distinct `lastUsedAt` values, so "least recently used" is unambiguous.
      await Bun.sleep(2)
    }

    expect(warmSessionCount()).toBeLessThanOrEqual(8)
    // The oldest were the ones evicted, and each was properly disposed.
    expect(sessions[0]!.disposed).toBe(1)
    expect(sessions[9]!.disposed).toBe(0)
  })

  it('bounds ONE user to their own share, without touching anybody else', async () => {
    // The shape this closes: without a per-user cap, one person with several
    // tabs fills all eight slots and every other user's next turn pays a full
    // cold spawn — the shared-server version of the cost the pool exists to
    // remove.
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    const otherUser = await pool.acquire('conv-other', 'fp-a', 'user-2')
    otherUser.endTurn()
    await Bun.sleep(2)

    for (let i = 0; i < 4; i += 1) {
      const lease = await pool.acquire(`conv-${i}`, 'fp-a')
      lease.endTurn()
      await Bun.sleep(2)
    }

    // Two for the busy user, plus the untouched session belonging to the other.
    expect(warmSessionCount()).toBe(3)
    expect(sessions[0]!.disposed).toBe(0)
  })

  it('never evicts a mid-turn session to make room', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)

    // Fill the pool with sessions that are all still streaming.
    const held = []
    for (let i = 0; i < 8; i += 1) {
      held.push(await pool.acquire(`conv-${i}`, 'fp-a', `user-${i}`))
      sessions[i]!.busy = true
    }
    const overflow = await pool.acquire('conv-late', 'fp-a', 'user-late')

    expect(sessions.slice(0, 8).every((s) => s.disposed === 0)).toBe(true)
    overflow.endTurn()
    for (const lease of held) lease.endTurn()
  })

  it('disposes everything on shutdown', async () => {
    const sessions: FakeSession[] = []
    const pool = acquirer(sessions)
    for (const id of ['a', 'b', 'c']) {
      const lease = await pool.acquire(id, 'fp-a')
      lease.endTurn()
    }

    await disposeAllWarmSessions()
    expect(warmSessionCount()).toBe(0)
    expect(sessions.every((s) => s.disposed === 1)).toBe(true)
  })

  it('lets a failed spawn through to the caller without pooling anything', async () => {
    await expect(
      acquireWarmSession({
        userId: USER,
        conversationId: 'conv-1',
        fingerprint: 'fp-a',
        create: async () => {
          throw new Error('claude not on PATH')
        },
      }),
    ).rejects.toThrow('claude not on PATH')
    expect(warmSessionCount()).toBe(0)
  })
})

describe('the dynamic system-prompt suffix', () => {
  it('is handed out once, then only when it changes', async () => {
    const pool = acquirer([])
    const lease = await pool.acquire('conv-1', 'fp-a')

    expect(lease.takeSystemState('board: 3 pages')).toBe('board: 3 pages')
    expect(lease.takeSystemState('board: 3 pages')).toBeNull()
    expect(lease.takeSystemState('board: 4 pages')).toBe('board: 4 pages')
    expect(lease.takeSystemState('board: 4 pages')).toBeNull()
    lease.endTurn()
  })

  it('is remembered across turns on the same process', async () => {
    const pool = acquirer([])
    const first = await pool.acquire('conv-1', 'fp-a')
    expect(first.takeSystemState('state-v1')).toBe('state-v1')
    first.endTurn()

    const second = await pool.acquire('conv-1', 'fp-a')
    expect(second.spawnedNow).toBe(false)
    expect(second.takeSystemState('state-v1')).toBeNull()
    second.endTurn()
  })

  it('treats "no suffix" as nothing to send', async () => {
    const pool = acquirer([])
    const lease = await pool.acquire('conv-1', 'fp-a')
    expect(lease.takeSystemState(null)).toBeNull()
    lease.endTurn()
  })
})
