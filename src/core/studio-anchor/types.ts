/**
 * studio-anchor — pointing at an element in a Studio page, durably.
 *
 * Studio node ids are `relFile:line:col` (`docs/features/studio-import.md` →
 * "Composite node ids"). They are derived from source POSITION, so they change
 * whenever anything above them in the file changes — which is most edits. The
 * editor store already treats that as routine: after a re-parse,
 * `lifecycleActions.ts` filters `selectedNodeIds` down to the survivors and
 * silently drops the rest.
 *
 * Selection can be dropped. A PERSISTED reference cannot. Penpot and Figma
 * never face this — their documents are shape databases with stable UUIDs, so
 * a stored `frame-id` is a fact forever. Ours is a text file, and the id is a
 * guess about a line number.
 *
 * So anything on disk that names an element stores a `NodeHint` rather than a
 * bare id, and re-resolves it against the live tree on every load. This module
 * is that primitive, and nothing more: it knows how to point and how to
 * re-point. What a caller is ALLOWED to do at each confidence is the caller's
 * policy, and lives with the caller (see `@core/studio-comments`'s `agentGate`).
 *
 * Two features depend on it, which is why it is a leaf module rather than part
 * of either: review comments (`.studio/comments.json`) and prototype links
 * (`.studio/prototype.json`).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * How much a stored hint can still be trusted, recomputed on every load and
 * every re-parse by `resolveNodeAnchor`. NEVER persisted — a stored confidence
 * would be a claim about a tree that has since changed.
 *
 *   - `exact`      — the stored `nodeId` still resolves. Nothing moved.
 *   - `moved`      — the file shifted but the structure and text still match at
 *                    the same index path. The hint is rewritten.
 *   - `drifted`    — same place, same module, DIFFERENT text. Someone edited
 *                    the very thing being pointed at.
 *   - `detached`   — the hint named an element, and it is gone.
 *   - `unanchored` — there was never a hint. Legitimate and permanent for a
 *                    comment pin dropped on empty canvas; impossible for a
 *                    prototype link, which is authored BY clicking an element.
 */
export const AnchorConfidenceSchema = Type.Union([
  Type.Literal('exact'),
  Type.Literal('moved'),
  Type.Literal('drifted'),
  Type.Literal('detached'),
  Type.Literal('unanchored'),
])
export type AnchorConfidence = Static<typeof AnchorConfidenceSchema>

/**
 * The node something was attached to, as it looked at authoring time.
 *
 * Every field here is a HINT, not a fact. `nodeId` stops resolving as soon as
 * anything above it in the file changes; the other three exist to re-find the
 * node when that happens:
 *
 *   - `indexPath` survives edits ABOVE the node (adding a line, renaming an
 *     import) because it is structural, not positional.
 *   - `moduleId` rejects a match that landed on a different KIND of node.
 *   - `textSnippet` is the tiebreaker that separates "this moved" from "this
 *     was replaced by something else at the same address".
 */
export const NodeHintSchema = Type.Object({
  /** `relFile:line:col` as of authoring. Expect it to be stale. */
  nodeId: Type.String(),
  /** Child-index path from the page root, e.g. `[0, 2, 1]`. */
  indexPath: Type.Array(Type.Number()),
  /** The node's module at authoring time — `base.text`, `studio.instance`, … */
  moduleId: Type.String(),
  /** First `TEXT_SNIPPET_MAX` chars of its text, or `''` for a non-text node. */
  textSnippet: Type.String(),
})
export type NodeHint = Static<typeof NodeHintSchema>

/** How much of a node's text is kept as the re-anchoring tiebreaker. */
export const TEXT_SNIPPET_MAX = 80
