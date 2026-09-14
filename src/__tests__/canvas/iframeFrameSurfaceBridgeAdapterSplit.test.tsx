/**
 * `live-07` (STATE.md) — `IframeFrameSurface`'s bridge-adapter construct/
 * reconcile split.
 *
 * Before this, the bridge-adapter effect was keyed on `[documentMode,
 * iframeDoc, liveFrame]` — and `liveFrame` is a NEW OBJECT on every render
 * where `nodeIdsInTreeOrder` changed (every structural resync re-parses and
 * re-mints the active page's node id list), so every resync disposed the
 * whole `BridgeFrameAdapter` and constructed a fresh one, dropping every
 * pending `measure()` promise, event subscription, and the adapter's own
 * identity for no reason.
 *
 * These two tests pin the fix: a construct effect keyed on
 * `liveOrigin`/`screenKey` only, plus a second, smaller effect that calls
 * the already-shipped-but-never-called `adapter.setNodeIds(...)` when only
 * the id list changed.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { IframeFrameSurface, type IframeFrameSurfaceHandle } from '@site/canvas/IframeFrameSurface'
import { BridgeFrameAdapter } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import type { LiveFrameSource } from '@site/canvas/resolveLiveFrameSrc'

afterEach(() => cleanup())

function liveFrame(overrides: Partial<LiveFrameSource> = {}): LiveFrameSource {
  return {
    liveOrigin: 'https://live.studio.test',
    screenKey: 'home',
    nodeIdsInTreeOrder: ['n1'],
    axes: { direction: 'ltr', colorScheme: 'light' },
    ...overrides,
  }
}

describe('IframeFrameSurface — bridge adapter construct/reconcile split', () => {
  it('changing only nodeIdsInTreeOrder calls setNodeIds and does NOT construct a new adapter', async () => {
    const setNodeIdsSpy = spyOn(BridgeFrameAdapter.prototype, 'setNodeIds')
    const ref = createRef<IframeFrameSurfaceHandle>()

    const { rerender } = render(
      <IframeFrameSurface ref={ref} breakpointId="desktop" width={1200} documentMode="bridge" liveFrame={liveFrame()}>
        <div />
      </IframeFrameSurface>,
    )
    await act(async () => {})
    const firstAdapter = ref.current?.adapter
    expect(firstAdapter).toBeInstanceOf(BridgeFrameAdapter)

    rerender(
      <IframeFrameSurface
        ref={ref}
        breakpointId="desktop"
        width={1200}
        documentMode="bridge"
        liveFrame={liveFrame({ nodeIdsInTreeOrder: ['n1', 'n2'] })}
      >
        <div />
      </IframeFrameSurface>,
    )
    await act(async () => {})

    expect(ref.current?.adapter).toBe(firstAdapter)
    expect(setNodeIdsSpy).toHaveBeenCalledWith(['n1', 'n2'])
    setNodeIdsSpy.mockRestore()
  })

  it('changing liveOrigin/screenKey constructs a fresh adapter', async () => {
    const ref = createRef<IframeFrameSurfaceHandle>()

    const { rerender } = render(
      <IframeFrameSurface ref={ref} breakpointId="desktop" width={1200} documentMode="bridge" liveFrame={liveFrame()}>
        <div />
      </IframeFrameSurface>,
    )
    await act(async () => {})
    const firstAdapter = ref.current?.adapter

    rerender(
      <IframeFrameSurface
        ref={ref}
        breakpointId="desktop"
        width={1200}
        documentMode="bridge"
        liveFrame={liveFrame({ screenKey: 'about' })}
      >
        <div />
      </IframeFrameSurface>,
    )
    await act(async () => {})

    expect(ref.current?.adapter).not.toBe(firstAdapter)
    expect(ref.current?.adapter).toBeInstanceOf(BridgeFrameAdapter)
  })
})
