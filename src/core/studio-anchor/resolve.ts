/**
 * resolve — deciding what a stored hint still points at.
 *
 * The problem this exists for is stated in `types.ts`: a Studio node id encodes
 * a source position, so it rots. Everything here is pure and safe to call on
 * every render pass and on both sides of the wire.
 *
 * Known limitation, accepted for v1: `indexPath` is structural, so WRAPPING a
 * section in a new element shifts every descendant's path by one level and
 * reads as `detached` even though nothing was really removed. That fails toward
 * "I don't know", which is the safe direction — a false `detached` costs a
 * re-anchor, a false `exact` costs a wrong edit to the user's real source.
 */
import { getChildren } from '@core/page-tree'
import type { BaseNode, NodeTree } from '@core/page-tree'
import { TEXT_SNIPPET_MAX, type AnchorConfidence, type NodeHint } from './types'

export interface ResolvedAnchor {
  confidence: AnchorConfidence
  /**
   * The node id the caller should track NOW — refreshed for `moved`, unchanged
   * for `exact`/`drifted`, `null` for `detached`/`unanchored`.
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
 * Re-resolve a stored hint against the live tree.
 *
 * A `null` hint is NOT a failure — it is `unanchored`, which for a comment pin
 * dropped on empty canvas is a legitimate permanent state. A `null` tree IS a
 * failure, reported as `detached`: that is a deliberate UNDER-claim, because a
 * caller must refuse what it cannot verify, and a false refusal costs a round
 * trip where a false pass costs a wrong edit.
 */
export function resolveNodeAnchor(
  hint: NodeHint | null,
  tree: NodeTree | null | undefined,
): ResolvedAnchor {
  if (!hint) return UNANCHORED
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
  // its place would silently inherit whatever pointed at the heading.
  if (candidate.moduleId !== hint.moduleId) return DETACHED

  return nodeTextSnippet(candidate) === hint.textSnippet
    ? { confidence: 'moved', nodeId: candidate.id }
    : { confidence: 'drifted', nodeId: candidate.id }
}

/**
 * Build the hint to STORE when something is attached to `nodeId`. Returns
 * `null` for a node that is not in the tree — which a comment pin treats as
 * "dropped on empty canvas", and a prototype link treats as "no link".
 */
export function captureNodeHint(tree: NodeTree, nodeId: string): NodeHint | null {
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
