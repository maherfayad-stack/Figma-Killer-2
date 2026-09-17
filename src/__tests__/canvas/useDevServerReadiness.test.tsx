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
/** When set, every poll rejects with it — the "dev server is down" condition. */
let statusFailure: Error | null = null

mock.module('@site/studio/devServerRequests', () => ({
  getDevServerStatus: async (dir: string): Promise<StubStatus> => {
    statusCalls.push(dir)
    if (statusFailure) throw statusFailure
    return nextStatus
  },
}))

const {
  useDevServerReadiness,
  nextPollDelayMs,
  POLL_INTERVAL_START_MS,
  POLL_INTERVAL_MAX_MS,
} = await import('@site/studio/useDevServerReadiness')

function Consumer({ dir }: { dir: string | null }) {
  const readiness = useDevServerReadiness(dir)
  return <span data-testid="phase">{readiness.phase}</span>
}

afterEach(() => {
  cleanup()
  setStudioTrustTier('static')
  statusCalls = []
  statusFailure = null
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

/**
 * Z3. The poll used to tick at a flat 1 s and log its failure on every one of
 * them, so a dev server that was down — which is a minutes-long condition —
 * meant a request and a console line every second, forever. Both halves of
 * that are bounded now, and the two are tested separately: the curve is pure
 * arithmetic and does not need ten real seconds to prove, while "reported
 * once" genuinely needs several real ticks to observe.
 */
describe('useDevServerReadiness — the poll backs off and reports once', () => {
  it('doubles the delay up to the ceiling and never past it', () => {
    expect(POLL_INTERVAL_START_MS).toBe(1000)
    expect(POLL_INTERVAL_MAX_MS).toBe(10_000)

    const curve: number[] = []
    let delay = POLL_INTERVAL_START_MS
    for (let i = 0; i < 6; i += 1) {
      curve.push(delay)
      delay = nextPollDelayMs(delay)
    }
    expect(curve).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000])
    // The ceiling is a fixed point — no amount of further backoff escapes it.
    expect(nextPollDelayMs(POLL_INTERVAL_MAX_MS)).toBe(POLL_INTERVAL_MAX_MS)
  })

  it('logs a repeating failure once, not once per tick', async () => {
    setStudioTrustTier('run-project')
    statusFailure = new Error('dev server unreachable')
    const logged: unknown[][] = []
    const consoleError = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }

    try {
      render(<Consumer dir="/test/project-down" />)
      // Long enough for the immediate poll plus the 1s and 2s retries.
      await new Promise((resolve) => setTimeout(resolve, 3400))
    } finally {
      console.error = consoleError
    }

    // It kept polling — the backoff is a throttle, not a stop.
    expect(statusCalls.length).toBeGreaterThanOrEqual(3)
    // But the console heard about it exactly once.
    const failureLines = logged.filter((args) => String(args[0]).includes('status poll failed'))
    expect(failureLines).toHaveLength(1)
  }, 10_000)
})
