/**
 * SaveStatusChip.test.tsx — Z6: "unsaved is a state, not a surprise".
 *
 * `usePersistence` restores the dirty snapshot on a failed save and stays
 * silent, so this chip is the ONLY place a failed save is reported. These
 * tests pin what each `saveStatus` renders as, and that the failed state is
 * actionable.
 *
 * The retry ladder itself lives in `usePersistence` and is covered by
 * `src/__tests__/persistence/saveRetryLadder.test.tsx`. No toast assertions
 * here on purpose — the chip must never push one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PersistenceSaveStatus } from '@site/hooks/persistenceStatus'
import { SaveStatusChip } from '../SaveStatusChip'

afterEach(() => {
  cleanup()
})

const NOOP_RETRY = async (): Promise<void> => {}

function statusOf(state: PersistenceSaveStatus['state']): PersistenceSaveStatus {
  return { state }
}

describe('SaveStatusChip', () => {
  it('renders nothing until the site has loaded', () => {
    const { container } = render(<SaveStatusChip status={statusOf('loading')} onRetry={NOOP_RETRY} />)
    expect(container.textContent).toBe('')
  })

  it('reads "Saved" when the document is on disk', () => {
    render(<SaveStatusChip status={statusOf('saved')} onRetry={NOOP_RETRY} />)
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads "Saving…" while a save is on the wire', () => {
    render(<SaveStatusChip status={statusOf('saving')} onRetry={NOOP_RETRY} />)
    expect(screen.getByText('Saving…')).toBeTruthy()
  })

  it('offers a click-to-save affordance while there are unsaved changes', () => {
    let calls = 0
    const retry = async (): Promise<void> => {
      calls += 1
    }
    render(<SaveStatusChip status={statusOf('unsaved')} onRetry={retry} />)

    const button = screen.getByRole('button')
    expect(button.textContent).toContain('Unsaved')
    expect(button.textContent).not.toContain('retry')

    fireEvent.click(button)
    expect(calls).toBe(1)
  })

  it('still reads "Saving…" while the automatic ladder has a rung left', () => {
    render(
      <SaveStatusChip status={{ state: 'error', retrying: true }} onRetry={NOOP_RETRY} />,
    )
    // The chip must NOT accuse the save of being lost while it is about to
    // try again — a restarting dev server is back inside ten seconds.
    expect(screen.getByText('Saving…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads "Unsaved — retry" once the ladder is exhausted, and retries on click', () => {
    let calls = 0
    const retry = async (): Promise<void> => {
      calls += 1
    }
    render(
      <SaveStatusChip
        status={{ state: 'error', retrying: false, message: 'Save failed' }}
        onRetry={retry}
      />,
    )

    const button = screen.getByRole('button')
    expect(button.textContent).toContain('Unsaved — retry')
    expect(button.getAttribute('data-save-status')).toBe('error')

    fireEvent.click(button)
    expect(calls).toBe(1)
  })
})
