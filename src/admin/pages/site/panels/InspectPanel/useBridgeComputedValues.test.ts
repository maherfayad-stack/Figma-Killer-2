/**
 * useBridgeComputedValues — tested against a STUBBED message channel, same
 * posture as `BridgeFrameAdapter.test.ts` (`live-04`'s own landmine: happy-dom
 * cannot construct a `MessageEvent` carrying a real cross-window `source`, so
 * a real cross-origin postMessage round trip is dogfood-only). This proves
 * the HOOK's own async-correctness logic — the generation guard that drops a
 * stale resolve, the timeout-keeps-previous-value contract, and the
 * breakpoint-preference narrowing — in isolation from a real frame.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { toOutboundEnvelope, type InboundEnvelope, type InboundRuntimeMessage } from '@core/studio-runtime'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import {
  registerFrameAdapter,
  unregisterFrameAdapter,
} from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { hasBridgeFrameFor, useBridgeComputedValues } from './useBridgeComputedValues'

const FRAME_ORIGIN = 'https://live.studio.test'
const PROPERTIES = ['display'] as const

interface StubChannel {
  channel: BridgeFrameChannel
  /** Every `requestId` this channel has been asked to measure, in post order. */
  postedRequestIds(): string[]
  /** The wire (kebab-case) property names a given `measure` request asked for. */
  pendingMeasureProperties(requestId: string): string[] | undefined
  /** Manually answers a specific pending `measure` request. */
  resolveMeasure(requestId: string, computedStyle: Record<string, string>): void
}

/** `autoReply`, when given, answers every `measure` request on the next microtask with a fixed `computedStyle` — for fixtures that don't need to control resolve timing. Omit it to drive replies manually via `resolveMeasure`. */
function makeStubChannel(options: { autoReply?: Record<string, string> } = {}): StubChannel {
  let handler: ((ev: MessageEvent) => void) | null = null
  const posted: InboundEnvelope[] = []
  const channel: BridgeFrameChannel = {
    postMessage: (message) => {
      const envelope = message as InboundEnvelope
      posted.push(envelope)
      if (options.autoReply && envelope.message.type === 'measure') {
        const { requestId, refs } = envelope.message
        queueMicrotask(() => {
          handler?.({
            origin: FRAME_ORIGIN,
            source: undefined,
            data: toOutboundEnvelope({
              type: 'measure:result',
              requestId,
              measurements: refs.map((ref) => ({
                nodeId: ref.nodeId,
                occurrenceIndex: ref.occurrenceIndex,
                rect: { x: 0, y: 0, width: 10, height: 10 },
                computedStyle: options.autoReply!,
              })),
            }),
          } as MessageEvent)
        })
      }
    },
    addEventListener: (type, h) => {
      if (type === 'message') handler = h
    },
    removeEventListener: (type, h) => {
      if (type === 'message' && handler === h) handler = null
    },
  }
  return {
    channel,
    postedRequestIds: () =>
      posted
        .filter((env): env is InboundEnvelope & { message: Extract<InboundRuntimeMessage, { type: 'measure' }> } =>
          env.message.type === 'measure',
        )
        .map((env) => env.message.requestId),
    pendingMeasureProperties: (requestId) => {
      const request = posted.find((env) => env.message.type === 'measure' && env.message.requestId === requestId)
      return request && request.message.type === 'measure' ? request.message.properties : undefined
    },
    resolveMeasure: (requestId, computedStyle) => {
      const request = posted.find((env) => env.message.type === 'measure' && env.message.requestId === requestId)
      if (!request || request.message.type !== 'measure') {
        throw new Error(`No pending "measure" request with id "${requestId}"`)
      }
      handler?.({
        origin: FRAME_ORIGIN,
        source: undefined,
        data: toOutboundEnvelope({
          type: 'measure:result',
          requestId,
          measurements: request.message.refs.map((ref) => ({
            nodeId: ref.nodeId,
            occurrenceIndex: ref.occurrenceIndex,
            rect: { x: 0, y: 0, width: 10, height: 10 },
            computedStyle,
          })),
        }),
      } as MessageEvent)
    },
  }
}

function addBridgeFrame(breakpointId: string, options: { autoReply?: Record<string, string> } = {}) {
  const frame = document.createElement('iframe')
  frame.setAttribute('data-breakpoint-id', breakpointId)
  document.body.appendChild(frame)
  const stub = makeStubChannel(options)
  const adapter = new BridgeFrameAdapter({ channel: stub.channel, frameOrigin: FRAME_ORIGIN })
  registerFrameAdapter(frame, adapter, breakpointId)
  return {
    frame,
    stub,
    dispose: () => {
      unregisterFrameAdapter(frame)
      adapter.dispose()
      frame.remove()
    },
  }
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('hasBridgeFrameFor', () => {
  it('is false when only portal adapters are registered', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument!
    frameDoc.body.setAttribute('data-breakpoint-id', 'bp-desktop')
    frame.setAttribute('data-breakpoint-id', 'bp-desktop')
    const adapter = new PortalFrameAdapter(frameDoc)
    registerFrameAdapter(frame, adapter, 'bp-desktop')

    expect(hasBridgeFrameFor('bp-desktop')).toBe(false)

    unregisterFrameAdapter(frame)
    adapter.dispose()
  })

  it('is true only for the breakpoint a registered bridge frame actually carries', () => {
    const bridge = addBridgeFrame('bp-desktop')

    expect(hasBridgeFrameFor('bp-desktop')).toBe(true)
    expect(hasBridgeFrameFor('bp-tablet')).toBe(false)

    bridge.dispose()
    expect(hasBridgeFrameFor('bp-desktop')).toBe(false)
  })
})

describe('useBridgeComputedValues', () => {
  it('drops a stale resolve when a fast re-selection fires before the previous measure resolves', async () => {
    const bridge = addBridgeFrame('bp-desktop')

    const { result, rerender } = renderHook(
      ({ nodeId }: { nodeId: string }) => useBridgeComputedValues(nodeId, 'bp-desktop', PROPERTIES, true),
      { initialProps: { nodeId: 'node-a' } },
    )

    await waitFor(() => expect(bridge.stub.postedRequestIds()).toHaveLength(1))
    const [firstRequestId] = bridge.stub.postedRequestIds()

    // Re-select before node-a's measure resolves.
    rerender({ nodeId: 'node-b' })
    await waitFor(() => expect(bridge.stub.postedRequestIds()).toHaveLength(2))
    const [, secondRequestId] = bridge.stub.postedRequestIds()

    // node-a's late reply arrives after node-b's request already went out —
    // must be silently dropped, not applied under node-b's selection.
    act(() => {
      bridge.stub.resolveMeasure(firstRequestId!, { display: 'node-a-value' })
    })
    await Promise.resolve()
    expect(result.current.value).toBeNull()
    expect(result.current.isLoading).toBe(true)

    act(() => {
      bridge.stub.resolveMeasure(secondRequestId!, { display: 'node-b-value' })
    })
    await waitFor(() => expect(result.current.value?.display).toBe('node-b-value'))
    expect(result.current.isLoading).toBe(false)

    bridge.dispose()
  })

  it('keeps the previously resolved value and clears isLoading when a later measure times out', async () => {
    const bridge = addBridgeFrame('bp-desktop')
    // Rebuild with a short timeout for the second (never-answered) request —
    // reuse the same registered frame element so hasBridgeFrameFor/measure
    // routing is unaffected.
    unregisterFrameAdapter(bridge.frame)
    const shortTimeoutAdapter = new BridgeFrameAdapter({
      channel: bridge.stub.channel,
      frameOrigin: FRAME_ORIGIN,
      measureTimeoutMs: 5,
    })
    registerFrameAdapter(bridge.frame, shortTimeoutAdapter, 'bp-desktop')

    const { result, rerender } = renderHook(
      ({ nodeId }: { nodeId: string }) => useBridgeComputedValues(nodeId, 'bp-desktop', PROPERTIES, true),
      { initialProps: { nodeId: 'node-a' } },
    )

    await waitFor(() => expect(bridge.stub.postedRequestIds()).toHaveLength(1))
    act(() => {
      bridge.stub.resolveMeasure(bridge.stub.postedRequestIds()[0]!, { display: 'node-a-value' })
    })
    await waitFor(() => expect(result.current.value?.display).toBe('node-a-value'))

    // A second request that never answers — times out per measureTimeoutMs.
    rerender({ nodeId: 'node-a-again' })
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.value?.display).toBe('node-a-value')

    unregisterFrameAdapter(bridge.frame)
    shortTimeoutAdapter.dispose()
    bridge.frame.remove()
  })

  it('prefers the value from the frame matching the active breakpoint when two bridge frames render the same node', async () => {
    const desktop = addBridgeFrame('bp-desktop', { autoReply: { display: 'desktop-value' } })
    const tablet = addBridgeFrame('bp-tablet', { autoReply: { display: 'tablet-value' } })

    const { result } = renderHook(() => useBridgeComputedValues('node-a', 'bp-tablet', PROPERTIES, true))

    await waitFor(() => expect(result.current.value?.display).toBe('tablet-value'))
    expect(result.current.isLoading).toBe(false)

    desktop.dispose()
    tablet.dispose()
  })

  it('does nothing while active is false — no measure request is posted', async () => {
    const bridge = addBridgeFrame('bp-desktop')

    const { result } = renderHook(() => useBridgeComputedValues('node-a', 'bp-desktop', PROPERTIES, false))

    // Give any accidental async work a turn, then assert nothing happened.
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.stub.postedRequestIds()).toHaveLength(0)
    expect(result.current).toEqual({ value: null, isLoading: false })

    bridge.dispose()
  })

  it('requests kebab-case wire properties and returns the reply re-keyed back to camelCase', async () => {
    const bridge = addBridgeFrame('bp-desktop')
    const camelCaseProperties = ['flexDirection', 'backgroundColor'] as const

    const { result } = renderHook(() =>
      useBridgeComputedValues('node-a', 'bp-desktop', camelCaseProperties, true),
    )

    await waitFor(() => expect(bridge.stub.postedRequestIds()).toHaveLength(1))
    const [requestId] = bridge.stub.postedRequestIds()
    // The pending request itself only ever carries kebab-case wire property
    // names — never the caller's own camelCase vocabulary.
    expect(bridge.stub.pendingMeasureProperties(requestId!)).toEqual(['flex-direction', 'background-color'])

    act(() => {
      bridge.stub.resolveMeasure(requestId!, { 'flex-direction': 'column', 'background-color': 'red' })
    })

    await waitFor(() =>
      expect(result.current.value).toEqual({ flexDirection: 'column', backgroundColor: 'red' }),
    )

    bridge.dispose()
  })
})
