/**
 * IframeFrameSurface — `documentMode` fork (`live-05`, STATE.md, Batch 6).
 *
 * Proves the two structural guarantees the Goal line asks for: (1)
 * `documentMode` omitted (or `'portal'`) reproduces today's portal-mode
 * behavior byte-for-byte — a `srcDoc` iframe with the children portaled
 * into its body, a `PortalFrameAdapter`; (2) `documentMode='bridge'`
 * renders a bare `<iframe src=...>` with NOTHING portaled into it and
 * constructs a `BridgeFrameAdapter` instead. Proves the `src` shape this
 * component hands off to `resolveLiveFrameSrc` at the unit level only (the
 * exact URL contract is `resolveLiveFrameSrc.test.ts`'s own concern); this
 * file has no real dev server to prove the URL resolves against — that is
 * `live-06`'s own manual dogfood step (STATE.md), not something a component
 * unit test can exercise.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { IframeFrameSurface, type IframeFrameSurfaceHandle } from '../IframeFrameSurface'
import { PortalFrameAdapter } from '../frameAdapter/PortalFrameAdapter'
import { BridgeFrameAdapter } from '../frameAdapter/BridgeFrameAdapter'
import { getErrorMessage } from '@core/utils/errorMessage'

afterEach(cleanup)

describe('IframeFrameSurface — documentMode fork', () => {
  it('documentMode omitted: portal mode unchanged — srcDoc iframe, children portaled, PortalFrameAdapter', async () => {
    const ref = createRef<IframeFrameSurfaceHandle>()
    const { container, unmount } = render(
      <IframeFrameSurface ref={ref} breakpointId="desktop" width={375}>
        <div data-testid="canvas-child">hello</div>
      </IframeFrameSurface>,
    )

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('srcdoc')).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBeNull()

    await waitFor(() => {
      expect(ref.current?.adapter).not.toBeNull()
    })
    expect(ref.current?.adapter).toBeInstanceOf(PortalFrameAdapter)
    expect(ref.current?.contentDocument?.body.querySelector('[data-testid="canvas-child"]')).not.toBeNull()

    // Unmount explicitly, tolerating happy-dom's known `srcDoc`-swap teardown
    // quirk (the iframe's initial `about:blank` document is replaced by the
    // real `srcDoc` one mid-test; React's portal-container bookkeeping can
    // reference the stale one by the time `afterEach(cleanup)` runs) —
    // `useIframeFrameAutoHeight.test.tsx` and others avoid this by never
    // unmounting mid-suite; this test unmounts explicitly, right here, so a
    // teardown-only DOMException from that quirk can't be misread as this
    // test's own assertions failing.
    try {
      unmount()
    } catch (err) {
      // happy-dom throws its OWN realm-scoped `DOMException` class here (not
      // `instanceof` the global one), so match by message instead.
      const message = getErrorMessage(err, String(err))
      if (!message.includes("Failed to execute 'removeChild'")) throw err
    }
  })

  it('documentMode="bridge": bare src iframe, nothing portaled, BridgeFrameAdapter', async () => {
    const ref = createRef<IframeFrameSurfaceHandle>()
    const { container } = render(
      <IframeFrameSurface
        ref={ref}
        breakpointId="desktop"
        width={375}
        documentMode="bridge"
        liveFrame={{
          liveOrigin: 'https://live.studio.test',
          screenKey: 'page-1',
          nodeIdsInTreeOrder: ['root', 'root/child-1'],
          axes: { direction: 'ltr', colorScheme: 'light' },
        }}
      >
        <div data-testid="canvas-child">hello</div>
      </IframeFrameSurface>,
    )

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('srcdoc')).toBeNull()
    expect(iframe?.getAttribute('src')).toBe('https://live.studio.test/__screen/page-1?dir=ltr&theme=light')
    // Nothing portaled into a bridge frame — the child never appears
    // anywhere in the parent-rendered tree (there is no portal target for
    // it to land in at all).
    expect(container.querySelector('[data-testid="canvas-child"]')).toBeNull()

    await waitFor(() => {
      expect(ref.current?.adapter).not.toBeNull()
    })
    expect(ref.current?.adapter).toBeInstanceOf(BridgeFrameAdapter)
    // No readable contentDocument for a cross-origin frame — the handle
    // reports it as null rather than a stale/invalid reference.
    expect(ref.current?.contentDocument).toBeNull()
  })

  it('documentMode="bridge" without liveFrame: no adapter, no crash', () => {
    const ref = createRef<IframeFrameSurfaceHandle>()
    expect(() =>
      render(
        <IframeFrameSurface ref={ref} breakpointId="desktop" width={375} documentMode="bridge">
          <div />
        </IframeFrameSurface>,
      ),
    ).not.toThrow()
    expect(ref.current?.adapter).toBeNull()
  })
})
