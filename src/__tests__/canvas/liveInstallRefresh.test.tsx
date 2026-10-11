/**
 * After "Install dependencies": the panel is actually shown, the Live pill
 * learns the project can run without a reload, the dev server is not asked to
 * start into a refusal, and a project with nothing to run is not polled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useAdminUi } from '@admin/state/adminUi'
import { useEditorStore } from '@site/store/store'
import { setStudioTrustTier } from '@site/studio/studioProjectTrust'
import { __resetDevServerReadinessForTests } from '@site/studio/useDevServerReadiness'
import { __resetLiveCapabilityForTests } from '@site/studio/liveCapabilityStore'
import { refreshProjectAfterInstall } from '@site/studio/projectInstallRefresh'
import { useDevServerPrewarm } from '@site/studio/useDevServerPrewarm'
import { LiveRuntimePill } from '@site/canvas/LiveRuntimePill'

const DIR = '/ws/installable'
const realFetch = globalThis.fetch

interface World {
  live: { capable: boolean; reason?: string }
  phase: 'stopped' | 'booting' | 'ready' | 'failed'
  calls: string[]
}

let world: World

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    world.calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
    let body: unknown = {}
    if (url.includes('/trust-tier')) body = { trust: 'run-project', live: world.live, autoPromoted: false }
    else if (url.includes('/dev-server')) body = { phase: world.phase, pid: null, startedAt: null, log: '' }
    else if (url.includes('/install/status')) {
      body = {
        hasPackageJson: true,
        hasNodeModules: true,
        dependencyCount: 1,
        packageManager: 'bun',
        dependencies: {},
        devDependencies: {},
        installedPackages: [],
        job: null,
      }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

beforeEach(() => {
  world = { live: { capable: false, reason: 'not-installed' }, phase: 'stopped', calls: [] }
  installFetch()
  useAdminUi.setState({ studioProject: { dir: DIR, name: 'installable' } })
  act(() => setStudioTrustTier('run-project'))
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  __resetDevServerReadinessForTests()
  __resetLiveCapabilityForTests()
  act(() => setStudioTrustTier('static'))
  useAdminUi.setState({ studioProject: null })
})

function Prewarm() {
  useDevServerPrewarm()
  return null
}

describe('Install dependencies action', () => {
  it('shows the Dependencies panel instead of flipping a flag behind Explorer', () => {
    useEditorStore.getState().setLeftSidebarPanel('explorer')
    useEditorStore.getState().setDependenciesPanelOpen(true)
    const state = useEditorStore.getState()
    expect(state.dependenciesPanelOpen).toBe(true)
    expect(state.explorerPanelOpen).toBe(false)
    useEditorStore.getState().setDependenciesPanelOpen(false)
    expect(useEditorStore.getState().dependenciesPanelOpen).toBe(false)
  })
})

describe('Live pill after an install', () => {
  it('flips from "needs an install" to starting/Live without a reload', async () => {
    render(<LiveRuntimePill />)
    expect((await screen.findByTestId('live-runtime-pill')).textContent).toBe('Live needs an install')

    world.live = { capable: true }
    world.phase = 'ready'
    act(() => refreshProjectAfterInstall())

    await waitFor(() => expect(screen.getByTestId('live-runtime-pill').textContent).toBe('Live'))
  })
})

describe('dev server prewarm', () => {
  it('does not ask a project that cannot run to start (no refusal in the console on every open)', async () => {
    render(<Prewarm />)
    await waitFor(() => expect(world.calls.some((call) => call.includes('/trust-tier'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(world.calls.some((call) => call.startsWith('POST') && call.includes('/dev-server'))).toBe(false)
  })

  it('starts the dev server once the project can run', async () => {
    world.live = { capable: true }
    render(<Prewarm />)
    await waitFor(() => expect(world.calls.some((call) => call.startsWith('POST') && call.includes('/dev-server'))).toBe(true))
  })

  it('does not poll dev-server status for a project that cannot run', async () => {
    render(<LiveRuntimePill />)
    await screen.findByTestId('live-runtime-pill')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(world.calls.filter((call) => call.includes('/dev-server')).length).toBeLessThanOrEqual(1)
  })
})
