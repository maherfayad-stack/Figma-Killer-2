/**
 * useAdapterReady — L8 Phase A (`perf-06`, STATE.md), extracted out of
 * `LiveBoardFrame.tsx` specifically so this state machine (subscribe to
 * `adapter.on('ready', ...)`, flip once, reset on a fresh adapter) can be
 * proven against a controlled stub `FrameDocumentAdapter` — a real
 * cross-origin `ready` `postMessage` round trip isn't reachable in this test
 * environment (happy-dom's `MessageEvent` constructor can't carry a real
 * cross-window `source` — the same documented landmine
 * `BridgeFrameAdapter.test.ts` cites for testing against a stubbed channel
 * instead of a real one). `liveBoardFrame.test.tsx` covers the surrounding
 * wiring (the real `BridgeFrameAdapter`, the real resolved `src`) that this
 * file does not.
 */
import { describe, expect, it } from 'bun:test'
import { act, render, waitFor } from '@testing-library/react'
import { useAdapterReady } from '@site/canvas/BoardFramesLayer/useAdapterReady'
import type { FrameDocumentAdapter, FrameRuntimeEvent, Unsubscribe } from '@site/canvas/frameAdapter/FrameDocumentAdapter'

type ReadyHandler = (msg: Extract<FrameRuntimeEvent, { type: 'ready' }>) => void

function makeStubAdapter(): { adapter: FrameDocumentAdapter; fireReady: () => void; disposeCalls: number } {
  const readyHandlers = new Set<ReadyHandler>()
  const state = { disposeCalls: 0 }
  const adapter: FrameDocumentAdapter = {
    applyOverlay: () => {},
    removeOverlay: () => {},
    select: () => {},
    hover: () => {},
    measure: async () => [],
    setAxes: () => {},
    setInteractionMode: () => {},
    optimistic: { insert: () => {}, delete: () => {}, move: () => {}, text: () => {} },
    on: (event, handler): Unsubscribe => {
      if (event !== 'ready') return () => {}
      const readyHandler = handler as ReadyHandler
      readyHandlers.add(readyHandler)
      return () => readyHandlers.delete(readyHandler)
    },
    dispose: () => {
      state.disposeCalls += 1
    },
  }
  return {
    adapter,
    fireReady: () => {
      for (const handler of readyHandlers) handler({ type: 'ready' })
    },
    get disposeCalls() {
      return state.disposeCalls
    },
  }
}

function Probe({ adapter }: { adapter: FrameDocumentAdapter | null }) {
  const ready = useAdapterReady(adapter)
  return <span data-testid="ready">{String(ready)}</span>
}

describe('useAdapterReady', () => {
  it('starts false, flips true the instant the adapter fires ready', async () => {
    const stub = makeStubAdapter()
    const { getByTestId } = render(<Probe adapter={stub.adapter} />)

    expect(getByTestId('ready').textContent).toBe('false')
    act(() => stub.fireReady())
    await waitFor(() => {
      expect(getByTestId('ready').textContent).toBe('true')
    })
  })

  it('stays false forever when the adapter is null (no dev server, or attemptLive is false)', () => {
    const { getByTestId } = render(<Probe adapter={null} />)
    expect(getByTestId('ready').textContent).toBe('false')
  })

  it('resets to false when a fresh adapter instance replaces an already-ready one', async () => {
    const first = makeStubAdapter()
    const { getByTestId, rerender } = render(<Probe adapter={first.adapter} />)
    act(() => first.fireReady())
    await waitFor(() => {
      expect(getByTestId('ready').textContent).toBe('true')
    })

    const second = makeStubAdapter()
    rerender(<Probe adapter={second.adapter} />)
    expect(getByTestId('ready').textContent).toBe('false')

    act(() => second.fireReady())
    await waitFor(() => {
      expect(getByTestId('ready').textContent).toBe('true')
    })
  })
})
