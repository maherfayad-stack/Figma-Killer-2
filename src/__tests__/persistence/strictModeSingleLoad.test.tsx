/**
 * edit-speed — React's dev double-mount must not fetch the project twice.
 *
 * `<StrictMode>` (src/admin/main.tsx) runs every effect, cleans it up and runs
 * it again inside one synchronous commit. The 2026-10-10 audit saw
 * `/admin/api/studio/load` requested twice ~2 ms apart, the first aborted — the
 * server still parsed the whole project for it (700+ ms). The load effect must
 * therefore not reach the adapter on a run that the cleanup already cancelled,
 * without StrictMode being removed (it is what finds missing cleanups).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { useEditorStore } from '@site/store/store'

function Host({ adapter }: { adapter: IPersistenceAdapter }) {
  usePersistence('default', adapter, { enabled: true, autoSaveDelayMs: 50 })
  return null
}

beforeEach(() => {
  useEditorStore.setState({ site: null } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
})

describe('the initial project load under StrictMode', () => {
  it('asks the adapter once, not once per mount', async () => {
    let loads = 0
    const adapter: IPersistenceAdapter = {
      loadSite: async () => {
        loads++
        return undefined
      },
      saveSite: async () => {},
    }

    render(
      <StrictMode>
        <Host adapter={adapter} />
      </StrictMode>,
    )

    await waitFor(() => expect(loads).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(loads).toBe(1)
  })
})
