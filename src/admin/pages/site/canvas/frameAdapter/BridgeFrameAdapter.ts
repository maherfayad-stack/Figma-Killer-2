/**
 * BridgeFrameAdapter — the `FrameDocumentAdapter` for a cross-origin Tier 2
 * live frame, driven entirely by `postMessage` to L4's in-frame runtime
 * (`@core/studio-runtime`'s `runtime.ts`). Uses that module's real, already-
 * shipped `InboundEnvelopeSchema`/`toInboundEnvelope`/`OutboundEnvelopeSchema`
 * exactly — never a hand-built envelope shape.
 *
 * ## The only file that ever sees a bare stamp id
 *
 * Every OTHER caller in this codebase only ever passes/receives canonical
 * tree node ids (real parser ids, with their genuine `.map`-row `#n` suffix
 * already applied, or none). `runtime.ts` (in-frame) speaks a different,
 * simpler vocabulary — a bare Vite-stamped `data-node-id` PLUS an
 * `occurrenceIndex` (the Nth DOM element sharing that stamp, in document
 * order) — because the plugin that stamps it has no call-site or
 * `.map`-iteration knowledge (see `liveNodeResolve.ts`'s module doc for the
 * full picture). This class is the ONE place that translates between the
 * two, both directions, reusing L3's own primitives verbatim:
 *
 *   - canonical -> wire: `toStampId(nodeId)` for the stamp, plus this
 *     nodeId's own index within `buildStampIndex(...)`'s bucket for that
 *     stamp (tree order == document order for anything this parser
 *     produces, so the Nth tree-order id sharing a stamp IS the Nth
 *     document-order element sharing it).
 *   - wire -> canonical: `stampIndex.get(stampId)?.[occurrenceIndex] ?? stampId`
 *     — falls back to the bare stamp itself, unresolved, exactly mirroring
 *     `resolveLiveNode`'s own "inexact" fallback contract. Never throws,
 *     never drops the event.
 *
 * `stampIndex` is rebuilt via {@link BridgeFrameAdapter.setNodeIds} whenever
 * the active page's node id set changes — NOT part of the
 * `FrameDocumentAdapter` interface (every other adapter has no such concept),
 * called by whichever Batch 6 wiring owns the page's current tree.
 */
import { buildStampIndex, toInboundEnvelope, toStampId, type OutboundEnvelope, type OutboundRuntimeMessage } from '@core/studio-runtime'
import type { PreviewAxes } from '@core/studio-board'
import type {
  FrameDocumentAdapter,
  FrameRuntimeEvent,
  NodeMeasurement,
  NodeRef,
  OptimisticDomOps,
  Unsubscribe,
} from './FrameDocumentAdapter'

/** How long a `measure` request waits for `measure:result` before its promise rejects. Not chosen from an existing precedent — no bounded-postMessage-round-trip wait exists elsewhere in this codebase yet — but consistent with this repo's general "never hang a caller forever" posture. */
const DEFAULT_MEASURE_TIMEOUT_MS = 2000

/**
 * The minimal transport surface this adapter needs — deliberately NOT typed
 * as `HTMLIFrameElement`/`Window` so `BridgeFrameAdapter.test.ts` can drive
 * it with a plain stubbed `{ postMessage, addEventListener }` pair (a real
 * `MessageEvent` carrying a real `WindowProxy` source cannot be constructed
 * in happy-dom — see `live-04`'s own already-recorded landmine). Production
 * construction (Batch 6, `IframeFrameSurface.tsx`) posts to the iframe's own
 * `contentWindow` and listens on the PARENT's own `window` — the frame's
 * outbound `postMessage` calls land there, exactly symmetric with
 * `runtime.ts`'s own `parentWindow.postMessage(...)` / `view.addEventListener('message', ...)`
 * pair from the other side of the boundary.
 */
export interface BridgeFrameChannel {
  postMessage(message: unknown, targetOrigin: string): void
  addEventListener(type: 'message', handler: (ev: MessageEvent) => void): void
  removeEventListener(type: 'message', handler: (ev: MessageEvent) => void): void
}

export interface BridgeFrameAdapterOptions {
  /** Where outbound messages are posted, and where inbound ones are listened for. */
  channel: BridgeFrameChannel
  /** The exact origin every inbound message must come from, and outbound messages are posted to. */
  frameOrigin: string
  /**
   * When provided, inbound messages are additionally checked against
   * `event.source === expectedSource` (the iframe's own `contentWindow`) —
   * the same defense-in-depth check `runtime.ts` makes from the other side.
   * Optional because a stubbed test channel has no meaningful "source" to
   * compare.
   */
  expectedSource?: unknown
  /** The active page's node ids, in tree order — seeds {@link BridgeFrameAdapter.setNodeIds}. */
  nodeIdsInTreeOrder?: Iterable<string>
  measureTimeoutMs?: number
}

class MeasureTimeoutError extends Error {
  constructor(requestId: string) {
    super(`Bridge frame did not answer measure request "${requestId}" within the timeout.`)
    this.name = 'MeasureTimeoutError'
  }
}

export class BridgeFrameAdapter implements FrameDocumentAdapter {
  private readonly channel: BridgeFrameChannel
  private readonly frameOrigin: string
  private readonly expectedSource: unknown
  private readonly measureTimeoutMs: number
  private stampIndex: Map<string, string[]>
  private readonly eventHandlers = new Map<string, Set<(msg: FrameRuntimeEvent) => void>>()
  private readonly pendingMeasurements = new Map<
    string,
    { resolve: (m: NodeMeasurement[]) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >()
  private nextRequestId = 0
  private disposed = false
  private readonly onMessage = (ev: MessageEvent) => this.handleWindowMessage(ev)

  readonly optimistic: OptimisticDomOps = {
    insert: (nodeId, parentNodeId, index, tagName, text) => {
      const parent = this.toWireRef(parentNodeId)
      this.post({
        type: 'optimistic.insert',
        nodeId: toStampId(nodeId),
        parentNodeId: parent.nodeId,
        parentOccurrenceIndex: parent.occurrenceIndex,
        index,
        tagName,
        text,
      })
    },
    delete: (nodeId) => {
      const ref = this.toWireRef(nodeId)
      this.post({ type: 'optimistic.delete', nodeId: ref.nodeId, occurrenceIndex: ref.occurrenceIndex })
    },
    move: (nodeId, parentNodeId, index) => {
      const ref = this.toWireRef(nodeId)
      const parent = this.toWireRef(parentNodeId)
      this.post({
        type: 'optimistic.move',
        nodeId: ref.nodeId,
        occurrenceIndex: ref.occurrenceIndex,
        parentNodeId: parent.nodeId,
        parentOccurrenceIndex: parent.occurrenceIndex,
        index,
      })
    },
    text: (nodeId, text) => {
      const ref = this.toWireRef(nodeId)
      this.post({ type: 'optimistic.text', nodeId: ref.nodeId, occurrenceIndex: ref.occurrenceIndex, text })
    },
  }

  constructor(options: BridgeFrameAdapterOptions) {
    this.channel = options.channel
    this.frameOrigin = options.frameOrigin
    this.expectedSource = options.expectedSource
    this.measureTimeoutMs = options.measureTimeoutMs ?? DEFAULT_MEASURE_TIMEOUT_MS
    this.stampIndex = buildStampIndex(options.nodeIdsInTreeOrder ?? [])
    this.channel.addEventListener('message', this.onMessage)
  }

  /** Rebuilds the canonical<->stamp index — call whenever the active page's node id set changes. Not part of `FrameDocumentAdapter`; every other adapter has no such concept. */
  setNodeIds(nodeIdsInTreeOrder: Iterable<string>): void {
    this.stampIndex = buildStampIndex(nodeIdsInTreeOrder)
  }

  private toWireRef(nodeId: string): { nodeId: string; occurrenceIndex: number } {
    const stampId = toStampId(nodeId)
    const bucket = this.stampIndex.get(stampId)
    const index = bucket ? bucket.indexOf(nodeId) : -1
    return { nodeId: stampId, occurrenceIndex: index >= 0 ? index : 0 }
  }

  /** Wire -> canonical, with `liveNodeResolve.ts`'s own "inexact" fallback contract: never throws, degrades to the bare stamp id. */
  private toCanonicalNodeId(stampId: string, occurrenceIndex: number): string {
    return this.stampIndex.get(stampId)?.[occurrenceIndex] ?? stampId
  }

  private post(message: Parameters<typeof toInboundEnvelope>[0]): void {
    if (this.disposed) return
    this.channel.postMessage(toInboundEnvelope(message), this.frameOrigin)
  }

  applyOverlay(id: string, css: string): void {
    this.post({ type: 'applyOverlay', id, css })
  }

  removeOverlay(id: string): void {
    this.post({ type: 'removeOverlay', id })
  }

  select(refs: NodeRef[]): void {
    this.post({ type: 'select', refs: refs.map((ref) => this.toWireRef(ref.nodeId)) })
  }

  hover(ref: NodeRef | null): void {
    if (!ref) {
      this.post({ type: 'hover', nodeId: null, occurrenceIndex: 0 })
      return
    }
    const wire = this.toWireRef(ref.nodeId)
    this.post({ type: 'hover', nodeId: wire.nodeId, occurrenceIndex: wire.occurrenceIndex })
  }

  measure(refs: NodeRef[], properties?: string[]): Promise<NodeMeasurement[]> {
    const requestId = `bridge-measure-${this.nextRequestId++}`
    const wireRefs = refs.map((ref) => this.toWireRef(ref.nodeId))
    return new Promise<NodeMeasurement[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMeasurements.delete(requestId)
        reject(new MeasureTimeoutError(requestId))
      }, this.measureTimeoutMs)
      this.pendingMeasurements.set(requestId, { resolve, reject, timeout })
      this.post({ type: 'measure', requestId, refs: wireRefs, properties })
    })
  }

  setAxes(axes: PreviewAxes): void {
    this.post({ type: 'setAxes', axes: { direction: axes.direction, colorScheme: axes.colorScheme, locale: axes.locale } })
  }

  setInteractionMode(mode: 'design' | 'live'): void {
    this.post({ type: 'setMode', mode })
  }

  on<E extends FrameRuntimeEvent['type']>(event: E, handler: (msg: Extract<FrameRuntimeEvent, { type: E }>) => void): Unsubscribe {
    let set = this.eventHandlers.get(event)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(event, set)
    }
    set.add(handler as (msg: FrameRuntimeEvent) => void)
    return () => set!.delete(handler as (msg: FrameRuntimeEvent) => void)
  }

  private emit(event: FrameRuntimeEvent): void {
    for (const handler of this.eventHandlers.get(event.type) ?? []) handler(event)
  }

  private handleWindowMessage(ev: MessageEvent): void {
    if (ev.origin !== this.frameOrigin) return
    if (this.expectedSource !== undefined && ev.source !== this.expectedSource) return
    const data = ev.data as Partial<OutboundEnvelope> | undefined
    if (!data || typeof data !== 'object') return
    if (data.direction !== 'to-parent') return
    const message = data.message as OutboundRuntimeMessage | undefined
    if (!message) return
    this.dispatchOutboundMessage(message)
  }

  private dispatchOutboundMessage(message: OutboundRuntimeMessage): void {
    switch (message.type) {
      case 'ready':
      case 'hmr:before':
      case 'hmr:after':
        this.emit({ type: message.type })
        return
      case 'frame:resize':
        this.emit({ type: 'frame:resize', height: message.height })
        return
      case 'pointer':
        this.emit({
          type: 'pointer',
          phase: message.phase,
          nodeId: message.nodeId === null ? null : this.toCanonicalNodeId(message.nodeId, message.occurrenceIndex),
          rect: message.rect,
          clientX: message.clientX,
          clientY: message.clientY,
          modifiers: message.modifiers,
        })
        return
      case 'text:edit':
        this.emit({
          type: 'text:edit',
          nodeId: this.toCanonicalNodeId(message.nodeId, message.occurrenceIndex),
          text: message.text,
        })
        return
      case 'measure:result': {
        const pending = this.pendingMeasurements.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pendingMeasurements.delete(message.requestId)
        pending.resolve(
          message.measurements.map((m) => ({
            nodeId: this.toCanonicalNodeId(m.nodeId, m.occurrenceIndex),
            rect: m.rect,
            computedStyle: m.computedStyle,
          })),
        )
        return
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.channel.removeEventListener('message', this.onMessage)
    for (const { reject, timeout } of this.pendingMeasurements.values()) {
      clearTimeout(timeout)
      reject(new Error('BridgeFrameAdapter disposed while a measure request was in flight.'))
    }
    this.pendingMeasurements.clear()
    this.eventHandlers.clear()
  }
}
