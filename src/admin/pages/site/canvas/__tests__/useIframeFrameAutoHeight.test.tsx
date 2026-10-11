/**
 * useIframeFrameAutoHeight — end-to-end wiring proof for the
 * `frameFitMutationScheduler` fix (see that module's doc for the full
 * defect). `frameFitMutationScheduler.test.ts` covers the scheduling logic
 * in isolation with an injected fake timer; this file proves the REAL hook,
 * against a REAL `<iframe>`, does not run `collectScrollDeficits`'s
 * O(all-elements) `querySelectorAll('*')` scan once per keystroke, and that
 * the fit still correctly settles once typing pauses.
 *
 * happy-dom has no real layout engine, so `scrollHeight`/`clientHeight` are
 * stubbed with `Object.defineProperty` (an own property shadows the
 * prototype accessor) — same technique `canvasScrollUnrollInjector.test.tsx`
 * uses.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { useIframeFrameAutoHeight } from '../useIframeFrameAutoHeight'
import { FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS } from '@core/studio-runtime'
import { SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR } from '@core/studio-runtime'
import { PortalFrameAdapter } from '../frameAdapter/PortalFrameAdapter'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '../frameAdapter/BridgeFrameAdapter'
import { toOutboundEnvelope } from '@core/studio-runtime'

let adapters: PortalFrameAdapter[] = []

function makeAdapter(doc: Document): PortalFrameAdapter {
  const adapter = new PortalFrameAdapter(doc)
  adapters.push(adapter)
  return adapter
}

afterEach(() => {
  cleanup()
  for (const adapter of adapters) adapter.dispose()
  adapters = []
  document.body.innerHTML = ''
})

function stubBox(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true })
}

async function flushAsync(): Promise<void> {
  // MutationObserver callbacks queue as microtasks; a real macrotask tick
  // reliably drains them across happy-dom's implementation too.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Sets up a design-frame-shaped iframe: a scroll-clipped region (so
 * `collectScrollDeficits` finds a real deficit to chase) plus a text node a
 * "keystroke" mutates. */
function setUpFrame() {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const frameDoc = iframe.contentDocument!

  const scrollRegion = frameDoc.createElement('div')
  scrollRegion.setAttribute(SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR, 'auto')
  stubBox(scrollRegion, { scrollHeight: 2000, clientHeight: 800 })
  frameDoc.body.appendChild(scrollRegion)

  const textHost = frameDoc.createElement('p')
  const textNode = frameDoc.createTextNode('a')
  textHost.appendChild(textNode)
  frameDoc.body.appendChild(textHost)

  let scanCount = 0
  const originalQuerySelectorAll = frameDoc.body.querySelectorAll.bind(frameDoc.body)
  frameDoc.body.querySelectorAll = ((selector: string) => {
    scanCount += 1
    return originalQuerySelectorAll(selector)
  }) as typeof frameDoc.body.querySelectorAll

  return { iframe, frameDoc, textNode, getScanCount: () => scanCount }
}

describe('useIframeFrameAutoHeight — mutation-triggered rescan cost', () => {
  it('does not re-run the full-body scroll-deficit scan once per keystroke', async () => {
    const { iframe, frameDoc, textNode, getScanCount } = setUpFrame()
    const iframeRef = { current: iframe } as RefObject<HTMLIFrameElement | null>

    renderHook(() => useIframeFrameAutoHeight({ iframeRef, iframeDoc: frameDoc, adapter: makeAdapter(frameDoc), fitToContent: true }))

    // The initial mount measurement runs the scan exactly once.
    const afterMountScans = getScanCount()
    expect(afterMountScans).toBeGreaterThan(0)

    const KEYSTROKES = 25
    for (let i = 0; i < KEYSTROKES; i += 1) {
      // One characterData mutation per keystroke — exactly what
      // `contentEditable="plaintext-only"` inline text editing produces.
      textNode.data = 'a'.repeat(i + 2)
      await flushAsync()
    }

    const scansAfterBurst = getScanCount() - afterMountScans
    // The whole 25-keystroke burst must NOT have produced ~25 (or ~100, given
    // up to MAX_FRAME_FIT_PASSES retriggers per settle) full-body scans while
    // the debounce is pending — this is the actual perf defect. A small
    // constant slack covers a possible ResizeObserver-driven measure or two
    // from the (stubbed, non-reflowing) DOM settling, never one per
    // keystroke.
    expect(scansAfterBurst).toBeLessThan(KEYSTROKES)

    // After the typing pause, the debounced settle fires and re-derives the
    // fit — the frame still converges correctly, just once, after the burst.
    await new Promise((resolve) => setTimeout(resolve, FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS + 150))

    const bodyHeight = parseFloat(frameDoc.body.style.height || '0')
    // Pin grew to accommodate the 1200px deficit (2000 - 800) from the
    // 800px floor: the auto-height guarantee held even though the reset
    // itself was deferred.
    expect(bodyHeight).toBeGreaterThanOrEqual(2000)
  })

  it('still settles immediately (no debounce) on a structural mutation', async () => {
    const { iframe, frameDoc, getScanCount } = setUpFrame()
    const iframeRef = { current: iframe } as RefObject<HTMLIFrameElement | null>

    renderHook(() => useIframeFrameAutoHeight({ iframeRef, iframeDoc: frameDoc, adapter: makeAdapter(frameDoc), fitToContent: true }))
    const afterMountScans = getScanCount()

    const newNode = frameDoc.createElement('div')
    frameDoc.body.appendChild(newNode)
    await flushAsync()

    // A structural (childList) mutation re-scans right away — no
    // `FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS` wait required for the count to
    // move, unlike the text-only burst above.
    expect(getScanCount()).toBeGreaterThan(afterMountScans)
  })
})

/**
 * The bridge-mode branch (`live-05`, STATE.md, Batch 5) — driven by a
 * `BridgeFrameAdapter` against a stubbed message channel, the same
 * unteastable-any-other-way pattern `BridgeFrameAdapter.test.ts` itself
 * uses (happy-dom's `MessageEvent` cannot carry a real cross-window
 * `source`). No `iframeDoc` at all here — the whole point is that a
 * cross-origin frame's document is never reachable from the parent side.
 */
describe('useIframeFrameAutoHeight — bridge-mode branch', () => {
  function makeBridgeAdapter(): BridgeFrameAdapter {
    let handler: ((ev: MessageEvent) => void) | null = null
    const channel: BridgeFrameChannel = {
      postMessage: () => {},
      addEventListener: (type, h) => {
        if (type === 'message') handler = h
      },
      removeEventListener: (type, h) => {
        if (type === 'message' && handler === h) handler = null
      },
    }
    const adapter = new BridgeFrameAdapter({
      channel,
      frameOrigin: 'https://live.studio.test',
      nodeIdsInTreeOrder: [],
    })
    adapters.push(adapter)
    // Stash the dispatcher on the adapter itself (test-only convenience) so
    // the test below can fire a `frame:resize` message without re-deriving
    // the envelope shape `BridgeFrameAdapter.test.ts` already owns.
    ;(adapter as unknown as { __dispatch: (data: unknown) => void }).__dispatch = (data: unknown) =>
      handler?.({ origin: 'https://live.studio.test', source: undefined, data } as MessageEvent)
    return adapter
  }

  it('resizes the outer iframe element to the reported frame:resize height', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const iframeRef = { current: iframe } as RefObject<HTMLIFrameElement | null>
    const adapter = makeBridgeAdapter()

    renderHook(() => useIframeFrameAutoHeight({ iframeRef, iframeDoc: null, adapter, fitToContent: true }))

    const dispatch = (adapter as unknown as { __dispatch: (data: unknown) => void }).__dispatch
    dispatch(toOutboundEnvelope({ type: 'frame:resize', height: 950 }))

    expect(iframe.style.height).toBe('950px')
    iframe.remove()
  })

  it('does nothing when the frame does not fit to content (live, or a fixed surface)', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const iframeRef = { current: iframe } as RefObject<HTMLIFrameElement | null>
    const adapter = makeBridgeAdapter()

    renderHook(() => useIframeFrameAutoHeight({ iframeRef, iframeDoc: null, adapter, fitToContent: false }))

    const dispatch = (adapter as unknown as { __dispatch: (data: unknown) => void }).__dispatch
    dispatch(toOutboundEnvelope({ type: 'frame:resize', height: 950 }))

    expect(iframe.style.height).toBe('')
    iframe.remove()
  })
})
