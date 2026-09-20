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
    registerFrameAdapter(iframe, adapter)
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
    registerFrameAdapter(iframe, adapter)
    registered.push(iframe)
    disposables.push(adapter)

    broadcastOptimisticDelete('n1')

    expect(posted).toHaveLength(1)
    expect(posted[0]!.message).toMatchObject({ type: 'optimistic.delete' })
  })

  it('every registered bridge adapter receives broadcastOptimisticMove with the right args', () => {
    const { adapter, posted } = makeBridgeAdapter()
    const iframe = makeIframe()
    registerFrameAdapter(iframe, adapter)
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
    registerFrameAdapter(iframeA, first.adapter)
    registerFrameAdapter(iframeB, second.adapter)
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
    registerFrameAdapter(iframe, portalAdapter)
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
