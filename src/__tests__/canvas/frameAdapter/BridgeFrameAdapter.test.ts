/**
 * BridgeFrameAdapter — tested against a STUBBED message channel (a fake
 * `{ postMessage, addEventListener, removeEventListener }` triple this file
 * drives directly), never a real `MessageEvent`-with-real-`WindowProxy`-
 * source: `live-04`'s own landmine already documents that happy-dom's
 * `MessageEvent` constructor cannot carry a real cross-window `source`, so a
 * real cross-origin postMessage round trip is dogfood-only (see `STATE.md`'s
 * `live-05` entry, "Verification strategy"). This proves the ADAPTER's own
 * logic — message shapes, the canonical<->wire `occurrenceIndex`
 * translation, the `measure` request/response/timeout lifecycle, `dispose()`
 * rejecting in-flight promises — is correct in isolation.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { toOutboundEnvelope, type InboundEnvelope, type OutboundEnvelope } from '@core/studio-runtime'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { runFrameDocumentAdapterContract } from './frameDocumentAdapter.contract'

const FRAME_ORIGIN = 'https://live.studio.test'

interface StubChannel {
  channel: BridgeFrameChannel
  posted: InboundEnvelope[]
  /** Dispatches a raw `MessageEvent`-shaped object to whatever handler `addEventListener` captured. */
  dispatch(data: unknown, origin?: string, source?: unknown): void
}

/** `autoReplyMeasure`: immediately (next microtask) answers every posted `measure` with a `measure:result` echoing back each ref's own `nodeId`/`occurrenceIndex` and a fixed rect — enough for the shared contract suite's "measure resolves" assertion without a real frame. */
/** `announceReady` (default true): the stub frame reports `ready` the instant the adapter subscribes, the way a booted runtime does — an adapter queues every post until then. */
function makeStubChannel(options: { autoReplyMeasure?: boolean; announceReady?: boolean } = {}): StubChannel {
  let handler: ((ev: MessageEvent) => void) | null = null
  const posted: InboundEnvelope[] = []
  const channel: BridgeFrameChannel = {
    postMessage: (message, _targetOrigin) => {
      const envelope = message as InboundEnvelope
      posted.push(envelope)
      if (options.autoReplyMeasure && envelope.message.type === 'measure') {
        const { requestId, refs } = envelope.message
        const reply = toOutboundEnvelope({
          type: 'measure:result',
          requestId,
          measurements: refs.map((ref) => ({
            nodeId: ref.nodeId,
            occurrenceIndex: ref.occurrenceIndex,
            rect: { x: 0, y: 0, width: 10, height: 10 },
            computedStyle: {},
          })),
        })
        queueMicrotask(() => handler?.({ origin: FRAME_ORIGIN, source: undefined, data: reply } as MessageEvent))
      }
    },
    addEventListener: (type, h) => {
      if (type !== 'message') return
      handler = h
      if (options.announceReady !== false) h({ origin: FRAME_ORIGIN, source: undefined, data: toOutboundEnvelope({ type: 'ready' }) } as MessageEvent)
    },
    removeEventListener: (type, h) => {
      if (type === 'message' && handler === h) handler = null
    },
  }
  return {
    channel,
    posted,
    dispatch: (data, origin = FRAME_ORIGIN, source = undefined) => handler?.({ origin, source, data } as MessageEvent),
  }
}

let adapters: BridgeFrameAdapter[] = []

afterEach(() => {
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

runFrameDocumentAdapterContract('BridgeFrameAdapter', () => {
  const stub = makeStubChannel({ autoReplyMeasure: true })
  const adapter = new BridgeFrameAdapter({
    channel: stub.channel,
    frameOrigin: FRAME_ORIGIN,
    nodeIdsInTreeOrder: ['n1'],
  })
  adapters.push(adapter)
  return { adapter, existingRef: { nodeId: 'n1' }, cleanup: () => adapter.dispose() }
})

describe('BridgeFrameAdapter — canonical <-> wire occurrenceIndex translation', () => {
  it('pairs a .map()-repeated canonical id with its own tree-order index when posting select', () => {
    const stub = makeStubChannel()
    // Three canonical ids sharing one stamp (`row:1:1#0`, `#1`, `#2` -> stamp `row:1:1`).
    const adapter = new BridgeFrameAdapter({
      channel: stub.channel,
      frameOrigin: FRAME_ORIGIN,
      nodeIdsInTreeOrder: ['row:1:1#0', 'row:1:1#1', 'row:1:1#2'],
    })
    adapters.push(adapter)

    adapter.select([{ nodeId: 'row:1:1#1' }])

    const last = stub.posted.at(-1)!.message
    expect(last.type).toBe('select')
    if (last.type !== 'select') throw new Error('unreachable')
    expect(last.refs).toEqual([{ nodeId: 'row:1:1', occurrenceIndex: 1 }])
  })

  // `live-12` — a reloaded frame document boots with no mode; the parent's last declared mode follows every `ready`.
  it('re-sends the declared interaction mode when the frame says ready a second time', () => {
    const stub = makeStubChannel({ announceReady: false })
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: [] })
    adapters.push(adapter)
    adapter.setInteractionMode('design')
    const modes = () => stub.posted.map((e) => e.message).filter((m) => m.type === 'setMode').map((m) => (m as { mode: string }).mode)
    expect(modes()).toEqual([])
    stub.dispatch(toOutboundEnvelope({ type: 'ready' }))
    expect(modes()).toEqual(['design'])
    stub.dispatch(toOutboundEnvelope({ type: 'ready' }))
    expect(modes()).toEqual(['design', 'design'])
  })

  // `live-12` — the wheel gesture a design-mode frame forwards so the parent canvas can zoom.
  it('emits a wheel event for the runtime\'s wheel message, numbers and modifiers intact', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: [] })
    adapters.push(adapter)

    const received: unknown[] = []
    adapter.on('wheel', (msg) => received.push(msg))
    stub.dispatch(
      toOutboundEnvelope({
        type: 'wheel',
        deltaX: 3,
        deltaY: -120,
        deltaMode: 0,
        clientX: 40,
        clientY: 60,
        modifiers: { shiftKey: false, altKey: false, ctrlKey: true, metaKey: false },
      }),
    )
    expect(received).toEqual([
      { type: 'wheel', deltaX: 3, deltaY: -120, deltaMode: 0, clientX: 40, clientY: 60, modifiers: { shiftKey: false, altKey: false, ctrlKey: true, metaKey: false } },
    ])
  })

  // `live-12` — a click inside a design-system button is stamped with the package's own source position.
  it('resolves a pointer hit to the innermost stamped ancestor the page tree knows', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['pages/Home.tsx:10:6', 'pages/Home.tsx:12:8'] })
    adapters.push(adapter)
    const received: Array<string | null> = []
    adapter.on('pointer', (msg) => received.push(msg.nodeId))
    stub.dispatch(
      toOutboundEnvelope({
        type: 'pointer',
        phase: 'click',
        nodeId: 'design-system/components/Button.jsx:101:26',
        occurrenceIndex: 0,
        rect: null,
        clientX: 0,
        clientY: 0,
        modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },

        button: 0,

        buttons: 1,

        pointerId: 1,

        pointerType: 'mouse',
        ancestors: [
          { nodeId: 'design-system/components/Button.jsx:101:26', occurrenceIndex: 0 },
          { nodeId: 'design-system/components/Button.jsx:90:4', occurrenceIndex: 0 },
          { nodeId: 'pages/Home.tsx:12:8', occurrenceIndex: 0 },
          { nodeId: 'pages/Home.tsx:10:6', occurrenceIndex: 0 },
        ],
      }),
    )
    expect(received).toEqual(['pages/Home.tsx:12:8'])
  })

  it('resolves an inbound pointer event back to the correct canonical row, not always row 0', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({
      channel: stub.channel,
      frameOrigin: FRAME_ORIGIN,
      nodeIdsInTreeOrder: ['row:1:1#0', 'row:1:1#1', 'row:1:1#2'],
    })
    adapters.push(adapter)

    const received: Array<string | null> = []
    adapter.on('pointer', (msg) => received.push(msg.nodeId))

    const envelope: OutboundEnvelope = toOutboundEnvelope({
      type: 'pointer',
      phase: 'click',
      nodeId: 'row:1:1',
      occurrenceIndex: 2,
      rect: null,
      clientX: 0,
      clientY: 0,
      modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },

      button: 0,

      buttons: 1,

      pointerId: 1,

      pointerType: 'mouse',
      ancestors: [],
    })
    stub.dispatch(envelope)

    expect(received).toEqual(['row:1:1#2'])
  })

  it('falls back to the bare stamp id, unresolved, for an occurrence index with no tree-order candidate', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['x:1:1'] })
    adapters.push(adapter)

    const received: Array<string | null> = []
    adapter.on('pointer', (msg) => received.push(msg.nodeId))

    stub.dispatch(
      toOutboundEnvelope({
        type: 'pointer',
        phase: 'click',
        nodeId: 'x:1:1',
        occurrenceIndex: 5,
        rect: null,
        clientX: 0,
        clientY: 0,
        modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },

        button: 0,

        buttons: 1,

        pointerId: 1,

        pointerType: 'mouse',
        ancestors: [],
      }),
    )

    expect(received).toEqual(['x:1:1'])
  })

  // `live-13` — the resize target crosses the wire as a stamp + occurrence, and the commit comes back canonical.
  it('setResizeTarget posts the wire ref for a .map() row, and null to clear', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['row:1:1#0', 'row:1:1#1'] })
    adapters.push(adapter)
    adapter.setResizeTarget({ nodeId: 'row:1:1#1' }, { proportional: true })
    adapter.setResizeTarget(null, { proportional: false })
    const last = stub.posted.slice(-2).map((e) => e.message)
    expect(last).toEqual([
      { type: 'setResizeTarget', ref: { nodeId: 'row:1:1', occurrenceIndex: 1 }, proportional: true },
      { type: 'setResizeTarget', ref: null, proportional: false },
    ])
  })

  it('emits an inbound resize:commit with the canonical row id and the patch untouched', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['row:1:1#0', 'row:1:1#1'] })
    adapters.push(adapter)
    const received: unknown[] = []
    adapter.on('resize:commit', (msg) => received.push(msg))
    stub.dispatch(toOutboundEnvelope({ type: 'resize:commit', nodeId: 'row:1:1', occurrenceIndex: 1, patch: { width: '240px', height: '96px' } }))
    expect(received).toEqual([{ type: 'resize:commit', nodeId: 'row:1:1#1', patch: { width: '240px', height: '96px' } }])
  })

  // `speed-01` — a properties-panel style commit/preview, translated the same
  // canonical -> wire way every other optimistic op is.
  it('optimistic.style posts the wire ref and patch untouched, with className carried through when present', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['row:1:1#0', 'row:1:1#1'] })
    adapters.push(adapter)

    adapter.optimistic.style('row:1:1#1', { color: 'red' })
    adapter.optimistic.style('row:1:1#0', { color: 'blue' }, 'card')

    const last = stub.posted.slice(-2).map((e) => e.message)
    expect(last).toEqual([
      { type: 'optimistic.style', ref: { nodeId: 'row:1:1', occurrenceIndex: 1 }, patch: { color: 'red' } },
      { type: 'optimistic.style', ref: { nodeId: 'row:1:1', occurrenceIndex: 0 }, patch: { color: 'blue' }, className: 'card' },
    ])
  })

  it('optimistic.clearStyle posts an optimistic.style:clear with the wire ref', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['row:1:1#0', 'row:1:1#1'] })
    adapters.push(adapter)

    adapter.optimistic.clearStyle('row:1:1#1')

    expect(stub.posted.at(-1)!.message).toEqual({ type: 'optimistic.style:clear', ref: { nodeId: 'row:1:1', occurrenceIndex: 1 } })
  })

  it('setNodeIds rebuilds the index so a later select uses the new tree order', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['row:1:1#0'] })
    adapters.push(adapter)

    adapter.setNodeIds(['row:1:1#0', 'row:1:1#1'])
    adapter.select([{ nodeId: 'row:1:1#1' }])

    const last = stub.posted.at(-1)!.message
    if (last.type !== 'select') throw new Error('unreachable')
    expect(last.refs).toEqual([{ nodeId: 'row:1:1', occurrenceIndex: 1 }])
  })
})

describe('BridgeFrameAdapter — measure lifecycle', () => {
  it('resolves with the requested measurements once measure:result arrives', async () => {
    const stub = makeStubChannel({ autoReplyMeasure: true })
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    const [measurement] = await adapter.measure([{ nodeId: 'n1' }])
    expect(measurement!.nodeId).toBe('n1')
    expect(measurement!.rect).toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })

  it('rejects if the timeout elapses with no reply', async () => {
    const stub = makeStubChannel() // no auto-reply
    const adapter = new BridgeFrameAdapter({
      channel: stub.channel,
      frameOrigin: FRAME_ORIGIN,
      nodeIdsInTreeOrder: ['n1'],
      measureTimeoutMs: 5,
    })
    adapters.push(adapter)

    await expect(adapter.measure([{ nodeId: 'n1' }])).rejects.toThrow()
  })

  it('dispose() rejects any in-flight measure promise', async () => {
    const stub = makeStubChannel() // no auto-reply
    const adapter = new BridgeFrameAdapter({
      channel: stub.channel,
      frameOrigin: FRAME_ORIGIN,
      nodeIdsInTreeOrder: ['n1'],
      measureTimeoutMs: 60_000,
    })

    const pending = adapter.measure([{ nodeId: 'n1' }])
    adapter.dispose()

    await expect(pending).rejects.toThrow()
  })
})

describe('BridgeFrameAdapter — origin/source checks', () => {
  it('ignores an inbound message from the wrong origin', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    const received: unknown[] = []
    adapter.on('ready', (msg) => received.push(msg))

    stub.dispatch(toOutboundEnvelope({ type: 'ready' }), 'https://attacker.test')

    expect(received).toHaveLength(0)
  })

  it('ignores an inbound message from a source other than the expected one', () => {
    const stub = makeStubChannel()
    const expectedSource = { marker: 'real-frame' }
    const adapter = new BridgeFrameAdapter({
      channel: stub.channel,
      frameOrigin: FRAME_ORIGIN,
      expectedSource,
      nodeIdsInTreeOrder: ['n1'],
    })
    adapters.push(adapter)

    const received: unknown[] = []
    adapter.on('ready', (msg) => received.push(msg))

    stub.dispatch(toOutboundEnvelope({ type: 'ready' }), FRAME_ORIGIN, { marker: 'attacker' })

    expect(received).toHaveLength(0)
  })

  it('ignores a malformed payload without throwing', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    expect(() => stub.dispatch('not an object')).not.toThrow()
    expect(() => stub.dispatch({ direction: 'to-parent' })).not.toThrow()
  })

  it('ignores a same-shaped message missing the envelope source tag (a stray postMessage sender, not the runtime)', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    const received: unknown[] = []
    adapter.on('ready', (msg) => received.push(msg))

    // Same `direction`/`message` shape as a real envelope, but no `source`
    // tag — e.g. React DevTools, a browser extension, or a forged message
    // from a co-resident script that doesn't know the exact tag value.
    stub.dispatch({ direction: 'to-parent', message: { type: 'ready' } })

    expect(received).toHaveLength(0)
  })

  it('ignores an outbound message whose payload fails TypeBox validation, even with a correct source/direction tag', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    const heights: number[] = []
    adapter.on('frame:resize', (msg) => heights.push(msg.height))

    // A same-realm co-resident script (sec-06's "same-realm spoofing" note)
    // can forge the envelope tags exactly, but the payload itself must still
    // pass schema validation before any handler reads a field off it.
    stub.dispatch({ source: 'studio-live-runtime', direction: 'to-parent', message: { type: 'frame:resize', height: 'not-a-number' } })
    stub.dispatch({ source: 'studio-live-runtime', direction: 'to-parent', message: { type: 'frame:resize', height: -1 } })
    stub.dispatch({ source: 'studio-live-runtime', direction: 'to-parent', message: { type: 'not-a-real-message-type' } })

    expect(heights).toHaveLength(0)
  })
})

describe('BridgeFrameAdapter — frame:resize', () => {
  it('forwards an inbound frame:resize event to on() subscribers', () => {
    const stub = makeStubChannel()
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    const heights: number[] = []
    adapter.on('frame:resize', (msg) => heights.push(msg.height))

    stub.dispatch(toOutboundEnvelope({ type: 'frame:resize', height: 842 }))

    expect(heights).toEqual([842])
  })
})

describe('BridgeFrameAdapter — nothing is posted before the frame is ready', () => {
  it('queues every post until the frame reports ready, then flushes them in order', () => {
    const stub = makeStubChannel({ announceReady: false })
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    adapter.applyOverlay('sel', '.x{}')
    adapter.hover(null)
    adapter.select([{ nodeId: 'n1' }])
    expect(stub.posted).toHaveLength(0)

    stub.dispatch(toOutboundEnvelope({ type: 'ready' }), FRAME_ORIGIN)
    expect(stub.posted.map((envelope) => envelope.message.type)).toEqual(['applyOverlay', 'hover', 'select'])

    adapter.removeOverlay('sel')
    expect(stub.posted.at(-1)!.message.type).toBe('removeOverlay')
  })

  it('a ready from the wrong origin flushes nothing', () => {
    const stub = makeStubChannel({ announceReady: false })
    const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
    adapters.push(adapter)

    adapter.hover(null)
    stub.dispatch(toOutboundEnvelope({ type: 'ready' }), 'https://attacker.test')
    expect(stub.posted).toHaveLength(0)
  })
})
