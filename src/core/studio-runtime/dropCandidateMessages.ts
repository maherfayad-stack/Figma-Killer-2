/**
 * dropCandidateMessages — the `speed-06` request/reply pair a parent uses to
 * learn, once per drag, where a drop could land inside a frame. Split from
 * `messages.ts` for the module-size budget; `messages.ts` re-exports the
 * public names so `@core/studio-runtime` consumers see one surface.
 */
import { Type, type Static } from '@sinclair/typebox'
import { NodeRectSchema } from './messageShapes'

/**
 * `speed-06` — the frame's answer to "where could a drop land": every stamped
 * node's rect + insertion axis, requested once per drag (not per pointer
 * move) and refreshed only on the drag's own explicit triggers (`hmr:after`,
 * `frame:resize`, a portal frame's own scroll). Bounded like every other
 * request/reply pair here — `sec-06`'s posture.
 */
export const DropCandidatesMessageSchema = Type.Object({
  type: Type.Literal('dropCandidates'),
  requestId: Type.String({ minLength: 1 }),
})

/**
 * `speed-06` — the reply to {@link DropCandidatesMessageSchema}, correlated by
 * `requestId`. Bounded at BOTH levels per `sec-06`'s "same-realm spoofing"
 * posture (a script co-resident with `runtime.ts` could otherwise forge an
 * arbitrarily large reply the parent would then hold onto for the length of
 * a drag): at most {@link DROP_CANDIDATES_MAX} candidates, each with at most
 * {@link DROP_CANDIDATE_CHILD_RECTS_MAX} `childRects` — matching
 * `dropCandidates.ts`'s own `MAX_DROP_CANDIDATES`/
 * `MAX_DROP_CANDIDATE_CHILD_RECTS`, the honest sender's caps, so the schema
 * never rejects a real reply.
 *
 * `childRects` is carried but not yet consumed by the resolver — see
 * `dropCandidates.ts`'s own doc for why it travels anyway (a future
 * sibling-geometry axis heuristic, G9's own noted follow-up).
 */
export const DROP_CANDIDATES_MAX = 2000
export const DROP_CANDIDATE_CHILD_RECTS_MAX = 200

const DropCandidateAxisSchema = Type.Union([Type.Literal('vertical'), Type.Literal('horizontal')])

const DropCandidateSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  occurrenceIndex: Type.Integer({ minimum: 0, default: 0 }),
  rect: NodeRectSchema,
  axis: DropCandidateAxisSchema,
  reversed: Type.Boolean(),
  childRects: Type.Array(NodeRectSchema, { maxItems: DROP_CANDIDATE_CHILD_RECTS_MAX }),
})

export const DropCandidatesResultMessageSchema = Type.Object({
  type: Type.Literal('dropCandidates:result'),
  requestId: Type.String({ minLength: 1 }),
  candidates: Type.Array(DropCandidateSchema, { maxItems: DROP_CANDIDATES_MAX }),
})
export type DropCandidateWire = Static<typeof DropCandidateSchema>

