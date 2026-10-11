/**
 * Optimistic-paint messages (parent -> runtime): the placeholder insert, delete,
 * move, style patch and revert the board sends before a write lands, so the
 * live frame shows the edit at once and HMR reconciles it. Split out of
 * `messages.ts` (the inbound/outbound unions still live there) by
 * responsibility; the "optimistic.insert never carries HTML" rule in that
 * file's header applies here.
 */
import { Type, type Static } from '@sinclair/typebox'
import { NodeRefSchema } from './messageShapes'

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
/**
 * The `patch` value that means "this property was cleared": the frame removes the
 * element's inline value, so it shows what its class or the cascade gives it, which
 * is what the file will say once the write lands. A stylesheet rule cannot express
 * "absent" (`unset` would also override a class that sets the property). An empty
 * string already satisfies {@link OPTIMISTIC_STYLE_VALUE_PATTERN}.
 */
export const OPTIMISTIC_STYLE_CLEARED = ''
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

/** How many nodes one `optimistic.revert` names — one structural gesture's worth, with room to spare. */
export const OPTIMISTIC_REVERT_MAX = 512

/**
 * store-17 — a structural write the server refused (or never answered) is
 * taken back: the parent's tree already replayed the gesture's inverse
 * (`structuralCommitRollback.ts`), and this puts back the optimistic hide or
 * move the gesture made in this frame's DOM for exactly these nodes. No HMR
 * follows a write that did not land, so without it the frame kept showing a
 * gesture the file never got.
 */
export const OptimisticRevertMessageSchema = Type.Object({
  type: Type.Literal('optimistic.revert'),
  refs: Type.Array(NodeRefSchema, { maxItems: OPTIMISTIC_REVERT_MAX }),
})

export const OptimisticMessageSchema = Type.Union([
  OptimisticInsertMessageSchema,
  OptimisticDeleteMessageSchema,
  OptimisticMoveMessageSchema,
  OptimisticStyleMessageSchema,
  OptimisticStyleClearMessageSchema,
  OptimisticRevertMessageSchema,
])
export type OptimisticMessage = Static<typeof OptimisticMessageSchema>
