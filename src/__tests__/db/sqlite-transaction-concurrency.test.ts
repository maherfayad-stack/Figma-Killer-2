import { describe, test, expect } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Regression guard for ISS-040: the SQLite adapter runs every transaction on
 * one shared connection. When transaction A is parked on a real async yield
 * with its BEGIN still open, a concurrently-started transaction B used to issue
 * a second BEGIN on the same connection — which throws "cannot start a
 * transaction within a transaction", and B's catch-block ROLLBACK then aborted
 * A's open transaction, silently destroying atomicity and losing committed
 * writes.
 *
 * The adapter must serialize transactions so only one is ever open at a time:
 * two overlapping transactions both commit, in full, with no interleaving.
 */
describe('SQLite adapter — concurrent transactions', () => {
  test('overlapping transactions both commit atomically (no BEGIN-within-BEGIN)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await db`create table tx_probe (id integer primary key, label text)`

      // Transaction A holds its BEGIN open across a real macrotask yield,
      // then performs a second write — exactly the publish-style long
      // transaction that triggers the bug.
      const a = db.transaction(async (tx) => {
        await tx`insert into tx_probe (id, label) values (1, 'a1')`
        await delay(40)
        await tx`insert into tx_probe (id, label) values (2, 'a2')`
      })

      // Transaction B starts while A is still parked.
      const b = (async () => {
        await delay(10)
        await db.transaction(async (tx) => {
          await tx`insert into tx_probe (id, label) values (3, 'b1')`
        })
      })()

      await Promise.all([a, b])

      const { rows } = await db<{ id: number }>`select id from tx_probe order by id`
      expect(rows.map((r) => r.id)).toEqual([1, 2, 3])
    } finally {
      await cleanup()
    }
  })

  test('a failing transaction rolls back only its own work, not a concurrent one', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await db`create table tx_probe2 (id integer primary key)`

      const committed = db.transaction(async (tx) => {
        await tx`insert into tx_probe2 (id) values (1)`
        await delay(30)
        await tx`insert into tx_probe2 (id) values (2)`
      })

      // Asserted with try/catch rather than `expect(...).rejects`: under bun
      // 1.3.6 that matcher never settles when the promise it awaits is a
      // transaction queued behind another one that is still parked on a timer,
      // which wedges the whole runner (the process spins forever and every
      // later test file never runs). The same interleaving completes correctly
      // outside the test runner, so this is a matcher deadlock, not adapter
      // behaviour — and the assertion below is exactly as strong.
      const failed = (async () => {
        await delay(10)
        let rejection = ''
        try {
          await db.transaction(async (tx) => {
            await tx`insert into tx_probe2 (id) values (3)`
            throw new Error('boom')
          })
        } catch (err) {
          rejection = err instanceof Error ? err.message : String(err)
        }
        expect(rejection).toBe('boom')
      })()

      await Promise.all([committed, failed])

      const { rows } = await db<{ id: number }>`select id from tx_probe2 order by id`
      // The committed transaction keeps both rows; the failed one leaves nothing.
      expect(rows.map((r) => r.id)).toEqual([1, 2])
    } finally {
      await cleanup()
    }
  })
})
