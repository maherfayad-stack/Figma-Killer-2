/**
 * messages — the postMessage wire contract between the parent editor and the
 * in-frame live runtime (`runtime.ts`), TypeBox-validated in both
 * directions (L2's decision doc, STUDIO-LIVE-CANVAS-PLAN.md §1.1: a live
 * frame is cross-origin by construction, so `postMessage` is the only
 * channel, and both ends validate what crosses it).
 *
 * Imports `@sinclair/typebox` directly rather than `@core/utils/typeboxHelpers`
 * — this file ships inside the runtime bundle served to a real browser from
 * the live origin, and stays intentionally free of the compiled-validator
 * cache machinery that helper pulls in. `Value.Check` (imported by callers
 * from `@sinclair/typebox/value`) is enough for a message-sized payload.
 *
 * ## Envelope
 *
 * Every message is wrapped in {@link RuntimeEnvelopeSchema} before it is
 * posted: a `source` tag (so a stray `postMessage` from React DevTools, a
 * browser extension, or Vite's own HMR client is never mistaken for one of
 * ours) and a `direction` tag (so a frame that somehow received its own
 * outbound echo — e.g. a misconfigured relay — refuses to act on it as if it
 * were inbound). Both ends check `event.origin` against the expected origin
 * BEFORE even attempting to parse the envelope — that check lives in
 * `runtime.ts` / the (L5) parent-side adapter, not here, because only the
 * caller knows which origin to expect.
 *
 * ## Two additions beyond the plan's literal message table
 *
 *   - `setMode` (inbound) — the runtime has no other way to know whether to
 *     run hover-suppression / scroll-unroll / animation-freeze / rings at
 *     all. A live Tier-2 frame is mounted for BOTH the still design board
 *     (`'design'`) and the real-size live/preview view (`'live'`) — exactly
 *     the same two `CanvasInteractionContext` values a Tier-0 portal frame
 *     already carries (`docs/agent-refs/canvas-internals.md` → "Interaction
 *     modes"). Without an explicit mode message the runtime cannot tell
 *     which column of that table it is rendering into.
 *   - `measure:result` (outbound) — a `measure` request with no reply is
 *     unimplementable; the inspector's prefill needs the answer, not just
 *     the ask.
 *
 * ## `optimistic.insert` never carries HTML
 *
 * `tagName`/`text` are structured fields, not a raw HTML string, precisely so
 * there is no `innerHTML` injection surface for what is, in the end, a
 * placeholder HMR replaces within milliseconds. `runtime.ts`'s handler uses
 * `document.createElement` + `Node.textContent`, never `innerHTML`.
 */
import { Type, type Static } from '@sinclair/typebox'

/** The `source` every envelope carries, so unrelated `postMessage` traffic is ignored outright. */
export const RUNTIME_MESSAGE_SOURCE = 'studio-live-runtime'

// ---------------------------------------------------------------------------
// Shared leaf schemas
// ---------------------------------------------------------------------------

const DirectionSchema = Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])
const ColorSchemeSchema = Type.Union([Type.Literal('light'), Type.Literal('dark')])

/** The two `CanvasInteractionContext` values a frame can be rendering into. See {@link SetModeMessageSchema}. */
export const RuntimeModeSchema = Type.Union([Type.Literal('design'), Type.Literal('live')])
export type RuntimeMode = Static<typeof RuntimeModeSchema>

const NodeRectSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})
export type NodeRect = Static<typeof NodeRectSchema>

const PointerModifiersSchema = Type.Object({
  shiftKey: Type.Boolean(),
  altKey: Type.Boolean(),
  ctrlKey: Type.Boolean(),
  metaKey: Type.Boolean(),
})

// ---------------------------------------------------------------------------
// Inbound — parent -> frame
// ---------------------------------------------------------------------------

/**
 * The stylesheet an injector used to append to `<head>` in the portal world
 * (`EditorChrome`, `ClassStyle`, `CanvasAnimation`, `ScrollUnroll`,
 * `HoverSuppression`, selection ring CSS): the parent computes the CSS text
 * (reusing the SAME rule modules the portal injectors use) and the runtime
 * mounts/updates a `<style id={id}>` with it verbatim. Generic on purpose —
 * the runtime does not need to know what each `id` MEANS to manage it.
 */
export const ApplyOverlayMessageSchema = Type.Object({
  type: Type.Literal('applyOverlay'),
  id: Type.String({ minLength: 1 }),
  css: Type.String(),
})

export const RemoveOverlayMessageSchema = Type.Object({
  type: Type.Literal('removeOverlay'),
  id: Type.String({ minLength: 1 }),
})

/** Sets the `data-*` attributes the ring CSS keys on, and shows/positions the selection ring(s). */
export const SelectMessageSchema = Type.Object({
  type: Type.Literal('select'),
  nodeIds: Type.Array(Type.String({ minLength: 1 })),
})

/** Same, for the hover ring — `null` clears it. */
export const HoverMessageSchema = Type.Object({
  type: Type.Literal('hover'),
  nodeId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
})

/**
 * Requests rects + a bounded set of computed-style properties for the
 * inspector's prefill. `properties` is explicit and optional (default: a
 * small, documented set — see `runtime.ts`'s `DEFAULT_MEASURED_PROPERTIES`)
 * rather than "every computed property", which would make the reply payload
 * unbounded.
 */
export const MeasureMessageSchema = Type.Object({
  type: Type.Literal('measure'),
  requestId: Type.String({ minLength: 1 }),
  nodeIds: Type.Array(Type.String({ minLength: 1 })),
  properties: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
})

/**
 * The render-time preview axes (`docs/agent-refs/canvas-internals.md` →
 * "Preview axes"), applied as attributes on `document.documentElement`. Only
 * `direction`/`colorScheme`/`locale` cross the wire — `locale` here is inert
 * metadata (Studio's `locale` axis is PARSE-time, i.e. it changes which page
 * variant is loaded server-side, not an attribute a live frame's own
 * document can apply to itself).
 */
export const SetAxesMessageSchema = Type.Object({
  type: Type.Literal('setAxes'),
  axes: Type.Object({
    direction: DirectionSchema,
    colorScheme: ColorSchemeSchema,
    locale: Type.Optional(Type.String({ minLength: 1 })),
  }),
})

/** See "Two additions" in the module docblock. */
export const SetModeMessageSchema = Type.Object({
  type: Type.Literal('setMode'),
  mode: RuntimeModeSchema,
})

/**
 * `tagName`/`text` only — see "optimistic.insert never carries HTML" above.
 * `parentNodeId`/`index` place it exactly where the eventual writeback will;
 * HMR reconciles the placeholder with the real component once the file
 * write lands.
 */
/**
 * Bare alphanumeric tag names only. This regex is case-SENSITIVE (TypeBox's
 * `pattern` compiles to a plain `new RegExp(pattern)` with no flags, and
 * ECMAScript regex has no inline case-insensitive modifier), so it cannot
 * itself be the guard against a dangerous element name typed in a different
 * case (`SCRIPT`, `IFrame`, ...) — `document.createElement` normalizes case
 * for HTML tags regardless of how it was spelled. The case-insensitive
 * denylist against `DANGEROUS_TAG_NAMES` lives in `runtime.ts`'s
 * `handleOptimisticInsert`, right next to the `createElement` call it
 * protects, using a plain `.toLowerCase()` comparison instead.
 */
export const OptimisticInsertMessageSchema = Type.Object({
  type: Type.Literal('optimistic.insert'),
  nodeId: Type.String({ minLength: 1 }),
  parentNodeId: Type.String({ minLength: 1 }),
  index: Type.Number({ minimum: 0 }),
  tagName: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-zA-Z][a-zA-Z0-9-]*$' }),
  text: Type.Optional(Type.String()),
})

/**
 * Elements that can execute code or load external documents/subresources by
 * merely being connected to the DOM (`<script>`, `<iframe>`, `<embed>`,
 * `<object>`, `<link>`, `<base>`) or that would silently reinterpret this
 * frame's own chrome (`<style>`) — never a legitimate `optimistic.insert`
 * target. The origin+source+envelope checks in `runtime.ts` already make
 * this message unreachable from anything but the trusted parent, so this is
 * defense-in-depth, not the only guard — but it is a single, cheap place to
 * hold the line if that assumption is ever wrong (a future looser
 * parent-side caller, a bug upstream of this schema). Compared
 * case-insensitively — see the module doc on `OptimisticInsertMessageSchema`.
 */
export const DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES = new Set([
  'script',
  'iframe',
  'embed',
  'object',
  'link',
  'base',
  'style',
  'frame',
  'frameset',
])

export const OptimisticDeleteMessageSchema = Type.Object({
  type: Type.Literal('optimistic.delete'),
  nodeId: Type.String({ minLength: 1 }),
})

export const OptimisticMoveMessageSchema = Type.Object({
  type: Type.Literal('optimistic.move'),
  nodeId: Type.String({ minLength: 1 }),
  parentNodeId: Type.String({ minLength: 1 }),
  index: Type.Number({ minimum: 0 }),
})

/** Sets `textContent`, never `innerHTML` — see the module docblock. */
export const OptimisticTextMessageSchema = Type.Object({
  type: Type.Literal('optimistic.text'),
  nodeId: Type.String({ minLength: 1 }),
  text: Type.String(),
})

export const OptimisticMessageSchema = Type.Union([
  OptimisticInsertMessageSchema,
  OptimisticDeleteMessageSchema,
  OptimisticMoveMessageSchema,
  OptimisticTextMessageSchema,
])
export type OptimisticMessage = Static<typeof OptimisticMessageSchema>

export const InboundRuntimeMessageSchema = Type.Union([
  ApplyOverlayMessageSchema,
  RemoveOverlayMessageSchema,
  SelectMessageSchema,
  HoverMessageSchema,
  MeasureMessageSchema,
  SetAxesMessageSchema,
  SetModeMessageSchema,
  OptimisticInsertMessageSchema,
  OptimisticDeleteMessageSchema,
  OptimisticMoveMessageSchema,
  OptimisticTextMessageSchema,
])
export type InboundRuntimeMessage = Static<typeof InboundRuntimeMessageSchema>

// ---------------------------------------------------------------------------
// Outbound — frame -> parent
// ---------------------------------------------------------------------------

/** Posted once after boot — the parent holds selection/measurement requests until this arrives. */
export const ReadyMessageSchema = Type.Object({
  type: Type.Literal('ready'),
})

/** Vite's `vite:beforeUpdate` — the parent may want to hold selection across the coming DOM change. */
export const HmrBeforeMessageSchema = Type.Object({
  type: Type.Literal('hmr:before'),
})

/** Vite's `vite:afterUpdate` — the parent re-measures whatever it was holding. */
export const HmrAfterMessageSchema = Type.Object({
  type: Type.Literal('hmr:after'),
})

const PointerPhaseSchema = Type.Union([
  Type.Literal('down'),
  Type.Literal('move'),
  Type.Literal('up'),
  Type.Literal('click'),
])

/** Feeds `canvasDnd`, marquee selection, and the prototype Player — see L5. */
export const PointerMessageSchema = Type.Object({
  type: Type.Literal('pointer'),
  phase: PointerPhaseSchema,
  nodeId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  rect: Type.Union([NodeRectSchema, Type.Null()]),
  clientX: Type.Number(),
  clientY: Type.Number(),
  modifiers: PointerModifiersSchema,
})

/** Routed by the parent to the existing `textOrigin` writeback (L7) — carries the CURRENT text, not a diff. */
export const TextEditMessageSchema = Type.Object({
  type: Type.Literal('text:edit'),
  nodeId: Type.String({ minLength: 1 }),
  text: Type.String(),
})

const NodeMeasurementSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  rect: Type.Union([NodeRectSchema, Type.Null()]),
  computedStyle: Type.Record(Type.String(), Type.String()),
})
export type NodeMeasurement = Static<typeof NodeMeasurementSchema>

/** The reply to {@link MeasureMessageSchema}, correlated by `requestId`. */
export const MeasureResultMessageSchema = Type.Object({
  type: Type.Literal('measure:result'),
  requestId: Type.String({ minLength: 1 }),
  measurements: Type.Array(NodeMeasurementSchema),
})

export const OutboundRuntimeMessageSchema = Type.Union([
  ReadyMessageSchema,
  HmrBeforeMessageSchema,
  HmrAfterMessageSchema,
  PointerMessageSchema,
  TextEditMessageSchema,
  MeasureResultMessageSchema,
])
export type OutboundRuntimeMessage = Static<typeof OutboundRuntimeMessageSchema>

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export const InboundEnvelopeSchema = Type.Object({
  source: Type.Literal(RUNTIME_MESSAGE_SOURCE),
  direction: Type.Literal('to-frame'),
  message: InboundRuntimeMessageSchema,
})
export type InboundEnvelope = Static<typeof InboundEnvelopeSchema>

export const OutboundEnvelopeSchema = Type.Object({
  source: Type.Literal(RUNTIME_MESSAGE_SOURCE),
  direction: Type.Literal('to-parent'),
  message: OutboundRuntimeMessageSchema,
})
export type OutboundEnvelope = Static<typeof OutboundEnvelopeSchema>

export function toInboundEnvelope(message: InboundRuntimeMessage): InboundEnvelope {
  return { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-frame', message }
}

export function toOutboundEnvelope(message: OutboundRuntimeMessage): OutboundEnvelope {
  return { source: RUNTIME_MESSAGE_SOURCE, direction: 'to-parent', message }
}
