/**
 * frameGeometryTypes — the wire-independent shapes of one frame's geometry
 * read. A dependency-free leaf: `FrameDocumentAdapter` (which returns them from
 * `measureAll`) and `FrameGeometryIndex` (which is built from them) both import
 * it, and neither needs the other.
 */

/**
 * SB-3 — one node's box and the few hit-test facts the rect index needs, as
 * returned by {@link FrameDocumentAdapter.measureAll}. `rect` is BODY-RELATIVE
 * (the same coordinate space `measure` speaks) and is `nodeVisualRect`: a
 * `display: contents` host carries the union of its boxed children. Only nodes
 * that have a box are listed; a boxless node's descendants attach to the
 * nearest listed ancestor.
 */
export interface NodeGeometry {
  /** Canonical tree node id (a bridge frame's stamp ids are already translated; stamps the tree does not know are folded into their nearest known ancestor). */
  nodeId: string
  rect: { x: number; y: number; width: number; height: number }
  /** Position in the same `nodes` array of the nearest listed ancestor, or -1 for a root. Always earlier than this node. */
  parent: number
  /** `overflow` other than `visible`: descendants are clipped to this node's box. */
  clips: boolean
  /** `pointer-events: none` or `visibility: hidden`: a native hit test passes through it. */
  inert: boolean
  /** A non-identity `transform`: `rect` is the bounds of a quad, so a point inside it may still miss the node. */
  transformed: boolean
  /** Paint rank among siblings (`paintRankOf` in `@core/studio-runtime`): higher paints on top. */
  paint: number
}

/** SB-3 — the reply to {@link FrameDocumentAdapter.measureAll}: every boxed node in document order. */
export interface FrameGeometrySnapshot {
  /** Where the body's border box sits in the frame's own viewport (0,0 for an ordinary frame). Node rects + `origin` are viewport points. */
  origin: { x: number; y: number }
  nodes: NodeGeometry[]
  /** The frame has more stamped nodes than one read carries; `nodes` is the document-order prefix, so a hit test over it may miss a late node. */
  truncated: boolean
}
