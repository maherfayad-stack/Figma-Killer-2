/**
 * resizeMessages — the resize half of the parent ↔ frame wire (`live-13`,
 * canvas-23, canvas-26): which node carries handles and what the frame needs
 * to size and snap it like a portal frame does, and what a finished or moving
 * drag reports back. Split from `messages.ts` for the module-size budget, the
 * same way `keyMessages.ts` is; `messages.ts` re-exports the public names so
 * `@core/studio-runtime` consumers see one surface.
 *
 * Every field is bounded at the schema (`sec-06`'s "same-realm spoofing"
 * posture): a script co-resident with the runtime can post a `to-parent`
 * envelope directly, and `resize:commit` is written into the user's source.
 */
import { Type, type Static } from '@sinclair/typebox'
import { RESIZE_HANDLES } from './elementResizeRules'
import { FLEX_MAIN_FIXED_VALUE } from './elementSizingRules'
import { NodeRefSchema } from './messageShapes'

/** Longest stored sizing marker the wire carries — `flex: 1 1 0%` and friends are far inside it. */
const SIZING_MARKER_MAX = 64

/**
 * The node's STORED inline sizing markers — exactly the declarations the
 * Fixed switch (`elementSizingRules.ts`'s `sizingPatch('fixed')`) reads to
 * decide what a resize clears. Only the parent has the page tree, so it sends
 * them; the frame has the other two inputs (the parent's layout and the
 * cascade) and plans the companions itself (`elementResizeSizing.ts`).
 */
export const ResizeSizingMarkersSchema = Type.Object(
  {
    flex: Type.Optional(Type.String({ maxLength: SIZING_MARKER_MAX })),
    alignSelf: Type.Optional(Type.String({ maxLength: SIZING_MARKER_MAX })),
    justifySelf: Type.Optional(Type.String({ maxLength: SIZING_MARKER_MAX })),
  },
  { additionalProperties: false },
)
export type ResizeSizingMarkers = Static<typeof ResizeSizingMarkersSchema>

/** Siblings a resize snaps to — more than any real container shows; the rest is not worth a guide. */
export const RESIZE_SNAP_SIBLINGS_MAX = 256

/**
 * What the moving edge snaps to (P2-E / IX-6e): the node's tree siblings and
 * its tree parent, as the frame's own refs — the frame cannot know which DOM
 * elements are the node's siblings in the TREE — and the canvas zoom, which a
 * cross-origin frame cannot read, for the screen-px threshold (IX-5a).
 */
export const ResizeSnapContextSchema = Type.Object({
  siblings: Type.Array(NodeRefSchema, { maxItems: RESIZE_SNAP_SIBLINGS_MAX }),
  parent: Type.Union([NodeRefSchema, Type.Null()]),
  zoom: Type.Number({ exclusiveMinimum: 0, maximum: 256 }),
})
export type ResizeSnapContext = Static<typeof ResizeSnapContextSchema>

/** An offset a positioned layer may be anchored by — a key of the element's `style={{…}}` object. */
export const OffsetPropertySchema = Type.Union([
  Type.Literal('left'),
  Type.Literal('right'),
  Type.Literal('insetInlineStart'),
  Type.Literal('insetInlineEnd'),
  Type.Literal('top'),
  Type.Literal('bottom'),
])
export type OffsetProperty = Static<typeof OffsetPropertySchema>

/**
 * PA-8 — which offsets the node's SOURCE authors, per axis. Only the parent
 * has the page tree and the style rules; the frame reads the offsets' used
 * values itself. With them a W-drag on a `right`-anchored layer writes the
 * width alone, as a portal frame's drag does (`elementResizeAnchors.ts`).
 */
export const ResizeAnchorsSchema = Type.Object({
  horizontal: Type.Array(OffsetPropertySchema, { maxItems: 4 }),
  vertical: Type.Array(OffsetPropertySchema, { maxItems: 2 }),
})
export type ResizeAnchors = Static<typeof ResizeAnchorsSchema>

/**
 * `live-13` — which node, if any, a resize drag would size right now, decided
 * by the parent (a single selection whose module can carry an inline style —
 * `resizeOffer.ts`); the parent draws the handles and the frame sizes the
 * element (`resizeSession.ts`), refusing on its own side when the element's
 * computed display ignores a size. `proportional` is `K4`'s scale tool,
 * re-sent whenever it toggles. `sizing` (canvas-23) and `snap` (canvas-26) are
 * re-sent whenever they change; a drag reads both once, when it begins.
 */
export const SetResizeTargetMessageSchema = Type.Object({
  type: Type.Literal('setResizeTarget'),
  ref: Type.Union([NodeRefSchema, Type.Null()]),
  proportional: Type.Boolean(),
  sizing: Type.Optional(ResizeSizingMarkersSchema),
  snap: Type.Optional(ResizeSnapContextSchema),
  anchors: Type.Optional(ResizeAnchorsSchema),
})

const ResizeHandleSchema = Type.Union(RESIZE_HANDLES.map((handle) => Type.Literal(handle)))

/** A drag distance in frame px — bounded so a forged step cannot size an element past anything real. */
const DragDeltaSchema = Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })

/**
 * SB-4 — a handle on the parent's resize chrome was pressed: the frame reads
 * the target's layout once and starts previewing. The pointer is the PARENT's
 * (captured on its own handle), so what follows is `resize:step` / `resize:end`
 * rather than pointer events inside the frame.
 */
export const ResizeBeginMessageSchema = Type.Object({
  type: Type.Literal('resize:begin'),
  handle: ResizeHandleSchema,
})

/** SB-4 — the pointer moved: its distance from the press in frame px (the parent has divided out the zoom), and ⇧ / ⌥ as held NOW. One per animation frame. */
export const ResizeStepMessageSchema = Type.Object({
  type: Type.Literal('resize:step'),
  dx: DragDeltaSchema,
  dy: DragDeltaSchema,
  shiftKey: Type.Boolean(),
  altKey: Type.Boolean(),
})

/** SB-4 — the drag ended: `commit` for a release, not for Escape / a lost pointer. */
export const ResizeEndMessageSchema = Type.Object({
  type: Type.Literal('resize:end'),
  commit: Type.Boolean(),
})

/** A committed size, as the source will spell it: an integer pixel count. Bounded so a forged value can never reach the store as an absurd width. */
const CssPixelLengthSchema = Type.String({ pattern: '^[0-9]{1,6}px$' })
/** A committed offset of a positioned element — the same bound, but an offset may be negative. */
const CssPixelOffsetSchema = Type.String({ pattern: '^-?[0-9]{1,6}px$' })

/**
 * The inline-style patch a finished drag commits. The size and offsets are
 * integer `px` strings, present only when the drag changed them. The three
 * Fixed companions (IX-6b) can say only what `sizingPatch('fixed')` ever
 * says: `flex` becomes CSS's initial `0 1 auto` or is cleared, a stretch
 * marker is cleared. `null` clears. No other key is accepted — this object
 * goes into the element's `style={{…}}` in the user's source.
 */
export const ResizeCommitPatchSchema = Type.Object(
  {
    width: Type.Optional(CssPixelLengthSchema),
    height: Type.Optional(CssPixelLengthSchema),
    left: Type.Optional(CssPixelOffsetSchema),
    insetInlineStart: Type.Optional(CssPixelOffsetSchema),
    top: Type.Optional(CssPixelOffsetSchema),
    right: Type.Optional(CssPixelOffsetSchema),
    insetInlineEnd: Type.Optional(CssPixelOffsetSchema),
    bottom: Type.Optional(CssPixelOffsetSchema),
    flex: Type.Optional(Type.Union([Type.Literal(FLEX_MAIN_FIXED_VALUE), Type.Null()])),
    alignSelf: Type.Optional(Type.Null()),
    justifySelf: Type.Optional(Type.Null()),
  },
  { additionalProperties: false },
)
export type ResizeCommitPatch = Static<typeof ResizeCommitPatchSchema>

/**
 * `live-13` — a finished drag on the in-frame resize handles
 * (`resizeHandles.ts`) that changed the element's size. The frame previewed
 * the drag itself; the parent commits `patch` to the node's inline style
 * through the store, exactly the write `useElementResizeDrag` makes for a
 * portal frame. The offsets appear only for a `position: absolute | fixed`
 * element whose west/north edge (or centre, under ⌥) moved (IX-6d).
 */
export const ResizeCommitMessageSchema = Type.Object({
  type: Type.Literal('resize:commit'),
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  patch: ResizeCommitPatchSchema,
})

/** A guide coordinate in frame px — bounded so a forged guide cannot paint across the whole board. */
const GuideCoordinateSchema = Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })

/**
 * canvas-26 — the snap guides of the current resize step, in the frame
 * document's own px (the same space a portal drag's guides are computed in).
 * Posted only when they change, and once with `[]` when the drag ends; the
 * parent paints them in the frame's own drag layer (`elementResizeGuides.ts`),
 * never inside the frame. At most one per axis.
 */
export const ResizeGuidesMessageSchema = Type.Object({
  type: Type.Literal('resize:guides'),
  guides: Type.Array(
    Type.Object({
      axis: Type.Union([Type.Literal('x'), Type.Literal('y')]),
      position: GuideCoordinateSchema,
      start: GuideCoordinateSchema,
      end: GuideCoordinateSchema,
    }),
    { maxItems: 2 },
  ),
})
