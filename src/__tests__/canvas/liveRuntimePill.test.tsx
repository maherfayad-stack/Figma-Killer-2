/**
 * LiveRuntimePill — the pill may only say "Live" when a dev server is actually
 * answering. The reported bug: a Tier-2 project with no node_modules showed
 * "Live — your real app, running its own dev server" over Studio's static
 * render, while the dev server's failure was dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useAdminUi } from '@admin/state/adminUi'
import { setStudioTrustTier } from '@site/studio/studioProjectTrust'
import { __resetDevServerReadinessForTests } from '@site/studio/useDevServerReadiness'
import { LiveRuntimePill } from '@site/canvas/LiveRuntimePill'
import { liveEntryBreakpointId } from '@site/canvas/liveEntryBreakpoint'
import type { Breakpoint } from '@core/page-tree'

const DIR = '/ws/test4'
const realFetch = globalThis.fetch

function stubFetch(live: { capable: boolean; reason?: string }, devPhase: 'ready' | 'failed' | 'booting', log = '') {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/trust-tier')
      ? { trust: 'run-project', live, autoPromoted: false }
      : { phase: devPhase, pid: null, startedAt: null, log }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

beforeEach(() => {
  useAdminUi.setState({ studioProject: { dir: DIR, name: 'test4' } })
  act(() => setStudioTrustTier('run-project'))
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  __resetDevServerReadinessForTests()
  act(() => setStudioTrustTier('static'))
  useAdminUi.setState({ studioProject: null })
})

describe('LiveRuntimePill at Tier 2', () => {
  it('never says Live for a project the server reports as not installed, and offers the install remedy', async () => {
    stubFetch({ capable: false, reason: 'not-installed' }, 'failed', 'Vite is not installed in this project')
    render(<LiveRuntimePill />)
    const pill = await screen.findByTestId('live-runtime-pill')
    expect(pill.textContent).toBe('Live needs an install')
    expect(pill.getAttribute('data-runtime')).toBe('blocked')
    expect(screen.getByTestId('live-runtime-pill-install')).toBeTruthy()
  })

  it('says "Live failed" when the project can run but its dev server gave up', async () => {
    stubFetch({ capable: true }, 'failed', 'boom')
    render(<LiveRuntimePill />)
    await waitFor(() => expect(screen.getByTestId('live-runtime-pill').textContent).toBe('Live failed'))
  })

  it('says Live only once the dev server reports ready', async () => {
    stubFetch({ capable: true }, 'ready')
    render(<LiveRuntimePill />)
    await waitFor(() => expect(screen.getByTestId('live-runtime-pill').textContent).toBe('Live'))
  })
})

describe('liveEntryBreakpointId', () => {
  const breakpoints = [
    { id: 'mobile', label: 'Mobile', width: 375, mediaQuery: '', icon: 'smartphone' },
    { id: 'tablet', label: 'Tablet', width: 768, mediaQuery: '', icon: 'tablet' },
    { id: 'desktop', label: 'Desktop', width: 1440, mediaQuery: '', icon: 'monitor' },
  ] as Breakpoint[]

  it('opens a Mobile project (393 wide screens) on the mobile breakpoint, not 1440', () => {
    expect(liveEntryBreakpointId(breakpoints, 393)).toBe('mobile')
  })

  it('opens a Web project on desktop', () => {
    expect(liveEntryBreakpointId(breakpoints, 1440)).toBe('desktop')
  })

  it('leaves the choice alone when the project records no width', () => {
    expect(liveEntryBreakpointId(breakpoints, undefined)).toBeNull()
  })
})
