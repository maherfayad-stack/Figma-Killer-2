/**
 * anchorResolve — deciding what a comment still points at.
 *
 * THIS MODULE IS THE FEATURE. Everything else is storage and chrome.
 *
 * The problem, stated once
 * ────────────────────────
 * Studio node ids are `relFile:line:col` (`docs/features/studio-import.md` →
 * "Composite node ids"). They are derived from source POSITION, so they change
 * whenever anything above them in the file changes — which is most edits. The
 * editor store already treats this as routine: after a re-parse,
 * `lifecycleActions.ts` filters `selectedNodeIds` down to the ids that
 * survived and silently drops the rest.
 *
 * Selection can be dropped. A comment cannot. Penpot and Figma never face this
 * — their documents are shape databases with stable UUIDs, so a thread's
 * `frame-id` is a fact forever. Ours is a text file, and the id is a guess
 * about a line number.
 *
 * So a stored hint (`CommentNodeHint`) is re-resolved against the live tree on
 * every load, and the answer is one of four confidences rather than a boolean:
 *
 *   exact    — `nodeId` still resolves. Nothing moved.
 *   moved    — `indexPath` resolves to the same module with the same text.
 *              The file shifted; rewrite the hint to the fresh id.
 *   drifted  — same place, same module, DIFFERENT text. Someone edited the
 *              exact thing being discussed. Still show the pin — that edit is
 *              very often the RESPONSE to the comment — but stop claiming the
 *              comment describes what is there now.
 *   detached — the comment named an element, and it is gone.
 *   unanchored — the comment never named one. A pin on empty canvas is a
 *              legitimate permanent state, NOT a failure, and conflating the
 *              two made every free-floating comment un-resolvable by the
 *              agent (the gate below refuses `detached`).
 *
 * Why the agent gate lives here
 * ─────────────────────────────
 * `isAgentActionable` is the load-bearing export. An agent that acts on a
 * `drifted` or `detached` anchor edits the WRONG ELEMENT in the user's real
 * source — the single worst thing this feature can do, and it would do it
 * silently, in a file the user did not open. So the agent's write tools refuse
 * on `drifted`/`detached` and reply in the thread saying why. That is
 * the same posture `refuseStructuralEdit` takes for structural writes: when
 * there is not exactly one honest target, say so instead of guessing.
 *
 * Known limitation, accepted for v1: `indexPath` is structural, so WRAPPING a
 * section in a new element shifts every descendant's path by one level and
 * reads as `detached` even though nothing was really removed. That fails
 * toward "I don't know", which is the safe direction — a false `detached`
 * costs a re-pin, a false `exact` costs a wrong edit.
 */
import { getChildren } from '@core/page-tree'
import type { BaseNode, NodeTree } from '@core/page-tree'
import { TEXT_SNIPPET_MAX, type AnchorConfidence, type CommentNodeHint } from './types'

export interface ResolvedAnchor {
  confidence: AnchorConfidence
  /**
   * The node id the pin should track NOW — refreshed for `moved`, unchanged
   * for `exact`/`drifted`, `null` for `detached`/`unanchored` (the pin falls
   * back to the anchor's frame-local `dx`/`dy`).
   */
  nodeId: string | null
}

const DETACHED: ResolvedAnchor = { confidence: 'detached', nodeId: null }
const UNANCHORED: ResolvedAnchor = { confidence: 'unanchored', nodeId: null }

/**
 * The node's own text, normalized and truncated, for use as the re-anchoring
 * tiebreaker.
 *
 * Reads `props.text` then `props.children`, which between them cover every
 * text-bearing module in the codebase (`base.text` and the design-system
 * components that mirror its prop name). A node with neither yields `''` —
 * and that is correct rather than a gap: for a non-text node, matching
 * `indexPath` + `moduleId` is already the whole available signal, and two
 * empty snippets compare equal, so such a node resolves `moved` instead of
 * being wrongly downgraded to `drifted`.
 *
 * Whitespace is collapsed before comparison so a reformat (prettier moving a
 * string onto its own line) does not read as an edit to the content.
 */
export function nodeTextSnippet(node: BaseNode | undefined): string {
  if (!node) return ''
  const raw = node.props?.text ?? node.props?.children
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, TEXT_SNIPPET_MAX)
}

/**
 * The child-index path from the tree root down to `nodeId`, or `null` when the
 * node is not in this tree. The inverse of `nodeAtIndexPath`.
 *
 * Walks down from the root rather than up via `parentId` so it depends only on
 * `children` — the structural source of truth — and never on the denormalized
 * parent cache, which a freshly-parsed tree populates separately.
 */
export function indexPathForNode(tree: NodeTree, nodeId: string): number[] | null {
  if (!tree.nodes[nodeId]) return null
  if (nodeId === tree.rootNodeId) return []

  const path: number[] = []
  let found = false

  const walk = (currentId: string): boolean => {
    const children = getChildren(tree, currentId)
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i]
      if (!child) continue
      path.push(i)
      if (child.id === nodeId) {
        found = true
        return true
      }
      if (walk(child.id)) return true
      path.pop()
    }
    return false
  }

  walk(tree.rootNodeId)
  return found ? path : null
}

/** The node at `indexPath`, or `undefined` when the path runs off the tree. */
export function nodeAtIndexPath(tree: NodeTree, indexPath: readonly number[]): BaseNode | undefined {
  let current: BaseNode | undefined = tree.nodes[tree.rootNodeId]
  for (const index of indexPath) {
    if (!current) return undefined
    const children: BaseNode[] = getChildren(tree, current.id)
    current = children[index]
  }
  return current
}

/**
 * Re-resolve a stored hint against the live tree. Pure; safe to call on every
 * render pass and on both sides of the wire.
 */
export function resolveCommentAnchor(
  hint: CommentNodeHint | null,
  tree: NodeTree | null | undefined,
): ResolvedAnchor {
  // No hint at all is NOT a failure — a pin dropped on empty canvas never had
  // a node to point at, and is permanently, legitimately coordinate-only.
  if (!hint) return UNANCHORED
  // A hint we cannot check because the page is not loaded. `detached` is a
  // deliberate UNDER-claim: the gate must refuse what it cannot verify, and a
  // false refusal costs a round trip where a false pass costs a wrong edit.
  if (!tree) return DETACHED

  // 1. The id still resolves. Overwhelmingly the common case within a session.
  if (tree.nodes[hint.nodeId]) {
    return { confidence: 'exact', nodeId: hint.nodeId }
  }

  // 2. The id is stale, so fall back to structure.
  const candidate = nodeAtIndexPath(tree, hint.indexPath)
  if (!candidate) return DETACHED

  // A different KIND of node at the same address is a different node, not a
  // moved one. Without this check, deleting a heading and adding a button in
  // its place would silently inherit the heading's comment thread.
  if (candidate.moduleId !== hint.moduleId) return DETACHED

  return nodeTextSnippet(candidate) === hint.textSnippet
    ? { confidence: 'moved', nodeId: candidate.id }
    : { confidence: 'drifted', nodeId: candidate.id }
}

/**
 * May the agent act on a thread anchored here — edit the source it points at,
 * then reply and resolve?
 *
 * Only when the anchor still names exactly one element we are sure about. See
 * this module's doc for why the false-negative direction is the safe one.
 */
export function isAgentActionable(confidence: AnchorConfidence): boolean {
  // `unanchored` passes: there is no element that could have gone stale, so
  // the comment is exactly as actionable as it was the day it was written.
  return confidence === 'exact' || confidence === 'moved' || confidence === 'unanchored'
}

/** Why the agent refused — phrased for the reply it posts into the thread. */
export function explainAnchorRefusal(confidence: AnchorConfidence): string | null {
  switch (confidence) {
    case 'exact':
    case 'moved':
    case 'unanchored':
      return null
    case 'drifted':
      return 'The element this comment points at has been edited since the comment was written, so it may no longer describe what is there. Re-check it and comment again if it still applies.'
    case 'detached':
      return 'The element this comment pointed at no longer exists, so there is no single place to apply this change. The comment has been left open.'
  }
}

/**
 * Build the hint to STORE when a pin is dropped on `nodeId`. Returns `null`
 * for a node that is not in the tree, which callers treat as "dropped on empty
 * canvas" — a coordinate-only pin.
 */
export function captureNodeHint(tree: NodeTree, nodeId: string): CommentNodeHint | null {
  const node = tree.nodes[nodeId]
  if (!node) return null
  const indexPath = indexPathForNode(tree, nodeId)
  if (!indexPath) return null
  return {
    nodeId,
    indexPath,
    moduleId: node.moduleId,
    textSnippet: nodeTextSnippet(node),
  }
}
