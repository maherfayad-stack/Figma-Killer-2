/**
 * geometryMessages — the SB-3 wire pair behind `adapter.measureAll()`: one
 * batched read of every stamped node's box, plus the dirty ping that tells the
 * parent its copy went stale. Split from `messages.ts` for the module-size
 * budget (same reason as `dropCandidateMessages.ts`); `messages.ts` re-exports
 * the public names.
 *
 * The parent-side consumer is `FrameGeometryIndex` (admin canvas
 * `frameGeometry/`), a packed R-tree built from the reply.
 */
import { Type, type Static } from '@sinclair/typebox'
import { NodeRectSchema } from './messageShapes'

/**
 * A page with more stamped nodes than this gets a truncated reply
 * (`truncated: true`); the sender stops reading at the cap, so the cost is
 * bounded too, not just the payload. Bounded at BOTH ends per `sec-06`'s
 * "same-realm spoofing" posture: a script co-resident with the runtime could
 * otherwise forge an arbitrarily large reply the parent would index.
 */
export const GEOMETRY_NODES_MAX = 4000

/** Asks for every stamped node's box in one reply. Answered by {@link MeasureAllResultMessageSchema}. */
export const MeasureAllMessageSchema = Type.Object({
  type: Type.Literal('measureAll'),
  requestId: Type.String({ minLength: 1 }),
})

const GeometryNodeWireSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  /** Which same-stamp DOM occurrence this is, in document order (see "occurrenceIndex" in `messages.ts`). */
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  /** Body-relative visual box (`nodeVisualRect`), the convention `measure` already speaks. */
  rect: NodeRectSchema,
  /** Position in this same array of the nearest ancestor that is also listed, or -1 for a root. Always earlier in the array. */
  parent: Type.Integer({ minimum: -1, maximum: GEOMETRY_NODES_MAX }),
  /** An `overflow` other than `visible`: the node's box clips what its descendants paint outside it. */
  clips: Type.Boolean(),
  /** `pointer-events: none` or `visibility: hidden`: a native hit test would pass through this node. */
  inert: Type.Boolean(),
  /** A non-identity `transform`: `rect` is the axis-aligned bounds of a quad, so a point inside it may still miss the node. */
  transformed: Type.Boolean(),
  /** Paint rank among siblings, see `paintRankOf` in `nodeGeometry.ts`. */
  paint: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
})
export type GeometryNodeWire = Static<typeof GeometryNodeWireSchema>

export const MeasureAllResultMessageSchema = Type.Object({
  type: Type.Literal('measureAll:result'),
  requestId: Type.String({ minLength: 1 }),
  /** The body's top-left in the frame's own viewport, so `rect` + `origin` is a viewport point. */
  origin: Type.Object({ x: Type.Number(), y: Type.Number() }),
  nodes: Type.Array(GeometryNodeWireSchema, { maxItems: GEOMETRY_NODES_MAX }),
  /** The frame had more than {@link GEOMETRY_NODES_MAX} stamped nodes; the reply covers the first ones in document order. */
  truncated: Type.Boolean(),
})

/**
 * The frame's layout may have changed since the last `measureAll` reply.
 * Posted at most ONCE per reply (a latch, re-armed by the next `measureAll`),
 * and only after the parent has asked for geometry at all, so a frame nobody
 * indexes sends nothing no matter how busy its DOM is.
 */
export const GeometryDirtyMessageSchema = Type.Object({
  type: Type.Literal('geometry:dirty'),
})
