/**
 * The second wire contract between the headless capture DRIVER (server) and the
 * headless capture PAGE (browser): ask a settled frame a QUESTION about itself,
 * rather than photograph it.
 *
 * `captureWire.ts` covers the one thing every capture does — mount, settle,
 * report geometry, get rasterised. Two tools need something a PNG cannot carry:
 *
 *   - `studio_computed_styles` needs what the CSS actually RESOLVED to (the
 *     real px, the real weight, and the font the text is genuinely set in),
 *   - `studio_measure_element` needs the rendered BOXES and the gaps between
 *     them, so a spacing fix is arithmetic instead of a guess off a picture.
 *
 * Both are reads of the settled frame document. So instead of two more globals
 * and two more settle paths, the page exposes ONE function —
 * `window[AGENT_CAPTURE_INSPECT_GLOBAL]` — that takes a JSON request string and
 * returns a JSON response string. Strings on both sides because the driver runs
 * in Bun and the page in Chromium: there is no shared realm to hand a value
 * across, and `page.evaluate` gets an expression, not a closure.
 *
 * Both directions are TypeBox-validated. The page validates the request (it is
 * a string arriving from outside its own code) and the driver validates the
 * response (it is a string arriving from a browser it does not control).
 *
 * The same request/response pair is answered by the LIVE editor's frame too
 * (`studioComputedStyles.ts`), running the identical
 * `frameInspector.ts` implementation against the live canvas iframe — so the
 * headless answer and the live-tab fallback cannot drift.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * `window.__studioAgentCaptureInspect(requestJson) -> responseJson`.
 *
 * Installed by the capture page at module load, next to
 * `AGENT_CAPTURE_GLOBAL`, and only ever called after the readiness report says
 * `ready` — an inspect of an unsettled frame would measure a mid-layout DOM.
 */
export const AGENT_CAPTURE_INSPECT_GLOBAL = '__studioAgentCaptureInspect'

/** Default/maximum reported node counts, shared by both halves so a cap is never a surprise. */
export const INSPECT_COMPUTED_STYLES_DEFAULT_LIMIT = 80
export const INSPECT_COMPUTED_STYLES_MAX_LIMIT = 300
export const INSPECT_MEASURE_DEFAULT_LIMIT = 40
export const INSPECT_MEASURE_MAX_LIMIT = 200

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const AgentComputedStylesRequestSchema = Type.Object({
  kind: Type.Literal('computedStyles'),
  pageId: Type.String({ minLength: 1 }),
  nodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  textOnly: Type.Optional(Type.Boolean()),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: INSPECT_COMPUTED_STYLES_MAX_LIMIT }),
  ),
})

export const AgentMeasureRequestSchema = Type.Object({
  kind: Type.Literal('measure'),
  pageId: Type.String({ minLength: 1 }),
  nodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  /** A CSS selector evaluated INSIDE the frame document. Unioned with `nodeIds` when both are given. */
  selector: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: INSPECT_MEASURE_MAX_LIMIT })),
})

export const AgentFrameInspectRequestSchema = Type.Union([
  AgentComputedStylesRequestSchema,
  AgentMeasureRequestSchema,
])
export type AgentFrameInspectRequest = Static<typeof AgentFrameInspectRequestSchema>

// ---------------------------------------------------------------------------
// Response — computed styles
// ---------------------------------------------------------------------------

export const AgentComputedStyleRowSchema = Type.Object({
  nodeId: Type.String(),
  tag: Type.String(),
  /** This node's OWN text, truncated. Absent for a container. */
  text: Type.Optional(Type.String()),
  /**
   * The first family in the declared stack the document can actually render
   * with — NOT the declared stack. A stack whose first family never loaded
   * looks identical to one that did, and that difference makes correct px read
   * as the wrong size.
   */
  fontFamily: Type.String(),
  fontSizePx: Type.Number(),
  lineHeightPx: Type.Union([Type.Number(), Type.Null()]),
  fontWeight: Type.String(),
  color: Type.String(),
  backgroundColor: Type.String(),
  borderRadius: Type.Optional(Type.String()),
  padding: Type.Optional(Type.String()),
  rect: Type.Object({ width: Type.Number(), height: Type.Number() }),
})
export type AgentComputedStyleRow = Static<typeof AgentComputedStyleRowSchema>

export const AgentComputedStylesResultSchema = Type.Object({
  kind: Type.Literal('computedStyles'),
  pageId: Type.String(),
  nodeCount: Type.Integer(),
  truncated: Type.Boolean(),
  skippedWithoutOwnText: Type.Optional(Type.Integer()),
  /** Every family actually in use — one unexpected entry here is a font that failed to load. */
  fontFamiliesInUse: Type.Array(Type.String()),
  nodes: Type.Array(AgentComputedStyleRowSchema),
})
export type AgentComputedStylesResult = Static<typeof AgentComputedStylesResultSchema>

// ---------------------------------------------------------------------------
// Response — measurement
// ---------------------------------------------------------------------------

export const AgentEdgeInsetsSchema = Type.Object({
  top: Type.Number(),
  right: Type.Number(),
  bottom: Type.Number(),
  left: Type.Number(),
})

/**
 * The parent's own layout, because a gap only means something next to the rule
 * that produced it: a 24px measured gap under a `gap: 16px` parent says an
 * extra margin is in play, which the child's own numbers alone never reveal.
 */
export const AgentMeasuredParentSchema = Type.Object({
  nodeId: Type.Optional(Type.String()),
  tag: Type.String(),
  display: Type.String(),
  flexDirection: Type.Optional(Type.String()),
  /** Declared `row-gap`/`column-gap` in px where they resolve to a length; `null` for `normal`. */
  rowGapPx: Type.Union([Type.Number(), Type.Null()]),
  columnGapPx: Type.Union([Type.Number(), Type.Null()]),
  paddingPx: AgentEdgeInsetsSchema,
  rect: Type.Object({
    x: Type.Number(),
    y: Type.Number(),
    width: Type.Number(),
    height: Type.Number(),
  }),
})

export const AgentMeasuredElementSchema = Type.Object({
  nodeId: Type.String(),
  tag: Type.String(),
  text: Type.Optional(Type.String()),
  /** Frame-local CSS px, measured against the frame's own `documentElement` — the same origin `nodeRects` uses. */
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  paddingPx: AgentEdgeInsetsSchema,
  marginPx: AgentEdgeInsetsSchema,
  borderPx: AgentEdgeInsetsSchema,
  /**
   * Which axis the siblings are laid out along, so `gapBeforePx`/`gapAfterPx`
   * are read against the right edges. `inline` for a row flex container,
   * `block` otherwise (including grid, where the honest answer is the stacking
   * direction of the rendered boxes).
   */
  siblingAxis: Type.Union([Type.Literal('inline'), Type.Literal('block')]),
  /** Measured distance to the previous/next rendered sibling along `siblingAxis`. Absent when there is none. */
  gapBeforePx: Type.Optional(Type.Number()),
  gapAfterPx: Type.Optional(Type.Number()),
  parent: Type.Optional(AgentMeasuredParentSchema),
})
export type AgentMeasuredElement = Static<typeof AgentMeasuredElementSchema>

export const AgentMeasureResultSchema = Type.Object({
  kind: Type.Literal('measure'),
  pageId: Type.String(),
  /** The frame's own rendered size — every `x`/`y` below is relative to its top-left. */
  frame: Type.Object({ width: Type.Number(), height: Type.Number() }),
  matched: Type.Integer(),
  truncated: Type.Boolean(),
  /** Requested node ids that render nothing in this frame — a real answer, not an empty result. */
  unmatched: Type.Array(Type.String()),
  elements: Type.Array(AgentMeasuredElementSchema),
})
export type AgentMeasureResult = Static<typeof AgentMeasureResultSchema>

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export const AgentFrameInspectResultSchema = Type.Union([
  AgentComputedStylesResultSchema,
  AgentMeasureResultSchema,
])
export type AgentFrameInspectResult = Static<typeof AgentFrameInspectResultSchema>

export const AgentFrameInspectResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), result: AgentFrameInspectResultSchema }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
])
export type AgentFrameInspectResponse = Static<typeof AgentFrameInspectResponseSchema>
