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
  {
    type: 'select',
    refs: [
      { nodeId: 'src/App.tsx:1:1', occurrenceIndex: 0 },
      { nodeId: 'src/App.tsx:2:2', occurrenceIndex: 1 },
    ],
  },
  { type: 'hover', nodeId: 'src/App.tsx:1:1', occurrenceIndex: 0 },
  { type: 'hover', nodeId: null, occurrenceIndex: 0 },
  { type: 'measure', requestId: 'r1', refs: [{ nodeId: 'src/App.tsx:1:1', occurrenceIndex: 0 }] },
  {
    type: 'measure',
    requestId: 'r2',
    refs: [{ nodeId: 'src/App.tsx:1:1', occurrenceIndex: 2 }],
    properties: ['color', 'width'],
  },
  { type: 'setAxes', axes: { direction: 'ltr', colorScheme: 'light' } },
  { type: 'setAxes', axes: { direction: 'rtl', colorScheme: 'dark', locale: 'ar' } },
  { type: 'setMode', mode: 'design' },
  { type: 'setResizeTarget', ref: { nodeId: 'n1', occurrenceIndex: 0 }, proportional: false },
  { type: 'setResizeTarget', ref: null, proportional: true },
  { type: 'setMode', mode: 'live' },
  {
    type: 'optimistic.insert',
    nodeId: 'n1',
    parentNodeId: 'p1',
    parentOccurrenceIndex: 0,
    index: 0,
    tagName: 'div',
    text: 'hello',
  },
  { type: 'optimistic.delete', nodeId: 'n1', occurrenceIndex: 0 },
  {
    type: 'optimistic.move',
    nodeId: 'n1',
    occurrenceIndex: 0,
    parentNodeId: 'p2',
    parentOccurrenceIndex: 1,
    index: 1,
  },
  { type: 'optimistic.text', nodeId: 'n1', occurrenceIndex: 0, text: 'updated' },
]

const outboundSamples: OutboundRuntimeMessage[] = [
  { type: 'ready' },
  { type: 'hmr:before' },
  { type: 'hmr:after' },
  {
    type: 'wheel',
    deltaX: 0,
    deltaY: -120,
    deltaMode: 0,
    clientX: 12,
    clientY: 34,
    modifiers: { shiftKey: false, altKey: false, ctrlKey: true, metaKey: false },
  },
  {
    type: 'pointer',
    phase: 'down',
    nodeId: 'n1',
    occurrenceIndex: 0,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    clientX: 5,
    clientY: 5,
    modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    ancestors: [],
  },
  {
    type: 'pointer',
    phase: 'click',
    nodeId: null,
    occurrenceIndex: 0,
    rect: null,
    clientX: 0,
    clientY: 0,
    modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    ancestors: [],
  },
  { type: 'text:edit', nodeId: 'n1', occurrenceIndex: 0, text: 'typed text' },
  { type: 'resize:commit', nodeId: 'n1', occurrenceIndex: 0, patch: { width: '240px' } },
  { type: 'resize:commit', nodeId: 'n1', occurrenceIndex: 2, patch: { width: '240px', height: '96px' } },
  {
    type: 'measure:result',
    requestId: 'r1',
    measurements: [
      { nodeId: 'n1', occurrenceIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, computedStyle: { color: 'red' } },
    ],
  },
  { type: 'frame:resize', height: 1234 },
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
      parentOccurrenceIndex: 0,
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

  it('rejects a negative frame:resize height', () => {
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: -1 })).toBe(false)
  })

  it('rejects a non-numeric frame:resize height', () => {
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: '100' })).toBe(false)
  })

  it('rejects NaN and Infinity as a frame:resize height', () => {
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: NaN })).toBe(false)
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: Infinity })).toBe(false)
  })

  it('rejects an absurd but finite frame:resize height (defense-in-depth against a forged same-realm message)', () => {
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: 1e20 })).toBe(false)
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: 1_000_000 })).toBe(true)
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'frame:resize', height: 1_000_001 })).toBe(false)
  })
})

describe('occurrenceIndex (L5) — adversarial shape coverage on every node-naming message', () => {
  it('rejects a select ref missing occurrenceIndex entirely', () => {
    expect(Value.Check(InboundRuntimeMessageSchema, { type: 'select', refs: [{ nodeId: 'n1' }] })).toBe(false)
  })

  it('rejects a negative occurrenceIndex', () => {
    expect(Value.Check(InboundRuntimeMessageSchema, { type: 'hover', nodeId: 'n1', occurrenceIndex: -1 })).toBe(false)
  })

  it('rejects a non-integer occurrenceIndex', () => {
    expect(Value.Check(InboundRuntimeMessageSchema, { type: 'hover', nodeId: 'n1', occurrenceIndex: 1.5 })).toBe(false)
  })

  it('rejects a string occurrenceIndex', () => {
    expect(
      Value.Check(InboundRuntimeMessageSchema, { type: 'optimistic.delete', nodeId: 'n1', occurrenceIndex: '0' }),
    ).toBe(false)
  })

  it('rejects an optimistic.move missing parentOccurrenceIndex', () => {
    expect(
      Value.Check(InboundRuntimeMessageSchema, {
        type: 'optimistic.move',
        nodeId: 'n1',
        occurrenceIndex: 0,
        parentNodeId: 'p1',
        index: 0,
      }),
    ).toBe(false)
  })

  it('rejects an outbound pointer message with a negative occurrenceIndex', () => {
    expect(
      Value.Check(OutboundRuntimeMessageSchema, {
        type: 'pointer',
        phase: 'click',
        nodeId: 'n1',
        occurrenceIndex: -1,
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
    ).toBe(false)
  })

  // `live-13` — the two resize messages carry only what the store needs: an
  // integer pixel count per changed axis, and a bounded pointer identity.
  it('rejects a resize:commit whose patch is not an integer pixel length', () => {
    for (const width of ['12em', '50%', '1e3px', '-4px', 'calc(1px)', '']) {
      expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'resize:commit', nodeId: 'n1', occurrenceIndex: 0, patch: { width } })).toBe(false)
    }
    expect(Value.Check(OutboundRuntimeMessageSchema, { type: 'resize:commit', nodeId: 'n1', occurrenceIndex: 0, patch: {} })).toBe(true)
  })

  it('rejects a pointer message with an unknown pointer type or an out-of-range button', () => {
    const base = { type: 'pointer', phase: 'down', nodeId: 'n1', occurrenceIndex: 0, rect: null, clientX: 0, clientY: 0, modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, ancestors: [], pointerId: 1 }
    expect(Value.Check(OutboundRuntimeMessageSchema, { ...base, button: 1, buttons: 4, pointerType: 'mouse' })).toBe(true)
    expect(Value.Check(OutboundRuntimeMessageSchema, { ...base, button: 1, buttons: 4, pointerType: 'stylus' })).toBe(false)
    expect(Value.Check(OutboundRuntimeMessageSchema, { ...base, button: 7, buttons: 4, pointerType: 'mouse' })).toBe(false)
    expect(Value.Check(OutboundRuntimeMessageSchema, { ...base, button: 1, buttons: 64, pointerType: 'mouse' })).toBe(false)
  })

  it('rejects a setResizeTarget without the proportional flag', () => {
    expect(Value.Check(InboundRuntimeMessageSchema, { type: 'setResizeTarget', ref: null })).toBe(false)
  })

  it('rejects a measure:result measurement missing occurrenceIndex', () => {
    expect(
      Value.Check(OutboundRuntimeMessageSchema, {
        type: 'measure:result',
        requestId: 'r1',
        measurements: [{ nodeId: 'n1', rect: null, computedStyle: {} }],
      }),
    ).toBe(false)
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
    const foreign = { source: 'react-devtools-bridge', direction: 'to-frame', message: { type: 'select', refs: [] } }
    expect(Value.Check(InboundEnvelopeSchema, foreign)).toBe(false)
  })
})
