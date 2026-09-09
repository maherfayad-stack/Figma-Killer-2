/**
 * Round-trips every message shape in `messages.ts` through the TypeBox
 * schema, both directions, plus the envelope wrapper both `runtime.ts` and
 * the eventual (L5) parent-side adapter build messages with.
 */
import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import {
  DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES,
  InboundEnvelopeSchema,
  InboundRuntimeMessageSchema,
  OutboundEnvelopeSchema,
  OutboundRuntimeMessageSchema,
  RUNTIME_MESSAGE_SOURCE,
  toInboundEnvelope,
  toOutboundEnvelope,
  type InboundRuntimeMessage,
  type OutboundRuntimeMessage,
} from '@core/studio-runtime'

const inboundSamples: InboundRuntimeMessage[] = [
  { type: 'applyOverlay', id: 'selection-chrome', css: '.x { color: red }' },
  { type: 'removeOverlay', id: 'selection-chrome' },
  { type: 'select', nodeIds: ['src/App.tsx:1:1', 'src/App.tsx:2:2'] },
  { type: 'hover', nodeId: 'src/App.tsx:1:1' },
  { type: 'hover', nodeId: null },
  { type: 'measure', requestId: 'r1', nodeIds: ['src/App.tsx:1:1'] },
  { type: 'measure', requestId: 'r2', nodeIds: ['src/App.tsx:1:1'], properties: ['color', 'width'] },
  { type: 'setAxes', axes: { direction: 'ltr', colorScheme: 'light' } },
  { type: 'setAxes', axes: { direction: 'rtl', colorScheme: 'dark', locale: 'ar' } },
  { type: 'setMode', mode: 'design' },
  { type: 'setMode', mode: 'live' },
  {
    type: 'optimistic.insert',
    nodeId: 'n1',
    parentNodeId: 'p1',
    index: 0,
    tagName: 'div',
    text: 'hello',
  },
  { type: 'optimistic.delete', nodeId: 'n1' },
  { type: 'optimistic.move', nodeId: 'n1', parentNodeId: 'p2', index: 1 },
  { type: 'optimistic.text', nodeId: 'n1', text: 'updated' },
]

const outboundSamples: OutboundRuntimeMessage[] = [
  { type: 'ready' },
  { type: 'hmr:before' },
  { type: 'hmr:after' },
  {
    type: 'pointer',
    phase: 'down',
    nodeId: 'n1',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    clientX: 5,
    clientY: 5,
    modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
  },
  {
    type: 'pointer',
    phase: 'click',
    nodeId: null,
    rect: null,
    clientX: 0,
    clientY: 0,
    modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
  },
  { type: 'text:edit', nodeId: 'n1', text: 'typed text' },
  {
    type: 'measure:result',
    requestId: 'r1',
    measurements: [{ nodeId: 'n1', rect: { x: 0, y: 0, width: 1, height: 1 }, computedStyle: { color: 'red' } }],
  },
]

describe('InboundRuntimeMessageSchema', () => {
  it('accepts every documented inbound message shape', () => {
    for (const message of inboundSamples) {
      expect(Value.Check(InboundRuntimeMessageSchema, message)).toBe(true)
    }
  })

  it('rejects an unknown message type', () => {
    expect(Value.Check(InboundRuntimeMessageSchema, { type: 'not-a-real-message' })).toBe(false)
  })

  it("rejects optimistic.insert's tagName when it isn't a bare tag name (no markup injection surface)", () => {
    const bad = {
      type: 'optimistic.insert',
      nodeId: 'n1',
      parentNodeId: 'p1',
      index: 0,
      tagName: '<script>',
    }
    expect(Value.Check(InboundRuntimeMessageSchema, bad)).toBe(false)
  })

  it("accepts a bare dangerous tag name shape-wise — the schema's regex only excludes markup characters, not specific element names", () => {
    // The denylist itself is enforced case-insensitively in `runtime.ts`'s
    // `handleOptimisticInsert` (see `DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES`'s
    // doc for why a regex can't do this job). This test exists so nobody
    // "fixes" the schema regex to reject `script` and accidentally makes it
    // reject `SCRIPT` too while still admitting it — i.e. so the two guards
    // don't silently drift out of sync.
    const shapeValid = {
      type: 'optimistic.insert',
      nodeId: 'n1',
      parentNodeId: 'p1',
      index: 0,
      tagName: 'script',
    }
    expect(Value.Check(InboundRuntimeMessageSchema, shapeValid)).toBe(true)
    expect(DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES.has('script')).toBe(true)
  })
})

describe('OutboundRuntimeMessageSchema', () => {
  it('accepts every documented outbound message shape', () => {
    for (const message of outboundSamples) {
      expect(Value.Check(OutboundRuntimeMessageSchema, message)).toBe(true)
    }
  })

  it('rejects a measure:result missing requestId', () => {
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'measure:result', measurements: [] })).toBe(false)
  })
})

describe('envelopes', () => {
  it('toInboundEnvelope / toOutboundEnvelope round-trip through their schemas', () => {
    for (const message of inboundSamples) {
      const envelope = toInboundEnvelope(message)
      expect(envelope.source).toBe(RUNTIME_MESSAGE_SOURCE)
      expect(envelope.direction).toBe('to-frame')
      expect(Value.Check(InboundEnvelopeSchema, envelope)).toBe(true)
    }
    for (const message of outboundSamples) {
      const envelope = toOutboundEnvelope(message)
      expect(envelope.source).toBe(RUNTIME_MESSAGE_SOURCE)
      expect(envelope.direction).toBe('to-parent')
      expect(Value.Check(OutboundEnvelopeSchema, envelope)).toBe(true)
    }
  })

  it('rejects an envelope with the wrong direction tag for its schema', () => {
    const wrongDirection = { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-parent', message: { type: 'ready' } }
    expect(Value.Check(InboundEnvelopeSchema, wrongDirection)).toBe(false)
  })

  it('rejects an envelope from an unrelated postMessage sender', () => {
    const foreign = { source: 'react-devtools-bridge', direction: 'to-frame', message: { type: 'select', nodeIds: [] } }
    expect(Value.Check(InboundEnvelopeSchema, foreign)).toBe(false)
  })
})
