/**
 * optimisticStructuralBroadcast — `live-07` (STATE.md). Exercised against
 * real `BridgeFrameAdapter`/`PortalFrameAdapter` instances registered in the
 * real `canvasFrameAdapterRegistry`, the same stubbed
 * `{ postMessage, addEventListener }` channel pattern `BridgeFrameAdapter
 * .test.ts` already establishes for the bridge side.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { InboundEnvelope } from '@core/studio-runtime'
import { toOutboundEnvelope } from '@core/studio-runtime'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import {
  broadcastOptimisticDelete,
  broadcastOptimisticInsert,
  broadcastOptimisticMove,
  broadcastOptimisticStyle,
  broadcastOptimisticStyleClear,
} from '@site/canvas/frameAdapter/optimisticStructuralBroadcast'

const FRAME_ORIGIN = 'https://live.studio.test'

function makeBridgeAdapter(): { adapter: BridgeFrameAdapter; posted: InboundEnvelope[] } {
  let handler: ((ev: MessageEvent) => void) | null = null
  const posted: InboundEnvelope[] = []
  const channel: BridgeFrameChannel = {
    postMessage: (message) => posted.push(message as InboundEnvelope),
    addEventListener: (type, h) => {
      if (type !== 'message') return
      handler = h
      // A booted runtime reports `ready` first; the adapter queues every post until it does.
      h({ origin: FRAME_ORIGIN, source: undefined, data: toOutboundEnvelope({ type: 'ready' }) } as MessageEvent)
    },
    removeEventListener: (type, h) => {
      if (type === 'message' && handler === h) handler = null
    },
  }
  const adapter = new BridgeFrameAdapter({ channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
  return { adapter, posted }
}

function makeIframe(): HTMLIFrameElement {
  return document.createElement('iframe')
}

const registered: HTMLIFrameElement[] = []
const disposables: Array<{ dispose(): void }> = []

afterEach(() => {
  for (const iframe of registered) unregisterFrameAdapter(iframe)
  registered.length = 0
  for (const d of disposables) d.dispose()
  disposables.length = 0
})

describe('optimisticStructuralBroadcast', () => {
  it('every registered bridge adapter receives broadcastOptimisticInsert with the right args', () => {
    const { adapter, posted } = makeBridgeAdapter()
    const iframe = makeIframe()
    registerFrameAdapter(iframe, adapter, 'desktop')
    registered.push(iframe)
    disposables.push(adapter)

    broadcastOptimisticInsert('optimistic:1', 'parent-1', 2, 'div', 'hi')

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({
      type: 'optimistic.insert',
      parentNodeId: 'parent-1',
      index: 2,
      tagName: 'div',
      text: 'hi',
    })
  })

  it('every registered bridge adapter receives broadcastOptimisticDelete with the right args', () => {
    const { adapter, posted } = makeBridgeAdapter()
    const iframe = makeIframe()
    registerFrameAdapter(iframe, adapter, 'desktop')
    registered.push(iframe)
    disposables.push(adapter)

    broadcastOptimisticDelete('n1')

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({ type: 'optimistic.delete' })
  })

  it('every registered bridge adapter receives broadcastOptimisticMove with the right args', () => {
    const { adapter, posted } = makeBridgeAdapter()
    const iframe = makeIframe()
    registerFrameAdapter(iframe, adapter, 'desktop')
    registered.push(iframe)
    disposables.push(adapter)

    broadcastOptimisticMove('n1', 'parent-2', 3)

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({ type: 'optimistic.move', parentNodeId: 'parent-2', index: 3 })
  })

  it('broadcasts to every registered bridge adapter, not just one', () => {
    const first = makeBridgeAdapter()
    const second = makeBridgeAdapter()
    const iframeA = makeIframe()
    const iframeB = makeIframe()
    registerFrameAdapter(iframeA, first.adapter, 'desktop')
    registerFrameAdapter(iframeB, second.adapter, 'desktop')
    registered.push(iframeA, iframeB)
    disposables.push(first.adapter, second.adapter)

    broadcastOptimisticDelete('n1')

    expect(first.posted).toHaveLength(1)
    expect(second.posted).toHaveLength(1)
  })

  it('a registered PortalFrameAdapter receives nothing', () => {
    const doc = document.implementation.createHTMLDocument('portal')
    doc.body.innerHTML = `<div data-node-id="n1"></div>`
    const portalAdapter = new PortalFrameAdapter(doc)
    const iframe = makeIframe()
    registerFrameAdapter(iframe, portalAdapter, 'desktop')
    registered.push(iframe)
    disposables.push(portalAdapter)

    // If this reached the portal adapter's own `optimistic.delete`, the node
    // would be removed from `doc`.
    broadcastOptimisticDelete('n1')

    expect(doc.querySelector('[data-node-id="n1"]')).not.toBeNull()
  })

  it('zero registered adapters is a silent no-op', () => {
    expect(() => {
      broadcastOptimisticInsert('optimistic:1', 'parent-1', 0, 'div')
      broadcastOptimisticDelete('n1')
      broadcastOptimisticMove('n1', 'parent-1', 0)
    }).not.toThrow()
  })
})

// `speed-01` — a breakpoint-context write must reach only the bridge
// frame(s) rendering that breakpoint; a base write (no `breakpointId`
// option) still reaches every bridge frame. Found live: the coordinator's
// second measurement showed a breakpoint-context edit sending NO message at
// all, because `commitApi.ts` used to skip broadcasting for any non-null
// active context (breakpoint or condition) — a live board frame IS a
// breakpoint frame, so that removed the preview from its main use case.
describe('optimisticStructuralBroadcast — breakpoint-scoped style writes', () => {
  it('a base write (no breakpointId option) reaches every registered bridge frame, regardless of each one\'s own breakpoint', () => {
    const desktop = makeBridgeAdapter()
    const mobile = makeBridgeAdapter()
    const iframeDesktop = makeIframe()
    const iframeMobile = makeIframe()
    registerFrameAdapter(iframeDesktop, desktop.adapter, 'desktop')
    registerFrameAdapter(iframeMobile, mobile.adapter, 'mobile')
    registered.push(iframeDesktop, iframeMobile)
    disposables.push(desktop.adapter, mobile.adapter)

    broadcastOptimisticStyle('n1', { color: 'red' })

    expect(desktop.posted).toHaveLength(1)
    expect(mobile.posted).toHaveLength(1)
  })

  it('a breakpoint-context write reaches only the bridge frame(s) rendering that breakpoint', () => {
    const desktop = makeBridgeAdapter()
    const mobile = makeBridgeAdapter()
    const tablet = makeBridgeAdapter()
    const iframeDesktop = makeIframe()
    const iframeMobile = makeIframe()
    const iframeTablet = makeIframe()
    registerFrameAdapter(iframeDesktop, desktop.adapter, 'desktop')
    registerFrameAdapter(iframeMobile, mobile.adapter, 'mobile')
    registerFrameAdapter(iframeTablet, tablet.adapter, 'tablet')
    registered.push(iframeDesktop, iframeMobile, iframeTablet)
    disposables.push(desktop.adapter, mobile.adapter, tablet.adapter)

    broadcastOptimisticStyle('n1', { color: 'red' }, { breakpointId: 'mobile' })

    expect(desktop.posted).toHaveLength(0)
    expect(mobile.posted).toHaveLength(1)
    expect(tablet.posted).toHaveLength(0)
  })

  it('a second bridge frame that ALSO renders the same breakpoint receives it too', () => {
    const mobileA = makeBridgeAdapter()
    const mobileB = makeBridgeAdapter()
    const iframeA = makeIframe()
    const iframeB = makeIframe()
    registerFrameAdapter(iframeA, mobileA.adapter, 'mobile')
    registerFrameAdapter(iframeB, mobileB.adapter, 'mobile')
    registered.push(iframeA, iframeB)
    disposables.push(mobileA.adapter, mobileB.adapter)

    broadcastOptimisticStyle('n1', { color: 'red' }, { breakpointId: 'mobile' })

    expect(mobileA.posted).toHaveLength(1)
    expect(mobileB.posted).toHaveLength(1)
  })

  it('never called for a state/condition context — commitApi.ts skips the broadcast entirely, not this function', () => {
    // This function has no "state context" concept of its own — the skip
    // lives one layer up, in `commitApi.ts` (see its own `onCondition`
    // guard). Documented here as a contract: `broadcastOptimisticStyle` MUST
    // NOT be given a synthetic "condition" breakpointId to approximate a
    // skip — every `breakpointId` it receives names a real bridge frame's
    // own breakpoint, or is omitted entirely.
    const adapter = makeBridgeAdapter()
    const iframe = makeIframe()
    registerFrameAdapter(iframe, adapter.adapter, 'desktop')
    registered.push(iframe)
    disposables.push(adapter.adapter)

    // A `breakpointId` naming a breakpoint nothing renders is indistinguishable,
    // from this function's point of view, from "nothing currently matches" —
    // exactly the no-op a caller gets by not calling it at all.
    broadcastOptimisticStyle('n1', { color: 'red' }, { breakpointId: 'not-a-real-breakpoint' })

    expect(adapter.posted).toHaveLength(0)
  })

  it('carries className through untouched (informational only — see optimisticStyle.ts)', () => {
    const adapter = makeBridgeAdapter()
    const iframe = makeIframe()
    registerFrameAdapter(iframe, adapter.adapter, 'desktop')
    registered.push(iframe)
    disposables.push(adapter.adapter)

    broadcastOptimisticStyle('n1', { color: 'red' }, { className: 'card', breakpointId: 'desktop' })

    expect(adapter.posted[0]!.message).toMatchObject({ type: 'optimistic.style', patch: { color: 'red' }, className: 'card' })
  })

  it('broadcastOptimisticStyleClear reaches every registered bridge frame unconditionally', () => {
    const desktop = makeBridgeAdapter()
    const mobile = makeBridgeAdapter()
    const iframeDesktop = makeIframe()
    const iframeMobile = makeIframe()
    registerFrameAdapter(iframeDesktop, desktop.adapter, 'desktop')
    registerFrameAdapter(iframeMobile, mobile.adapter, 'mobile')
    registered.push(iframeDesktop, iframeMobile)
    disposables.push(desktop.adapter, mobile.adapter)

    broadcastOptimisticStyleClear('n1')

    expect(desktop.posted).toHaveLength(1)
    expect(mobile.posted).toHaveLength(1)
    expect(desktop.posted[0]!.message).toMatchObject({ type: 'optimistic.style:clear' })
  })
})
