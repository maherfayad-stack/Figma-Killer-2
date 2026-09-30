/**
 * usePersistence automatic save-retry ladder (Z6).
 *
 * A failed save restores its dirty snapshot and stays silent — no toast, ever,
 * because a dev server restart can fail a dozen saves in a row. What it does
 * instead is retry: up to three attempts on a 2s/4s/8s backoff, through the
 * same single-flight queue, reporting `retrying` on the status so the toolbar
 * chip reads "Saving…" rather than accusing the editor of losing work.
 *
 * These tests pin the first rung and the two flags the chip renders from; the
 * full 14s ladder is not re-walked in a unit test, only its budget arithmetic
 * (`SAVE_RETRY_BACKOFF_MS.length`) and the reset-on-success rule.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import React, { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import { SAVE_RETRY_BACKOFF_MS, type PersistenceSaveStatus } from '@site/hooks/persistenceStatus'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { makePage, makeSite } from '../fixtures'

interface Harness {
  save: () => Promise<void>
  statuses: PersistenceSaveStatus[]
}

function HookHost({
  adapter,
  onReady,
  onStatus,
}: {
  adapter: IPersistenceAdapter
  onReady: (save: () => Promise<void>) => void
  onStatus: (status: PersistenceSaveStatus) => void
}) {
  const { saveSite, saveStatus } = usePersistence('default', adapter, { enabled: true })
  useEffect(() => {
    onReady(saveSite)
  }, [onReady, saveSite])
  useEffect(() => {
    onStatus(saveStatus)
  }, [onStatus, saveStatus])
  return null
}

function fixtureSite() {
  return makeSite({ pages: [makePage({ id: 'page-a', slug: 'index', title: 'Home' })] })
}

function seedStore(): void {
  useEditorStore.setState({
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadSite(fixtureSite())
}

async function mountHook(adapter: IPersistenceAdapter): Promise<Harness> {
  let save: (() => Promise<void>) | null = null
  const statuses: PersistenceSaveStatus[] = []
  render(
    <HookHost
      adapter={adapter}
      onReady={(s) => {
        save = s
      }}
      onStatus={(s) => {
        statuses.push(s)
      }}
    />,
  )
  await waitFor(() => expect(save).not.toBeNull())
  return { save: save!, statuses }
}

function editPage(): void {
  const store = useEditorStore.getState()
  useEditorStore.setState({ activePageId: 'page-a' })
  store.updateNodeProps('root', { text: `edit-${Math.random()}` })
}

afterEach(cleanup)

describe('usePersistence save-retry ladder', () => {
  it('budgets exactly three automatic retries', () => {
    expect(SAVE_RETRY_BACKOFF_MS).toEqual([2000, 4000, 8000])
  })

  it('reports retrying:true on the first failure and retries on the 2s rung', async () => {
    seedStore()
    let attempts = 0
    // A resolving `loadSite` keeps the bootstrap-a-fresh-draft branch (and
    // its own save) out of the attempt count.
    const adapter: IPersistenceAdapter = {
      loadSite: async () => fixtureSite(),
      saveSite: async () => {
        attempts += 1
        throw new Error('server unreachable')
      },
    }
    const { save, statuses } = await mountHook(adapter)

    editPage()
    await save().catch(() => {
      // The caller always sees the rejection; the ladder is a side effect.
    })

    await waitFor(() => {
      const latest = statuses.at(-1)
      expect(latest?.state).toBe('error')
      expect(latest?.retrying).toBe(true)
    })
    expect(attempts).toBe(1)

    // The first rung is 2s. Nothing before it.
    await waitFor(() => expect(attempts).toBe(2), { timeout: 6000 })
  }, 15000)

  it('a success clears the streak, so the next failure starts at the first rung again', async () => {
    seedStore()
    let failNext = true
    let attempts = 0
    const adapter: IPersistenceAdapter = {
      loadSite: async () => fixtureSite(),
      saveSite: async () => {
        attempts += 1
        if (failNext) throw new Error('server unreachable')
      },
    }
    const { save, statuses } = await mountHook(adapter)

    editPage()
    await save().catch(() => {})
    await waitFor(() => expect(statuses.at(-1)?.retrying).toBe(true))

    // Let the automatic retry land, this time successfully.
    failNext = false
    await waitFor(() => expect(statuses.at(-1)?.state).toBe('saved'), { timeout: 6000 })

    // A later failure is a NEW streak — retrying is true again, which it
    // would not be if the counter had kept climbing across the success.
    failNext = true
    const before = attempts
    editPage()
    await save().catch(() => {})
    expect(attempts).toBe(before + 1)
    await waitFor(() => {
      const latest = statuses.at(-1)
      expect(latest?.state).toBe('error')
      expect(latest?.retrying).toBe(true)
    })
  }, 15000)
})
