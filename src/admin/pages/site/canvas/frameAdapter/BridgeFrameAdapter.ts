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
 *
 * ## Inbound (frame -> parent) messages get the SAME three-layer check `runtime.ts` uses
 *
 * `sec-06` (STATE.md) established the bar for the other side of this bridge:
 * origin + envelope `source`/`direction` tags checked BEFORE the TypeBox
 * schema runs, schema checked BEFORE any handler reads a field. `sec-06`'s
 * own "same-realm spoofing" finding is exactly why this direction needs the
 * identical discipline: `runtime.ts` shares a JS realm with the user's own
 * (potentially compromised) project dependencies, so any script co-resident
 * in that document can call `window.parent.postMessage(forgedPayload,
 * parentOrigin)` directly — origin/source alone narrow WHERE a message can
 * come from, never WHAT shape it is. `handleWindowMessage` below checks
 * `data.source === RUNTIME_MESSAGE_SOURCE` and runs
 * `Value.Check(OutboundEnvelopeSchema, data)` before `dispatchOutboundMessage`
 * ever reads a single field off `message` — the same ordering
 * `runtime.ts`'s `onWindowMessage` already uses, just for the opposite
 * direction.
 */
import { Value } from '@sinclair/typebox/value'
import {
  buildStampIndex,
  OutboundEnvelopeSchema,
  RESIZE_SNAP_SIBLINGS_MAX,
  RUNTIME_MESSAGE_SOURCE,
  toInboundEnvelope,
  toStampId,
  type OutboundEnvelope,
  type OutboundRuntimeMessage,
} from '@core/studio-runtime'
import type { PreviewAxes } from '@core/studio-board'
import type {
  DropCandidateGeometry,
  FrameDocumentAdapter,
  FrameRuntimeEvent,
  NodeMeasurement,
  NodeRef,
  OptimisticDomOps,
  ResizeTargetOptions,
  Unsubscribe,
} from './FrameDocumentAdapter'

/** How long a `measure`/`dropCandidates` request waits for its reply before the promise rejects. Not chosen from an existing precedent — no bounded-postMessage-round-trip wait exists elsewhere in this codebase yet — but consistent with this repo's general "never hang a caller forever" posture. */
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
    super(`Bridge frame did not answer request "${requestId}" within the timeout.`)
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
  /** `speed-06` — pending `dropCandidates` requests, same shape as `pendingMeasurements`, kept separate because the two replies carry different payloads. */
  private readonly pendingDropCandidates = new Map<
    string,
    { resolve: (c: DropCandidateGeometry[]) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >()
  private nextRequestId = 0
  private disposed = false
  private frameReady = false
  /**
   * `live-12` — the mode the parent last declared, re-sent on every `ready`.
   * A Vite full reload (the runtime's own bundle changing, an edit HMR cannot
   * hot-swap) replaces the frame's DOCUMENT under the same `WindowProxy`: the
   * new runtime boots with no mode and posts `ready` again, and a mode sent
   * only once would have died with the old document — leaving the frame a
   * visitor's page, its clicks reaching the app instead of the editor.
   */
  private interactionMode: 'design' | 'live' | null = null
  private queuedUntilReady: Parameters<typeof toInboundEnvelope>[0][] = []
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
    style: (nodeId, patch, className) => {
      const ref = this.toWireRef(nodeId)
      this.post({ type: 'optimistic.style', ref, patch, ...(className === undefined ? {} : { className }) })
    },
    clearStyle: (nodeId) => {
      const ref = this.toWireRef(nodeId)
      this.post({ type: 'optimistic.style:clear', ref })
    },
    revert: (nodeIds) => {
      if (nodeIds.length === 0) return
      this.post({ type: 'optimistic.revert', refs: nodeIds.map((nodeId) => this.toWireRef(nodeId)) })
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

  /**
   * `live-12` — the canonical id of the innermost stamped ancestor of a
   * pointer hit that the page tree actually knows. A click inside a
   * design-system button is stamped with that package's own internal source
   * position; walking out to the call site is what makes the click select
   * the button. Falls back to the innermost id's own (possibly inexact)
   * translation when nothing in the chain is known, exactly as before.
   */
  private nearestKnownNodeId(message: { nodeId: string | null; occurrenceIndex: number; ancestors: readonly { nodeId: string; occurrenceIndex: number }[] }): string | null {
    for (const ref of message.ancestors) {
      const known = this.stampIndex.get(ref.nodeId)?.[ref.occurrenceIndex]
      if (known !== undefined) return known
    }
    return message.nodeId === null ? null : this.toCanonicalNodeId(message.nodeId, message.occurrenceIndex)
  }

  /**
   * Nothing is posted until the frame has said `ready`. Before that the
   * iframe is still `about:blank` (the parent's origin) or mid-navigation,
   * and a `postMessage` targeted at `frameOrigin` lands nowhere and logs a
   * "target origin does not match" warning for every overlay, mode and axes
   * call the canvas makes while mounting. Queued and flushed on `ready`
   * instead — the frame gets every command, in order, the moment it can act
   * on them.
   */
  private post(message: Parameters<typeof toInboundEnvelope>[0]): void {
    if (this.disposed) return
    if (!this.frameReady) {
      this.queuedUntilReady.push(message)
      return
    }
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

  /**
   * `speed-06` — a bounded `dropCandidates`/`dropCandidates:result` round
   * trip, translating each wire candidate's stamp+occurrence back to a
   * canonical node id exactly like every other inbound method here.
   * `childRects` travels on the wire (bounded, `sec-06`) but is dropped here
   * — unconsumed by today's resolver, see `dropCandidates.ts`'s own doc.
   */
  measureDropCandidates(): Promise<DropCandidateGeometry[]> {
    const requestId = `bridge-drop-candidates-${this.nextRequestId++}`
    return new Promise<DropCandidateGeometry[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDropCandidates.delete(requestId)
        reject(new MeasureTimeoutError(requestId))
      }, this.measureTimeoutMs)
      this.pendingDropCandidates.set(requestId, { resolve, reject, timeout })
      this.post({ type: 'dropCandidates', requestId })
    })
  }

  setAxes(axes: PreviewAxes): void {
    this.post({ type: 'setAxes', axes: { direction: axes.direction, colorScheme: axes.colorScheme, locale: axes.locale } })
  }

  setInteractionMode(mode: 'design' | 'live'): void {
    this.interactionMode = mode
    this.post({ type: 'setMode', mode })
  }

  setResizeTarget(ref: NodeRef | null, { proportional, sizing, snap }: ResizeTargetOptions): void {
    this.post({
      type: 'setResizeTarget',
      ref: ref ? this.toWireRef(ref.nodeId) : null,
      proportional,
      ...(sizing === undefined ? {} : { sizing }),
      ...(snap === undefined
        ? {}
        : {
            snap: {
              siblings: snap.siblings.slice(0, RESIZE_SNAP_SIBLINGS_MAX).map((sibling) => this.toWireRef(sibling.nodeId)),
              parent: snap.parent ? this.toWireRef(snap.parent.nodeId) : null,
              zoom: snap.zoom,
            },
          }),
    })
  }

  startTextEdit(nodeId: string, allowed: boolean, text?: string): void {
    const ref = this.toWireRef(nodeId)
    this.post({ type: 'text:edit', nodeId: ref.nodeId, occurrenceIndex: ref.occurrenceIndex, allowed, ...(text === undefined ? {} : { text }) })
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
    const data: unknown = ev.data
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { source?: unknown }).source !== RUNTIME_MESSAGE_SOURCE ||
      (data as { direction?: unknown }).direction !== 'to-parent'
    ) {
      return
    }
    if (!Value.Check(OutboundEnvelopeSchema, data)) return
    this.dispatchOutboundMessage((data as OutboundEnvelope).message)
  }

  private dispatchOutboundMessage(message: OutboundRuntimeMessage): void {
    switch (message.type) {
      case 'ready': {
        const wasReady = this.frameReady
        this.frameReady = true
        const queued = this.queuedUntilReady
        this.queuedUntilReady = []
        for (const pending of queued) this.post(pending)
        // A SECOND `ready` is a reloaded document — see `interactionMode`.
        if (wasReady && this.interactionMode !== null) this.post({ type: 'setMode', mode: this.interactionMode })
        this.emit({ type: 'ready' })
        return
      }
      case 'hmr:before':
      case 'hmr:after':
        this.emit({ type: message.type })
        return
      case 'frame:resize':
        this.emit({ type: 'frame:resize', height: message.height })
        return
      // Z5 — a pure pass-through: every field was already bounded by
      // `ErrorMessageSchema` in the check above, and none of them is a node id,
      // so this is the one outbound message that needs no wire->canonical
      // translation at all. Routing it into `canvasDiagnosticsBuffer.ts` (and
      // the per-frame badge) is `useBridgeFrameDiagnostics`'s job, not this
      // class's — an adapter reports what the frame said; it does not decide
      // where findings are stored.
      case 'error':
        this.emit({
          type: 'error',
          kind: message.kind,
          message: message.message,
          ...(message.stack === undefined ? {} : { stack: message.stack }),
          ...(message.source === undefined ? {} : { source: message.source }),
        })
        return
      case 'pointer':
        this.emit({
          type: 'pointer',
          phase: message.phase,
          nodeId: this.nearestKnownNodeId(message),
          rect: message.rect,
          clientX: message.clientX,
          clientY: message.clientY,
          screenX: message.screenX,
          screenY: message.screenY,
          modifiers: message.modifiers,
          button: message.button,
          buttons: message.buttons,
          pointerId: message.pointerId,
          pointerType: message.pointerType,
        })
        return
      case 'resize:commit':
        this.emit({
          type: 'resize:commit',
          nodeId: this.toCanonicalNodeId(message.nodeId, message.occurrenceIndex),
          patch: message.patch,
        })
        return
      // canvas-26 — guides name no node, so they pass through like `error`.
      case 'resize:guides':
        this.emit({ type: 'resize:guides', guides: message.guides })
        return
      // P2-B — keyboard carries no node id, so, like `error`, it passes
      // through with no wire -> canonical translation.
      case 'key':
        this.emit({
          type: 'key',
          phase: message.phase,
          key: message.key,
          code: message.code,
          location: message.location,
          repeat: message.repeat,
          modifiers: message.modifiers,
        })
        return
      case 'blur':
        this.emit({ type: 'blur' })
        return
      case 'wheel':
        this.emit({
          type: 'wheel',
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          deltaMode: message.deltaMode,
          clientX: message.clientX,
          clientY: message.clientY,
          modifiers: message.modifiers,
        })
        return
      // canvas-24 — the same ancestor walk a click gets: the innermost stamp
      // of a double-click inside a package component is one the tree never saw.
      case 'text:editStart':
        this.emit({ type: 'text:editStart', nodeId: this.nearestKnownNodeId(message) ?? message.nodeId })
        return
      case 'text:commit':
        this.emit({
          type: 'text:commit',
          nodeId: this.toCanonicalNodeId(message.nodeId, message.occurrenceIndex),
          text: message.text,
        })
        return
      case 'text:cancel':
        this.emit({
          type: 'text:cancel',
          nodeId: this.toCanonicalNodeId(message.nodeId, message.occurrenceIndex),
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
      case 'dropCandidates:result': {
        const pending = this.pendingDropCandidates.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pendingDropCandidates.delete(message.requestId)
        pending.resolve(
          message.candidates.map((c) => ({
            nodeId: this.toCanonicalNodeId(c.nodeId, c.occurrenceIndex),
            rect: c.rect,
            axis: c.axis,
            reversed: c.reversed,
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
    for (const { reject, timeout } of this.pendingDropCandidates.values()) {
      clearTimeout(timeout)
      reject(new Error('BridgeFrameAdapter disposed while a dropCandidates request was in flight.'))
    }
    this.pendingDropCandidates.clear()
    this.eventHandlers.clear()
  }
}

/**
 * Type guard narrowing a `FrameDocumentAdapter` to `BridgeFrameAdapter`, so a
 * caller can reach {@link BridgeFrameAdapter.setNodeIds} — NOT part of
 * `FrameDocumentAdapter` itself, since a portal adapter has no canonical
 * <-> stamp index to rebuild. Symmetric with `PortalFrameAdapter.ts`'s
 * `isPortalFrameAdapter`.
 */
export function isBridgeFrameAdapter(adapter: FrameDocumentAdapter | null): adapter is BridgeFrameAdapter {
  return adapter instanceof BridgeFrameAdapter
}
