/**
 * Studio comments — the persisted shape of `<workspace>/.studio/comments.json`.
 *
 * Schema-first (TypeBox, `Static<>`-derived types), unlike `@core/studio-board`'s
 * `BoardFrame`/`StickyNote`/`DocBlock` siblings, which are plain interfaces
 * predating that convention. This file crosses an HTTP boundary in BOTH
 * directions and is read by MCP tools running for an agent, so a schema is not
 * ceremony here — it is the validator three separate callers share.
 * (`BoardGuideSchema` already set this precedent inside `studio-board` itself.)
 *
 * WHY A SEPARATE FILE FROM `boards.json`
 * ──────────────────────────────────────
 * A comment is not board furniture. `board.notes` / `board.docs` are the
 * designer's own scratch space — authoring furniture, positioned in board
 * coordinates, owned by a board. A comment is about a specific ELEMENT on a
 * specific PAGE, has an author who is not necessarily the reader, and ends in
 * `resolved` rather than deletion. Three concrete consequences:
 *
 *   - `boards.json` rides an 800 ms dirty-flag autosave (`AdminCanvasLayout`'s
 *     `useStudioBoardsPersistence`). Comment bodies have no business on that
 *     path.
 *   - A review is worth reading as a git diff on its own.
 *   - Threads outlive the board they were dropped on: `anchor.pageId` is
 *     denormalized precisely so removing a frame from a board does not orphan
 *     the conversation about it.
 *
 * See `anchorResolve.ts` for the part that actually matters — what a comment
 * points AT, given that Studio node ids are source positions and therefore rot.
 */
import { Type, type Static, withFallback } from '@core/utils/typeboxHelpers'

/**
 * How much the stored node hint can still be trusted, recomputed on every load
 * and every re-parse by `resolveCommentAnchor`. Never persisted — a stored
 * confidence would be a claim about a tree that has since changed.
 *
 *   - `exact`      — the stored `nodeId` still resolves. Nothing moved.
 *   - `moved`      — the file shifted but the structure and text still match
 *                    at the same index path. The hint is rewritten.
 *   - `drifted`    — same place, same module, DIFFERENT text. Someone edited
 *                    the very thing under discussion.
 *   - `detached`   — the comment named an element, and it is gone.
 *   - `unanchored` — the comment never named an element: a pin dropped on
 *                    empty canvas, which is a legitimate permanent state.
 *
 * `unanchored` exists because `detached` was doing two jobs and getting both
 * wrong. Folding "never had a target" into "lost its target" made every
 * free-floating pin wear a stale badge it had not earned, and — far worse —
 * made every one of them permanently un-resolvable by the agent, since the
 * gate below refuses `detached`. A caught regression, not a hypothetical:
 * `commentTools.test.ts` asserts the distinction directly.
 *
 * `drifted` and `detached` are the two the agent must refuse to act on — see
 * `anchorResolve.ts`'s `isAgentActionable`.
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
 * The node a pin was dropped on, as it looked at authoring time.
 *
 * Every field here is a HINT, not a fact. Studio node ids are
 * `relFile:line:col` (`docs/features/studio-import.md` → "Composite node ids"),
 * so `nodeId` stops resolving as soon as anything above it in the file changes
 * — which is most edits. The other three fields exist to re-find the node when
 * that happens:
 *
 *   - `indexPath` survives edits ABOVE the node (adding a line, renaming an
 *     import) because it is structural, not positional.
 *   - `moduleId` rejects a match that landed on a different KIND of node.
 *   - `textSnippet` is the tiebreaker that separates "this moved" from "this
 *     was replaced by something else at the same address".
 */
export const CommentNodeHintSchema = Type.Object({
  /** `relFile:line:col` as of authoring. Expect it to be stale. */
  nodeId: Type.String(),
  /** Child-index path from the page root, e.g. `[0, 2, 1]`. */
  indexPath: Type.Array(Type.Number()),
  /** The node's module at authoring time — `base.text`, `studio.instance`, … */
  moduleId: Type.String(),
  /** First `TEXT_SNIPPET_MAX` chars of its text, or `''` for a non-text node. */
  textSnippet: Type.String(),
})
export type CommentNodeHint = Static<typeof CommentNodeHintSchema>

/**
 * Where a thread lives.
 *
 * `dx`/`dy` are the COORDINATE OF RECORD — frame-local pixels, frame top-left
 * at (0, 0). Frame-local rather than board-absolute so a pin follows its frame
 * when the frame is dragged, which is the behaviour Penpot gets from pairing
 * `position` with `frame-id`.
 *
 * `node` is the meaning, and it is allowed to go stale. When it does, the pin
 * falls back to `(dx, dy)` and says so rather than silently claiming to point
 * at whatever now occupies that spot.
 */
export const CommentAnchorSchema = Type.Object({
  /** Board frame the pin was dropped on. `null` = free-floating on the board. */
  frameId: Type.Union([Type.String(), Type.Null()]),
  /** Page that frame renders. Denormalized so the anchor outlives the frame. */
  pageId: Type.Union([Type.String(), Type.Null()]),
  /** Frame-local x, in px. */
  dx: Type.Number(),
  /** Frame-local y, in px. */
  dy: Type.Number(),
  /** The element under the cursor at drop time, or `null` for an empty spot. */
  node: Type.Union([CommentNodeHintSchema, Type.Null()]),
})
export type CommentAnchor = Static<typeof CommentAnchorSchema>

/**
 * Who wrote a comment — a DENORMALIZED SNAPSHOT, not a foreign key.
 *
 * `userId` identifies the account within one installation. `displayName` is
 * copied in at write time so the file is still readable after a clone, on a
 * machine whose `users` table has never heard of that id. That readability is
 * the entire reason this feature stores threads on disk instead of in the
 * database, so the redundancy is the point, not an oversight.
 *
 * `kind: 'agent'` marks a comment the AI wrote. It is set SERVER-SIDE by the
 * MCP tool path and can never be claimed by a browser request — see
 * `commentsStore.ts`'s `authorFromSession`.
 */
export const CommentAuthorSchema = Type.Object({
  userId: Type.String(),
  displayName: Type.String(),
  kind: Type.Union([Type.Literal('user'), Type.Literal('agent')]),
})
export type CommentAuthor = Static<typeof CommentAuthorSchema>

export const CommentSchema = Type.Object({
  id: Type.String(),
  author: CommentAuthorSchema,
  body: Type.String(),
  /** ISO-8601. */
  createdAt: Type.String(),
  /** ISO-8601, or `null` when never edited. */
  editedAt: Type.Union([Type.String(), Type.Null()]),
})
export type Comment = Static<typeof CommentSchema>

export const CommentThreadSchema = Type.Object({
  id: Type.String(),
  /**
   * The number drawn in the pin — Penpot's `seqn`. Monotonic per project via
   * `CommentsFile.nextSeq` and NEVER reused, so "comment 3" stays a stable
   * name in conversation (and in an agent's tool call) even after threads 1
   * and 2 are deleted.
   */
  seq: Type.Number(),
  /** Board the pin was dropped on. */
  boardId: Type.String(),
  anchor: CommentAnchorSchema,
  resolved: Type.Boolean(),
  createdAt: Type.String(),
  /**
   * Never empty in practice — a thread is created by its first comment, and
   * deleting the last comment deletes the thread (`deleteComment`). The schema
   * does not encode that invariant because `serialize.ts` has to be able to
   * READ a hand-edited file that violates it; `parseCommentsFile` drops such a
   * thread instead of admitting it.
   */
  comments: Type.Array(CommentSchema),
})
export type CommentThread = Static<typeof CommentThreadSchema>

export const CommentsFileSchema = Type.Object({
  version: Type.Literal(1),
  /** Next `seq` to hand out. Only ever increases. */
  nextSeq: Type.Number(),
  threads: withFallback(Type.Array(CommentThreadSchema), []),
})
export type CommentsFile = Static<typeof CommentsFileSchema>

/** How much of a node's text is kept as the re-anchoring tiebreaker. */
export const TEXT_SNIPPET_MAX = 80

export function createCommentsFile(): CommentsFile {
  return { version: 1, nextSeq: 1, threads: [] }
}
