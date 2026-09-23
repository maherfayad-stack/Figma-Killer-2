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
 *
 * ## `occurrenceIndex` (L5) — every node-naming message carries one
 *
 * `runtime.ts`'s `findByNodeId` finds the FIRST DOM element matching a bare
 * stamped `data-node-id` — silently wrong for row 2+ of any `.map()`, since
 * every row's element shares the identical stamp (`idStamp.ts` has no
 * per-iteration information to mint a unique one with; see
 * `liveNodeResolve.ts`'s module doc for the full picture). Every message
 * below that names a node — inbound (`select`'s `refs`, `hover`, `measure`,
 * the four `optimistic.*`, the `text:edit` reply) and outbound (`pointer`,
 * `text:editStart`/`text:commit`/`text:cancel`,
 * `measure:result`'s echoed-back measurements) — pairs the stamp id with a
 * 0-based `occurrenceIndex`: "the Nth element sharing this stamp, in
 * document order" (`nodeIdIndexing.ts`'s `findNthNodeById`/
 * `occurrenceIndexOf`, the ONE implementation of that count, shared with
 * `hmrState.ts`). Defaults to `0` — the common non-`.map()` case, and safe
 * for a sender that doesn't yet know about the sibling-index problem.
 *
 * The stamp id itself is never a canonical tree node id — only
 * `BridgeFrameAdapter` (the L5 parent-side caller) ever sees a bare stamp;
 * every message here already speaks the frame's own stamped-id vocabulary,
 * which `runtime.ts` (in-frame) reads and writes directly.
 */
import { Type, type Static } from '@sinclair/typebox'
import { DropCandidatesMessageSchema, DropCandidatesResultMessageSchema } from './dropCandidateMessages'
import { FrameBlurMessageSchema, KeyMessageSchema } from './keyMessages'
import { NodeRectSchema, PointerModifiersSchema } from './messageShapes'

export { DROP_CANDIDATES_MAX, DROP_CANDIDATE_CHILD_RECTS_MAX, DropCandidatesMessageSchema, DropCandidatesResultMessageSchema, type DropCandidateWire } from './dropCandidateMessages'
export { NodeRectSchema, type NodeRect } from './messageShapes'
export { FrameBlurMessageSchema, KEY_NAME_MAX, KeyMessageSchema, type KeyMessage } from './keyMessages'

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

/** A stamp id paired with which same-stamp DOM occurrence it addresses — see "occurrenceIndex" in the module doc. */
const NodeRefSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
})

/** Sets the `data-*` attributes the ring CSS keys on, and shows/positions the selection ring(s). */
export const SelectMessageSchema = Type.Object({
  type: Type.Literal('select'),
  refs: Type.Array(NodeRefSchema),
})

/** Same, for the hover ring — `null` clears it. */
export const HoverMessageSchema = Type.Object({
  type: Type.Literal('hover'),
  nodeId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
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
  refs: Type.Array(NodeRefSchema),
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
/**
 * `live-13` — which node, if any, carries resize handles right now, decided
 * by the parent (a single selection whose module can carry an inline style —
 * `resizeOffer.ts`); the runtime draws and drags them (`resizeHandles.ts`)
 * and refuses on its own side when the element's computed display ignores a
 * size. `proportional` is `K4`'s scale tool, re-sent whenever it toggles.
 */
export const SetResizeTargetMessageSchema = Type.Object({
  type: Type.Literal('setResizeTarget'),
  ref: Type.Union([NodeRefSchema, Type.Null()]),
  proportional: Type.Boolean(),
})

export const SetModeMessageSchema = Type.Object({
  type: Type.Literal('setMode'),
  mode: RuntimeModeSchema,
})

/** `live-18` — every text-editing message's text ceiling: `sec-06`'s "same-realm spoofing" posture (a script co-resident with `runtime.ts` could otherwise forge an unbounded payload) and a sane cap on a single inline edit either way. */
export const TEXT_EDIT_MAX_LENGTH = 20_000

/**
 * `live-18` — the parent's reply to a frame's `text:editStart` request: it
 * already ran the same predicate `startInlineEdit` applies (module declares
 * `inlineTextEdit`, no children, source-writable, not dynamically bound) and
 * decides here whether `nodeId`/`occurrenceIndex` may be edited inline.
 * `text` — the node's CURRENT canonical value, not necessarily identical to
 * what the frame's DOM shows — seeds the `contentEditable` and is present
 * iff `allowed`.
 */
export const TextEditReplyMessageSchema = Type.Object({
  type: Type.Literal('text:edit'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  allowed: Type.Boolean(),
  text: Type.Optional(Type.String({ maxLength: TEXT_EDIT_MAX_LENGTH })),
})
export type TextEditReplyMessage = Static<typeof TextEditReplyMessageSchema>

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
  parentOccurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
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
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
})

export const OptimisticMoveMessageSchema = Type.Object({
  type: Type.Literal('optimistic.move'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  parentNodeId: Type.String({ minLength: 1 }),
  parentOccurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  index: Type.Number({ minimum: 0 }),
})

/** Sets `textContent`, never `innerHTML` — see the module docblock. */
export const OptimisticTextMessageSchema = Type.Object({
  type: Type.Literal('optimistic.text'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  text: Type.String(),
})

/**
 * `speed-01` — a properties-panel style commit or scrub preview, applied
 * in-frame as a stylesheet rule ahead of the file write + HMR round trip
 * (`optimisticStyle.ts`'s module doc has the full mechanism). Bounded at the
 * SCHEMA, per `sec-06`'s "same-realm spoofing" posture — a script co-resident
 * with `runtime.ts` in the live frame's document could otherwise forge this
 * message directly and inject arbitrary CSS text into the frame's own
 * stylesheet:
 *
 *   - `patch` — at most 64 properties (`maxProperties`, enforced only because
 *     `additionalProperties: false` is set below — see `OPTIMISTIC_STYLE_KEY_PATTERN`'s
 *     own doc for why that flag is load-bearing here). Each KEY matches
 *     `OPTIMISTIC_STYLE_KEY_PATTERN` (bare letters/hyphens only — camelCase or
 *     kebab-case; `optimisticStyle.ts` converts camel -> kebab before writing
 *     the rule). Each VALUE is ≤ 256 chars and excludes `;`, `}`, `<` and the
 *     substring `!important` (a negative lookahead) — the four ways a value
 *     could otherwise close the declaration/rule early or smuggle markup, or
 *     fight the rule's OWN `!important` in a way that changes which one wins.
 *   - `className` — present only for a CLASS-target write (`commitApi.ts`'s
 *     `writeToTarget`/`previewToTarget`), the bare class name
 *     `styleRuleSelector`/`selectionModel.ts` already produced (its leading
 *     `.` stripped). **Informational only** — `optimisticStyle.ts` does NOT
 *     build a `.<className>` selector from it. Dogfooding against a real
 *     project showed that selector matches nothing: `className` is the name
 *     STUDIO'S PARSE gives the class, read out of the CSS-module source, but
 *     the live frame's DOM carries whatever name VITE'S OWN CSS-modules
 *     plugin generated at dev-server build time — two independent hashing
 *     schemes over the same source with no reason to agree, and in practice
 *     they don't. Still bounded (excludes whitespace/`{`/`}`/`;`/`<`) as
 *     defense in depth for whatever future consumer reads it off the wire.
 *
 * `ref` names the element every optimistic style write actually targets —
 * inline or class, both are element-scoped (see `optimisticStyle.ts`'s module
 * doc, "ALWAYS element-scoped"); a class write's other elements catch up on
 * the next HMR update rather than getting an in-frame preview of their own.
 */
const OPTIMISTIC_STYLE_KEY_PATTERN = '^[a-zA-Z-]{1,64}$'
const OPTIMISTIC_STYLE_VALUE_PATTERN = '^(?!.*!important)[^;}<]{0,256}$'
const OPTIMISTIC_STYLE_CLASS_NAME_PATTERN = '^[^\\s{};<]{1,128}$'

export const OptimisticStylePatchSchema = Type.Record(
  Type.String({ pattern: OPTIMISTIC_STYLE_KEY_PATTERN }),
  Type.String({ pattern: OPTIMISTIC_STYLE_VALUE_PATTERN }),
  { maxProperties: 64, additionalProperties: false },
)

export const OptimisticStyleMessageSchema = Type.Object({
  type: Type.Literal('optimistic.style'),
  ref: NodeRefSchema,
  patch: OptimisticStylePatchSchema,
  className: Type.Optional(Type.String({ pattern: OPTIMISTIC_STYLE_CLASS_NAME_PATTERN })),
})

/** Drops whatever optimistic style rule is currently keyed on `ref` — the panel stopped scrubbing with no commit, or the field lost focus. A no-op when nothing is active for it. */
export const OptimisticStyleClearMessageSchema = Type.Object({
  type: Type.Literal('optimistic.style:clear'),
  ref: NodeRefSchema,
})

export const OptimisticMessageSchema = Type.Union([
  OptimisticInsertMessageSchema,
  OptimisticDeleteMessageSchema,
  OptimisticMoveMessageSchema,
  OptimisticTextMessageSchema,
  OptimisticStyleMessageSchema,
  OptimisticStyleClearMessageSchema,
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
  SetResizeTargetMessageSchema,
  TextEditReplyMessageSchema,
  OptimisticInsertMessageSchema,
  OptimisticDeleteMessageSchema,
  OptimisticMoveMessageSchema,
  OptimisticTextMessageSchema,
  OptimisticStyleMessageSchema,
  OptimisticStyleClearMessageSchema,
  DropCandidatesMessageSchema,
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

/** `PointerEvent.pointerType`, or `''` for a plain `MouseEvent` (`click`). */
const PointerTypeSchema = Type.Union([Type.Literal('mouse'), Type.Literal('pen'), Type.Literal('touch'), Type.Literal('')])

/** Feeds `canvasDnd`, marquee selection, and the prototype Player — see L5. */
export const PointerMessageSchema = Type.Object({
  type: Type.Literal('pointer'),
  phase: PointerPhaseSchema,
  nodeId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  rect: Type.Union([NodeRectSchema, Type.Null()]),
  clientX: Type.Number(),
  clientY: Type.Number(),
  modifiers: PointerModifiersSchema,
  /**
   * `live-13` — the button state the parent needs to tell a PAN from a
   * selection (a middle-button press, or Space held with the primary button),
   * and the id that keeps one gesture's moves and its release together when
   * the parent replays them on the iframe element. `PointerEvent.button`
   * is `-1` on a move; `buttons` is a five-bit mask.
   */
  button: Type.Integer({ minimum: -1, maximum: 4 }),
  buttons: Type.Integer({ minimum: 0, maximum: 31 }),
  pointerId: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  pointerType: PointerTypeSchema,
  /**
   * `live-19` — the pointer's position in SCREEN pixels (`MouseEvent.screenX/Y`),
   * identical in the child and the parent regardless of any CSS transform on
   * the iframe and immune to the one-to-two-compositor-frame lag between the
   * parent's own transform write landing and the OUT-OF-PROCESS iframe's last
   * committed layout catching up to it (`useBridgeFrameInteraction.ts`'s
   * module doc has the measured numbers). `clientX/clientY` above are frame-
   * local and therefore USELESS for a pan replay's delta once the frame
   * itself is moving in response to that same replay — `screenX/screenY` is
   * what breaks that feedback loop.
   */
  screenX: Type.Number(),
  screenY: Type.Number(),
  /**
   * `live-12` — every stamped ancestor of the hit, innermost first (`nodeId`
   * repeated as the first entry), bounded. The runtime stamps by SOURCE
   * position, so a click inside a design-system button lands on that
   * package's own internal element — an id the parent's page tree has never
   * heard of. The parent walks this chain to the first node it knows (the
   * call site), which is what the user meant by clicking the button.
   */
  ancestors: Type.Array(NodeRefSchema, { maxItems: 32 }),
})

/**
 * `live-12` — a wheel gesture inside a DESIGN-mode live frame. The parent
 * canvas owns zoom and pan, and a cross-origin frame's wheel never reaches it
 * on its own; the runtime forwards the gesture (having cancelled the frame's
 * own scroll) and the parent re-dispatches it on the iframe element, exactly
 * what `useIframeEventForwarding` does for a portal frame. Never sent in live
 * mode, where the app scrolls itself. Numbers only — nothing here names a
 * node or reaches the DOM.
 */
export const WheelMessageSchema = Type.Object({
  type: Type.Literal('wheel'),
  deltaX: Type.Number(),
  deltaY: Type.Number(),
  /** `WheelEvent.deltaMode`: 0 pixel, 1 line, 2 page. */
  deltaMode: Type.Integer({ minimum: 0, maximum: 2 }),
  clientX: Type.Number(),
  clientY: Type.Number(),
  modifiers: PointerModifiersSchema,
})

/** A committed size, as the source will spell it: an integer pixel count. Bounded so a forged value can never reach the store as an absurd width. */
const CssPixelLengthSchema = Type.String({ pattern: '^[0-9]{1,6}px$' })
/** A committed offset of a positioned element — the same bound, but an offset may be negative. */
const CssPixelOffsetSchema = Type.String({ pattern: '^-?[0-9]{1,6}px$' })

/**
 * `live-13` — a finished drag on the in-frame resize handles
 * (`resizeHandles.ts`) that changed the element's size. The frame previewed
 * the drag itself; the parent commits `patch` to the node's inline style
 * through the store, exactly the write `useElementResizeDrag` makes for a
 * portal frame. Only the properties the drag changed are present, each an
 * integer `px` string — nothing here names a selector or reaches the DOM.
 * The offsets appear only for a `position: absolute | fixed` element whose
 * west/north edge (or centre, under ⌥) moved (IX-6d).
 */
export const ResizeCommitMessageSchema = Type.Object({
  type: Type.Literal('resize:commit'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  patch: Type.Object({
    width: Type.Optional(CssPixelLengthSchema),
    height: Type.Optional(CssPixelLengthSchema),
    left: Type.Optional(CssPixelOffsetSchema),
    insetInlineStart: Type.Optional(CssPixelOffsetSchema),
    top: Type.Optional(CssPixelOffsetSchema),
  }),
})

/**
 * `live-18` — a double-click on a stamped element inside a DESIGN-mode
 * frame; the runtime asks, the parent decides (via the inbound
 * {@link TextEditReplyMessageSchema} reply above) whether this node is
 * text-editable at all — the runtime has no page-tree/module knowledge to
 * decide that itself.
 */
export const TextEditStartMessageSchema = Type.Object({
  type: Type.Literal('text:editStart'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
})

/** `live-18` — Enter (no Shift) or blur ended the session with this final text, bounded per {@link TEXT_EDIT_MAX_LENGTH}. */
export const TextCommitMessageSchema = Type.Object({
  type: Type.Literal('text:commit'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  text: Type.String({ maxLength: TEXT_EDIT_MAX_LENGTH }),
})

/** `live-18` — Escape, or an HMR update landing mid-edit, ended the session with no write. */
export const TextCancelMessageSchema = Type.Object({
  type: Type.Literal('text:cancel'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
})

const NodeMeasurementSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  /** Echoes back the `occurrenceIndex` from the matching {@link NodeRefSchema} this measurement was requested for. */
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
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

/**
 * Posted whenever the frame's own `documentElement` content height changes —
 * the cross-origin replacement for portal mode's `ResizeObserver` on the
 * iframe's own `contentWindow` (impossible by construction for a bridge
 * frame; see `frameFitRules.ts`'s module doc and `live-05`'s STATE.md entry,
 * "The frame-height gap L4 did not cover"). Throttled to one post per
 * animation frame in `runtime.ts`, the same rAF-coalescing shape as
 * `scheduleReposition` there.
 *
 * `maximum` is a defense-in-depth bound, not a real content ceiling — an
 * honest `runtime.ts` never reports anywhere near it (`frameFitRules.ts`'s
 * own `MAX_FRAME_FIT_HEIGHT` caps the fit PIN at 20000, and real page
 * content is finite). It exists because `sec-06`'s "same-realm spoofing"
 * finding applies to THIS message too: a script co-resident with `runtime.ts`
 * in the live frame's document can forge a `frame:resize` postMessage
 * directly, bypassing the honest sender entirely. `minimum`/`Type.Number`
 * already reject `NaN`/`Infinity`; this additionally rejects an absurd but
 * finite forged value (e.g. `1e20`) from ever reaching
 * `useIframeFrameAutoHeight.ts`'s arithmetic and being written as the outer
 * `<iframe>` element's height on the trusted parent canvas.
 */
export const FrameResizeMessageSchema = Type.Object({
  type: Type.Literal('frame:resize'),
  height: Type.Number({ minimum: 0, maximum: 1_000_000 }),
})

/**
 * Upper bounds on the three free-text fields {@link ErrorMessageSchema}
 * carries. They match `canvasDiagnosticsBuffer.ts`'s own `MAX_MESSAGE_LENGTH`/
 * `MAX_STACK_LENGTH` deliberately: a value that passes validation here is
 * stored verbatim on the parent rather than truncated a second time to a
 * different length, so what the badge shows and what
 * `studio_page_diagnostics` returns are the same string.
 *
 * They are also the `sec-06` bound. The honest sender (`runtime.ts`) already
 * truncates to exactly these, so the schema never rejects a real message — the
 * `maxLength` exists for the FORGED one. `sec-06`'s "same-realm spoofing"
 * finding applies here with more force than to any other outbound message: a
 * script co-resident with `runtime.ts` in the live frame's document can post a
 * `to-parent` envelope directly, and this message's whole payload is
 * attacker-chosen text that the parent then renders in its own trusted
 * document. Unbounded, that is a memory-exhaustion and UI-wrecking primitive.
 * Bounded, the worst case is 1.3 KB of nonsense in a popover.
 */
export const RUNTIME_ERROR_MESSAGE_MAX = 400
export const RUNTIME_ERROR_STACK_MAX = 600
export const RUNTIME_ERROR_SOURCE_MAX = 300

/**
 * Which tap produced an {@link ErrorMessageSchema}. One literal per tap
 * `runtime.ts` installs, matching the four `CanvasDiagnosticsInjector.tsx`
 * has always installed for portal mode, plus `network`:
 *
 *   - `exception`          — an `ErrorEvent` reached `window.onerror`.
 *   - `unhandledrejection` — an async failure that never reaches `onerror`.
 *   - `resource`           — an `<img>`/`<script>`/`<link>`/… failed to load.
 *   - `console`            — `console.error`, which is the ONLY channel React
 *                            reports a failed render/invalid hook call/
 *                            hydration mismatch through.
 *   - `network`            — a `fetch()` from inside the frame rejected or
 *                            answered non-2xx.
 *
 * `network` is deliberately its own kind rather than folded into `resource`,
 * even though both are "something did not load": the parent maps these
 * one-to-one onto the FROZEN `PageDiagnosticCode` vocabulary
 * (`@core/ai`'s `pageDiagnostics.ts`), where `asset-load-failed` and
 * `network-request-failed` are separate codes with separate severities and
 * separate fixes. Collapsing them on the wire would mean a Tier-2 frame's
 * findings could never reach `network-request-failed` at all, while a Tier-0
 * frame's do — the same failure classified differently depending on which
 * canvas mode you happened to be in.
 */
export const RuntimeErrorKindSchema = Type.Union([
  Type.Literal('exception'),
  Type.Literal('unhandledrejection'),
  Type.Literal('resource'),
  Type.Literal('console'),
  Type.Literal('network'),
])
export type RuntimeErrorKind = Static<typeof RuntimeErrorKindSchema>

/**
 * Z5 — something went wrong inside the live frame, reported once, passively.
 *
 * A crash in a Tier-2 frame used to reach nothing in Studio: the frame painted
 * a blank rectangle, its own console said exactly what happened to nobody, and
 * the board offered no way to tell "this screen is empty" from "this screen
 * threw". This message is the channel that was missing. The parent routes it
 * into `canvasDiagnosticsBuffer.ts` (so `studio_page_diagnostics` sees Tier-2
 * frames, not only portal ones) and into a passive per-frame badge. **Never a
 * toast** — a render loop emits the same error hundreds of times a second, and
 * the whole point of the buffer is that a repeated failure is one entry with a
 * count.
 *
 * `message`/`stack`/`source` are the only payload, all `maxLength`-bounded
 * above. Deliberately NO node id: `runtime.ts` speaks stamped ids and the
 * parent would have to translate, and a stack with a `file:line` already
 * answers "where" for every kind here. Deliberately no HTTP status either —
 * the status is in the `message` text, and one fewer structured field is one
 * fewer thing a forged message can lie about in a way the parent branches on.
 *
 * Capped and rate-limited at the SENDER (`runtime.ts`: 10 posts/second, 50 per
 * document) rather than only at the receiver, because the cost being bounded is
 * the postMessage traffic itself, not the storage.
 */
export const ErrorMessageSchema = Type.Object({
  type: Type.Literal('error'),
  kind: RuntimeErrorKindSchema,
  message: Type.String({ minLength: 1, maxLength: RUNTIME_ERROR_MESSAGE_MAX }),
  /** First frames of a stack, when the thrown/rejected value carried one. */
  stack: Type.Optional(Type.String({ maxLength: RUNTIME_ERROR_STACK_MAX })),
  /** Where it came from: a script `file:line:col` for an exception, the requested URL for a resource/network failure. */
  source: Type.Optional(Type.String({ maxLength: RUNTIME_ERROR_SOURCE_MAX })),
})

export const OutboundRuntimeMessageSchema = Type.Union([
  ReadyMessageSchema,
  HmrBeforeMessageSchema,
  HmrAfterMessageSchema,
  PointerMessageSchema,
  WheelMessageSchema,
  ResizeCommitMessageSchema,
  TextEditStartMessageSchema,
  TextCommitMessageSchema,
  TextCancelMessageSchema,
  MeasureResultMessageSchema,
  FrameResizeMessageSchema,
  ErrorMessageSchema,
  DropCandidatesResultMessageSchema,
  KeyMessageSchema,
  FrameBlurMessageSchema,
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
