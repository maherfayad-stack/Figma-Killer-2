/**
 * AI-7 / AI-28 in the panel: "Changed N files" with Revert turn and per-file
 * revert, a refusal shown as a quiet note (never an alert), and a recovered
 * tool failure rendered muted rather than red.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import type { AgentRevertResult, AgentSlice, AgentTurnChanges } from '@site/agent'
import { TurnChangesCard } from '@site/panels/AgentPanel/TurnChangesCard'
import { ToolCallRow } from '@site/panels/AgentPanel/ToolCallRow'

afterEach(() => cleanup())

const CHANGES: AgentTurnChanges = {
  turnId: 'turn1',
  startedAtMs: 0,
  files: [
    { path: 'pages/About.tsx', change: 'modified', state: 'changed-since', revertable: false, reason: '"pages/About.tsx" changed after this turn wrote it.', added: 1, removed: 1 },
    { path: 'pages/Home.tsx', change: 'modified', state: 'current', revertable: true, reason: null, added: 3, removed: 1 },
  ],
}

function renderCard(revert: (turnId: string, paths?: readonly string[]) => Promise<AgentRevertResult>) {
  const store = createStore<AgentSlice>()(() => ({ revertAgentTurn: revert }) as unknown as AgentSlice)
  return render(
    <AgentStoreProvider store={store}>
      <TurnChangesCard changes={CHANGES} disabled={false} />
    </AgentStoreProvider>,
  )
}

describe('TurnChangesCard', () => {
  it('summarises the turn and offers Revert turn plus a per-file revert only where one can run', () => {
    renderCard(async () => ({ ok: true, reverted: [] }))
    expect(screen.getByText(/Changed 2 files/)).toBeTruthy()
    expect(screen.getByText('+4')).toBeTruthy()
    expect(screen.getByText('Changed since')).toBeTruthy()
    // Disabled WITH a tooltip (the reason) is aria-disabled, so the tooltip still shows.
    expect(screen.getByRole('button', { name: 'Revert pages/About.tsx' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: 'Revert pages/Home.tsx' }).getAttribute('aria-disabled')).toBeNull()
  })

  it('a refused Revert turn is a quiet status note naming the file, never an alert', async () => {
    const calls: Array<readonly string[] | undefined> = []
    renderCard(async (_turnId, paths) => {
      calls.push(paths)
      return { ok: false, message: 'Nothing was reverted. "pages/About.tsx" changed after this turn wrote it.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Revert turn' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('pages/About.tsx'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls).toEqual([undefined])
  })

  it('a per-file revert names only that file', async () => {
    const calls: Array<readonly string[] | undefined> = []
    renderCard(async (_turnId, paths) => {
      calls.push(paths)
      return { ok: true, reverted: ['pages/Home.tsx'] }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Revert pages/Home.tsx' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Reverted pages/Home.tsx.'))
    expect(calls).toEqual([['pages/Home.tsx']])
  })
})

describe('ToolCallRow — a recovered failure is not an error', () => {
  const failed = { id: 't', actionType: 'studio_edit_file', params: { path: 'a.tsx' }, status: 'error' as const, result: { ok: false, error: 'edit-no-match' } }

  it('renders muted ("Adjusted") with no alert when the agent recovered', () => {
    render(<ToolCallRow toolCall={failed} recovery="recovered" />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/Adjusted: edit-no-match/)).toBeTruthy()
  })

  it('stays an alert when the turn ended on it', () => {
    render(<ToolCallRow toolCall={failed} />)
    expect(screen.getByRole('alert').textContent).toBe('edit-no-match')
  })
})
