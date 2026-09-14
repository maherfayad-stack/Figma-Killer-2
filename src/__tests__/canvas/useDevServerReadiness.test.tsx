/**
 * useDevServerReadiness — L8 Phase A (`perf-06`, STATE.md).
 *
 * Proves the three load-bearing properties the module doc promises: never
 * polls below Tier 2 or without a project dir, stops the instant `phase`
 * settles, and shares exactly ONE poll loop across every mounted consumer of
 * the SAME `dir` — the whole reason this is a reference-counted external
 * store instead of a per-component `useEffect` + `setInterval`.
 *
 * Each test uses its OWN `dir` string so the module-level per-`dir` map
 * never leaks state between tests, regardless of run order.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { setStudioTrustTier } from '@site/studio/studioProjectTrust'

interface StubStatus {
  phase: 'stopped' | 'booting' | 'ready' | 'failed'
  pid: number | null
  startedAt: number | null
  log: string
}

let statusCalls: string[] = []
let nextStatus: StubStatus = { phase: 'booting', pid: null, startedAt: null, log: '' }

mock.module('@site/studio/devServerRequests', () => ({
  getDevServerStatus: async (dir: string): Promise<StubStatus> => {
    statusCalls.push(dir)
    return nextStatus
  },
}))

const { useDevServerReadiness } = await import('@site/studio/useDevServerReadiness')

function Consumer({ dir }: { dir: string | null }) {
  const readiness = useDevServerReadiness(dir)
  return <span data-testid="phase">{readiness.phase}</span>
}

afterEach(() => {
  cleanup()
  setStudioTrustTier('static')
  statusCalls = []
  nextStatus = { phase: 'booting', pid: null, startedAt: null, log: '' }
})

describe('useDevServerReadiness', () => {
  it('never polls when trust !== "run-project"', async () => {
    render(<Consumer dir="/test/project-tier0" />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(statusCalls).toEqual([])
  })

  it('never polls when dir is null, even at Tier 2', async () => {
    setStudioTrustTier('run-project')
    render(<Consumer dir={null} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(statusCalls).toEqual([])
  })

  it('polls immediately once active, updates the hook value, and stops once settled', async () => {
    setStudioTrustTier('run-project')
    nextStatus = { phase: 'ready', pid: 123, startedAt: 1, log: 'compiled' }
    const { getByTestId } = render(<Consumer dir="/test/project-settles" />)

    await waitFor(() => {
      expect(getByTestId('phase').textContent).toBe('ready')
    })
    expect(statusCalls).toEqual(['/test/project-settles'])

    // Settled — no second poll gets scheduled, so a short real wait proves
    // nothing fires again (no need to wait out the full 1s interval: the
    // code path that would schedule it never runs once `isSettled` is true).
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(statusCalls).toEqual(['/test/project-settles'])
  })

  it('shares exactly one poll loop across two mounted consumers of the same dir', async () => {
    setStudioTrustTier('run-project')
    nextStatus = { phase: 'ready', pid: 1, startedAt: 1, log: '' }
    render(
      <>
        <Consumer dir="/test/project-shared" />
        <Consumer dir="/test/project-shared" />
      </>,
    )

    await waitFor(() => {
      expect(statusCalls.length).toBeGreaterThan(0)
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(statusCalls).toEqual(['/test/project-shared'])
  })
})
