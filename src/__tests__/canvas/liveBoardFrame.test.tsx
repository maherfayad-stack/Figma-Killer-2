/**
 * LiveBoardFrame — L8 Phase A (`perf-06`, STATE.md).
 *
 * Proves the three-way not-ready/ready render fork the design specifies:
 * poster cached, no poster cached, and the real `ready` swap — driven by a
 * REAL `BridgeFrameAdapter` constructed by the real `IframeFrameSurface`
 * (only `useLiveOrigin`/`useDevServerReadiness` are stubbed, so this proves
 * the actual wiring, not a mocked stand-in for it).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { resolveLiveFrameSrc } from '@site/canvas/resolveLiveFrameSrc'
import { setFramePoster } from '@site/canvas/BoardFramesLayer/frameSnapshotCache'
import { setStudioProjectKey } from '@site/studio/studioProjectTrust'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const BARE_LIVE_ORIGIN = 'https://live.studio.test'
const PROJECT_KEY = 'dogfood-project'
// `LiveBoardFrame` joins `useLiveOrigin`'s bare origin with `studioProjectTrust`'s
// `projectKey` into `/p/<projectKey>` — see that component's own doc.
const LIVE_ORIGIN = `${BARE_LIVE_ORIGIN}/p/${PROJECT_KEY}`

// `mock.module` is GLOBAL to the whole `bun test` process, not scoped to this
// file, and it is not undone when this file finishes. Both stubs below replace
// modules that other files test FOR REAL — `useDevServerReadiness.test.tsx`
// imported this file's stub and watched a hook that never polls, which is
// exactly the "the poll loop is broken" symptom it exists to catch. Capture
// the real implementations first (destructured, so the values survive the
// registry being replaced) and put them back in `afterAll`.
const { useLiveOrigin: realUseLiveOrigin } = await import('@site/studio/useLiveOrigin')
const {
  useDevServerReadiness: realUseDevServerReadiness,
  nextPollDelayMs: realNextPollDelayMs,
  POLL_INTERVAL_START_MS: realPollIntervalStartMs,
  POLL_INTERVAL_MAX_MS: realPollIntervalMaxMs,
  __resetDevServerReadinessForTests: realResetDevServerReadiness,
} = await import('@site/studio/useDevServerReadiness')

mock.module('@site/studio/useLiveOrigin', () => ({
  useLiveOrigin: () => BARE_LIVE_ORIGIN,
}))
mock.module('@site/studio/useDevServerReadiness', () => ({
  useDevServerReadiness: () => ({ phase: 'ready' as const, log: '' }),
}))

afterAll(() => {
  mock.module('@site/studio/useLiveOrigin', () => ({ useLiveOrigin: realUseLiveOrigin }))
  mock.module('@site/studio/useDevServerReadiness', () => ({
    useDevServerReadiness: realUseDevServerReadiness,
    nextPollDelayMs: realNextPollDelayMs,
    POLL_INTERVAL_START_MS: realPollIntervalStartMs,
    POLL_INTERVAL_MAX_MS: realPollIntervalMaxMs,
    __resetDevServerReadinessForTests: realResetDevServerReadiness,
  }))
})

const { LiveBoardFrame } = await import('@site/canvas/BoardFramesLayer/LiveBoardFrame')

const BREAKPOINT = { id: 'studio', label: 'Studio', mediaQuery: '(max-width: 1024px)', width: 800 }
const WIDTH = 800

// `projectKey` starts null (Tier 0/1 default) — every test in this file
// exercises the Tier-2 `LiveBoardFrame`, so it needs a real key before each
// `render()`, matching what a real `/load` response sets via `loadSite`.
beforeEach(() => setStudioProjectKey(PROJECT_KEY))
afterEach(() => {
  cleanup()
  setStudioProjectKey(null)
  // The selection-chrome test below sets store state other tests in this
  // file don't expect — reset it so it can't leak into them.
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeBreakpointId: null,
    selectedNodeIds: [],
    selectedNodeId: null,
    selectedNodeFrameId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('LiveBoardFrame — not-ready render fork', () => {
  it('no poster cached: shows the Tier-0 portal fallback, bridge iframe mounted but hidden', async () => {
    const page = makePage({ id: 'onboarding' })
    const { container } = render(
      <LiveBoardFrame
        page={page}
        breakpoint={BREAKPOINT}
        isActive={false}
        onActivate={() => {}}
        frameId="frame-1"
        width={WIDTH}
      />,
    )

    // The Tier-0 fallback is a real portal BreakpointFrame — a `srcdoc`
    // iframe, same as any Tier 0/1 board frame.
    const fallbackIframe = container.querySelector('iframe[srcdoc]')
    expect(fallbackIframe).not.toBeNull()
    expect(container.querySelector('[data-testid="board-frame-poster"]')).toBeNull()

    // The bridge iframe is mounted (booting concurrently) but hidden.
    const bridgeContainer = container.querySelector('[data-testid="live-board-frame-bridge"]')
    expect(bridgeContainer).not.toBeNull()
    expect(bridgeContainer?.hasAttribute('hidden')).toBe(true)
    await waitFor(() => {
      expect(bridgeContainer?.querySelector('iframe[src]')).not.toBeNull()
    })
  })

  it('poster cached: shows the poster instead of a second live portal render', async () => {
    const page = makePage({ id: 'sms' })
    setFramePoster(page, WIDTH, 'data:image/png;base64,AAAA')

    const { container } = render(
      <LiveBoardFrame
        page={page}
        breakpoint={BREAKPOINT}
        isActive={false}
        onActivate={() => {}}
        frameId="frame-2"
        width={WIDTH}
      />,
    )

    expect(container.querySelector('[data-testid="board-frame-poster"]')).not.toBeNull()
    // No SECOND portal render underneath the poster.
    expect(container.querySelector('iframe[srcdoc]')).toBeNull()

    const bridgeContainer = container.querySelector('[data-testid="live-board-frame-bridge"]')
    expect(bridgeContainer?.hasAttribute('hidden')).toBe(true)
  })

  it('the mounted bridge iframe already carries the correct resolved src, before it ever becomes ready', async () => {
    const page = makePage({ id: 'sign-up' })
    const { container } = render(
      <LiveBoardFrame
        page={page}
        breakpoint={BREAKPOINT}
        isActive={false}
        onActivate={() => {}}
        frameId="frame-3"
        width={WIDTH}
      />,
    )

    const bridgeIframe = await waitFor(() => {
      const iframe = container.querySelector(
        '[data-testid="live-board-frame-bridge"] iframe[src]',
      ) as HTMLIFrameElement | null
      expect(iframe).not.toBeNull()
      return iframe!
    })
    expect(bridgeIframe.getAttribute('src')).toBe(
      resolveLiveFrameSrc({
        liveOrigin: LIVE_ORIGIN,
        screenKey: page.id,
        nodeIdsInTreeOrder: Object.keys(page.nodes),
        axes: { direction: 'ltr', colorScheme: 'light' },
      }),
    )
  })
})

describe('LiveBoardFrame — selection chrome while not ready (speed-04)', () => {
  it('an already-selected node shows exactly ONE toolbar/inspector — the fallback\'s, never the hidden bridge overlay\'s', async () => {
    const button = makeNode({ id: 'cta-button', moduleId: 'base.button' })
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [button.id] })
    const page = makePage({
      id: 'checkout',
      rootNodeId: root.id,
      nodes: { [root.id]: root, [button.id]: button },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
      activeBreakpointId: BREAKPOINT.id,
      // Selected before mount — the click that produced this selection
      // landed on THIS frame (frameId matches), same as a real board click.
      selectedNodeIds: [button.id],
      selectedNodeId: button.id,
      selectedNodeFrameId: 'frame-1',
    } as Parameters<typeof useEditorStore.setState>[0])

    render(
      <LiveBoardFrame
        page={page}
        breakpoint={BREAKPOINT}
        isActive={false}
        onActivate={() => {}}
        frameId="frame-1"
        width={WIDTH}
      />,
    )

    // The Tier-0 fallback's own overlay is real and working: its ring
    // lands inside ITS OWN iframe document (WS-5.1).
    const fallbackIframe = await waitFor(() => {
      const el = document.querySelector('iframe[srcdoc]') as HTMLIFrameElement | null
      expect(el?.contentDocument?.body).toBeTruthy()
      return el!
    })
    await waitFor(() => {
      expect(
        fallbackIframe.contentDocument!.querySelector('[data-canvas-selection-ring]'),
      ).not.toBeNull()
    })

    // Exactly one toolbar and one inspector wrapper in the whole document —
    // not two. Before this change the hidden bridge frame's OWN overlay
    // (bridgeChrome=true, `useBridgeSelectionChrome`) mounted unconditionally
    // and rendered a second, independently-positioned copy of both for the
    // SAME selection the instant it received a non-empty `selectedNodeIds`.
    expect(document.querySelectorAll('[data-canvas-selection-toolbar]').length).toBe(1)
    expect(document.querySelectorAll('[data-canvas-in-place-inspector]').length).toBe(1)

    // The hidden bridge container mounted its iframe (booting concurrently)
    // but carries no overlay chrome of its own while not ready.
    const bridgeContainer = document.querySelector('[data-testid="live-board-frame-bridge"]')
    expect(bridgeContainer?.querySelector('[data-canvas-selection-toolbar]')).toBeNull()
    expect(bridgeContainer?.querySelector('[data-canvas-in-place-inspector]')).toBeNull()
  })
})

// The `ready` swap itself — see `useAdapterReady.test.tsx`. happy-dom's
// `MessageEvent` constructor cannot carry a real cross-window `source`
// (the SAME documented landmine `BridgeFrameAdapter.test.ts` cites for why
// IT drives a stubbed channel instead of a real `postMessage` round trip),
// so firing a genuine `ready` message through this component's REAL
// `BridgeFrameAdapter` isn't possible in this test environment — only a
// real browser dogfood can prove that leg end to end (see this ticket's
// STATE.md handoff). The sibling file proves `LiveBoardFrame`'s OWN
// not-ready/ready render-fork logic against a controlled stub adapter
// instead.
