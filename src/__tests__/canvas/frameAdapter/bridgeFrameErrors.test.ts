/**
 * Z5, parent side — the outbound `error` message, from the wire to a
 * `FrameRuntimeEvent`.
 *
 * Same stubbed-channel posture as `BridgeFrameAdapter.test.ts` (`live-04`'s
 * landmine: happy-dom cannot construct a `MessageEvent` carrying a real
 * cross-window `source`, so a real round trip is dogfood-only). Its own file
 * rather than an appendix to that one because the half worth protecting here is
 * the SCHEMA BOUND, not the translation: this is the only outbound message
 * whose entire payload is attacker-chosen free text that the parent then
 * renders in its own trusted document.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { toOutboundEnvelope, type InboundEnvelope } from '@core/studio-runtime'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'

const FRAME_ORIGIN = 'https://live.studio.test'

function makeStubChannel() {
  let handler: ((ev: MessageEvent) => void) | null = null
  const posted: InboundEnvelope[] = []
  const channel: BridgeFrameChannel = {
    postMessage: (message) => posted.push(message as InboundEnvelope),
    addEventListener: (type, h) => {
      if (type === 'message') handler = h
    },
    removeEventListener: (type, h) => {
      if (type === 'message' && handler === h) handler = null
    },
  }
  return {
    channel,
    dispatch: (data: unknown) => handler?.({ origin: FRAME_ORIGIN, source: undefined, data } as MessageEvent),
  }
}

let adapters: BridgeFrameAdapter[] = []

function makeAdapter() {
  const stub = makeStubChannel()
  const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN, nodeIdsInTreeOrder: ['n1'] })
  adapters.push(adapter)
  return { adapter, stub }
}

afterEach(() => {
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

describe('BridgeFrameAdapter — error', () => {
  it('forwards a well-formed error message verbatim, and leaves absent optional fields absent', () => {
    const { adapter, stub } = makeAdapter()
    const seen: Array<{ kind: string; message: string; stack?: string; source?: string }> = []
    adapter.on('error', (msg) => seen.push(msg))

    stub.dispatch(
      toOutboundEnvelope({
        type: 'error',
        kind: 'exception',
        message: 'TypeError: cart is not defined',
        stack: 'at Checkout (/src/Checkout.tsx:42:7)',
        source: '/src/Checkout.tsx:42:7',
      }),
    )
    stub.dispatch(toOutboundEnvelope({ type: 'error', kind: 'console', message: 'Warning: invalid hook call' }))

    expect(seen).toHaveLength(2)
    expect(seen[0]!.kind).toBe('exception')
    expect(seen[0]!.message).toBe('TypeError: cart is not defined')
    expect(seen[0]!.stack).toBe('at Checkout (/src/Checkout.tsx:42:7)')
    expect(seen[0]!.source).toBe('/src/Checkout.tsx:42:7')
    expect('stack' in seen[1]!).toBe(false)
    expect('source' in seen[1]!).toBe(false)
  })

  it('drops a forged error message that breaks the schema — unknown kind, empty message, or a field past its maxLength', () => {
    const { adapter, stub } = makeAdapter()
    const seen: unknown[] = []
    adapter.on('error', (msg) => seen.push(msg))

    // A same-realm co-resident script (`sec-06`) can forge the envelope tags
    // exactly; the schema is the only thing left between it and the parent.
    const forge = (message: unknown) => stub.dispatch({ source: 'studio-live-runtime', direction: 'to-parent', message })

    forge({ type: 'error', kind: 'not-a-kind', message: 'x' })
    forge({ type: 'error', kind: 'exception', message: '' })
    forge({ type: 'error', kind: 'exception', message: 'x'.repeat(401) })
    forge({ type: 'error', kind: 'exception', message: 'ok', stack: 'y'.repeat(601) })
    forge({ type: 'error', kind: 'exception', message: 'ok', source: 'z'.repeat(301) })

    expect(seen).toHaveLength(0)
  })

  it('accepts a message exactly at each bound, so the honest sender is never rejected by its own truncation', () => {
    const { adapter, stub } = makeAdapter()
    const seen: unknown[] = []
    adapter.on('error', (msg) => seen.push(msg))

    forgeAtBounds(stub.dispatch)

    expect(seen).toHaveLength(1)
  })
})

function forgeAtBounds(dispatch: (data: unknown) => void): void {
  dispatch(
    toOutboundEnvelope({
      type: 'error',
      kind: 'exception',
      message: 'x'.repeat(400),
      stack: 'y'.repeat(600),
      source: 'z'.repeat(300),
    }),
  )
}
