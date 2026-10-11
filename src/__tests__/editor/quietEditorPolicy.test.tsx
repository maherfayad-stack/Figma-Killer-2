/**
 * P3-A — the quiet editor: what the editor does ITSELF instead of showing an
 * error. One file per finding would scatter a single policy; these are the
 * regressions for the client half of it:
 *
 *   - ERR-18 — a project load that got no answer is retried on a ladder, the
 *     failure state has a Retry button, and a background re-read that fails is
 *     marked on the save chip (`boardStale`), never toasted.
 *   - ERR-13 — a boundary can retry once by itself (`autoRetry`), editor
 *     chrome crashes silently and comes back on the next store change
 *     (`ChromeBoundary`), and "Editor chunk failed to load" is said only for a
 *     real chunk failure (`isChunkLoadError`).
 *   - ERR-26 — the editor window's own `unhandledrejection` lands in the
 *     diagnostics buffer, with no toast.
 *   - ERR-29 — a codemod's `stale-source` / `not-found` is recovered like
 *     `element-moved`, never "Reload the project and try again".
 *
 * Each was confirmed to fail with its fix disabled in place (PR body).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React, { useEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import type { PersistenceSaveStatus } from '@site/hooks/persistenceStatus'
import { useEditorStore } from '@site/store/store'
import type { IPersistenceAdapter } from '@core/persistence/types'
import type { SiteDocument } from '@core/page-tree'
import { setUnreachableRetrySleepForTests } from '@core/http'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { isChunkLoadError } from '@admin/lib/chunkLoadError'
import { ChromeBoundary } from '@site/ui/ChromeBoundary'
import { installEditorWindowDiagnostics } from '@site/canvas/editorWindowDiagnostics'
import { readFrameDiagnostics } from '@site/canvas/canvasDiagnosticsBuffer'
import { elementMovedNodeIds } from '@site/studio/elementMovedRecovery'
import { __resetToastBusForTests, subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { makePage, makeSite } from '../fixtures'

let toasts: readonly Toast[] = []
let unsubscribeToasts: () => void = () => {}
let restoreConsole: () => void = () => {}
/** Tests that need to act on a boundary's own log line (its `componentDidCatch`) register here. */
const consoleErrorListeners = new Set<(args: unknown[]) => void>()

beforeEach(() => {
  __resetToastBusForTests()
  toasts = []
  unsubscribeToasts = subscribeToasts((snapshot) => {
    toasts = snapshot
  })
  // Every ladder in this file runs without real waits.
  setUnreachableRetrySleepForTests(async () => {})
  // Boundaries and ladders log by design; keep the test output readable.
  const error = console.error
  const warn = console.warn
  console.error = (...args: unknown[]) => {
    for (const listener of consoleErrorListeners) listener(args)
  }
  console.warn = () => {}
  restoreConsole = () => {
    console.error = error
    console.warn = warn
  }
})

afterEach(() => {
  cleanup()
  unsubscribeToasts()
  setUnreachableRetrySleepForTests(null)
  restoreConsole()
  consoleErrorListeners.clear()
})

// ─── ERR-18 ─────────────────────────────────────────────────────────────────

/** A `loadSite` that fails with "no answer" `failures` times, then answers. */
function flakyAdapter(failures: number, site: SiteDocument): { adapter: IPersistenceAdapter; attempts: () => number } {
  let attempts = 0
  return {
    adapter: {
      loadSite: async () => {
        attempts += 1
        if (attempts <= failures) throw new TypeError('Failed to fetch')
        return site
      },
      saveSite: async () => {},
    },
    attempts: () => attempts,
  }
}

/** What the hook returned on its last commit — written from an effect, so the host stays a pure render. */
const probe: { controller: ReturnType<typeof usePersistence> | null } = { controller: null }

function HookHost({ adapter }: { adapter: IPersistenceAdapter }) {
  const controller = usePersistence('default', adapter, { enabled: true })
  useEffect(() => {
    probe.controller = controller
  })
  return null
}

function resetStore(): void {
  useEditorStore.setState({ site: null, hasUnsavedChanges: false } as Parameters<typeof useEditorStore.setState>[0])
}

describe('ERR-18 — loads retry, and a failure has a way back', () => {
  beforeEach(() => {
    probe.controller = null
    resetStore()
  })

  it('a project load that got no answer is retried until the server answers — no error state is left behind', async () => {
    const site = makeSite({ pages: [makePage({ id: 'home' })] })
    const flaky = flakyAdapter(2, site)
    render(React.createElement(HookHost, { adapter: flaky.adapter }))

    await waitFor(() => expect(useEditorStore.getState().site?.pages[0]?.id).toBe('home'))
    expect(flaky.attempts()).toBe(3)
    expect(probe.controller!.saveStatus.state).toBe('saved')
    expect(toasts).toEqual([])
  })

  it('once the ladder runs out the state is a plain sentence, and retryLoad opens the project', async () => {
    const site = makeSite({ pages: [makePage({ id: 'home' })] })
    // One more failure than the ladder has rungs (1 attempt + 3 retries).
    const flaky = flakyAdapter(4, site)
    render(React.createElement(HookHost, { adapter: flaky.adapter }))

    await waitFor(() => expect(probe.controller!.saveStatus.state).toBe('error'))
    const status: PersistenceSaveStatus = probe.controller!.saveStatus
    expect(status.retrying).toBe(false)
    expect(status.message).not.toContain('Failed to fetch')
    expect(useEditorStore.getState().site).toBeNull()

    act(() => probe.controller!.retryLoad())
    await waitFor(() => expect(useEditorStore.getState().site?.pages[0]?.id).toBe('home'))
    expect(toasts).toEqual([])
  })

  it('a background re-read that fails marks the board stale on the chip — no toast', async () => {
    let reloadsFail = false
    const adapter: IPersistenceAdapter = {
      // A fresh document per read, as the real adapter returns: the store
      // freezes the one it adopts.
      loadSite: async () => {
        if (reloadsFail) throw new TypeError('Failed to fetch')
        return makeSite({ pages: [makePage({ id: 'home' })] })
      },
      saveSite: async () => {},
    }
    render(React.createElement(HookHost, { adapter }))
    await waitFor(() => expect(probe.controller!.saveStatus.state).toBe('saved'))

    reloadsFail = true
    act(() => {
      window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT))
    })
    await waitFor(() => expect(probe.controller!.boardStale).toBe(true))
    expect(toasts).toEqual([])

    reloadsFail = false
    act(() => {
      window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT))
    })
    await waitFor(() => expect(probe.controller!.boardStale).toBe(false))
  })
})

// ─── ERR-13 ─────────────────────────────────────────────────────────────────

describe('ERR-13 — boundaries that recover on their own', () => {
  it('autoRetry={1}: a crash that does not repeat never shows the fallback', async () => {
    // Throws until the BOUNDARY has caught it (its own log line), then draws —
    // a render racing a resync. React 19 replays a throwing render once in
    // dev, so a "throw on the first render only" counter never reaches the
    // boundary at all (see `panelBoundary.test.tsx`).
    const control = { throwing: true }
    consoleErrorListeners.add((args) => {
      if (String(args[0]).includes('error-boundary:test-canvas')) control.throwing = false
    })
    function Flaky() {
      if (control.throwing) throw new Error('one-render race')
      return <div data-testid="flaky">drawn</div>
    }
    render(
      <ErrorBoundary location="test-canvas" autoRetry={1}>
        <Flaky />
      </ErrorBoundary>,
    )
    await waitFor(() => expect(screen.getByTestId('flaky').textContent).toBe('drawn'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ChromeBoundary: a crashed piece of chrome renders nothing, and is back after the next store change', async () => {
    const control = { throwing: true }
    function Ruler() {
      if (control.throwing) throw new Error('ruler blew up')
      return <div data-testid="ruler">ruler</div>
    }
    render(
      <div data-testid="host">
        <ChromeBoundary id="test-ruler">
          <Ruler />
        </ChromeBoundary>
      </div>,
    )
    expect(screen.queryByTestId('ruler')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('host').textContent).toBe('')

    control.throwing = false
    act(() => {
      useEditorStore.setState({ hasUnsavedChanges: !useEditorStore.getState().hasUnsavedChanges })
    })
    await waitFor(() => expect(screen.getByTestId('ruler').textContent).toBe('ruler'))
    expect(toasts).toEqual([])
  })

  it('"chunk failed" is reserved for a real chunk failure', () => {
    expect(isChunkLoadError([{ name: 'TypeError', message: 'Failed to fetch dynamically imported module: /x.js' }])).toBe(true)
    expect(isChunkLoadError([{ name: 'ChunkLoadError', message: 'Loading chunk 7 failed.' }])).toBe(true)
    expect(isChunkLoadError([{ name: 'TypeError', message: "Cannot read properties of undefined (reading 'id')" }])).toBe(false)
  })
})

// ─── ERR-26 ─────────────────────────────────────────────────────────────────

describe('ERR-26 — the editor window has a diagnostics sink', () => {
  it('an unhandled rejection in the editor window is recorded, and nothing is toasted', () => {
    const uninstall = installEditorWindowDiagnostics(window)
    try {
      const event = new Event('unhandledrejection') as Event & { reason?: unknown }
      Object.defineProperty(event, 'reason', { value: new Error('save queue exploded') })
      window.dispatchEvent(event)

      const snapshot = readFrameDiagnostics(window)
      expect(snapshot?.entries).toEqual([
        expect.objectContaining({ kind: 'unhandledRejection', code: 'runtime-unhandled-rejection' }),
      ])
      expect(snapshot!.entries[0]!.message).toContain('save queue exploded')
      expect(toasts).toEqual([])
    } finally {
      uninstall()
    }
  })
})

// ─── ERR-29 ─────────────────────────────────────────────────────────────────

describe('ERR-29 — a stale target is re-read and retried, never "Reload the project"', () => {
  it('stale-source and not-found are recovered exactly like element-moved', () => {
    const ids = elementMovedNodeIds([
      { nodeId: 'a.tsx:1:1', reason: 'element-moved' },
      { nodeId: 'a.tsx:2:1', reason: 'stale-source' },
      { nodeId: 'a.tsx:3:1', reason: 'not-found' },
      { nodeId: 'a.tsx:4:1', reason: 'out-of-scope' },
    ])
    expect([...ids]).toEqual(['a.tsx:1:1', 'a.tsx:2:1', 'a.tsx:3:1'])
  })
})
