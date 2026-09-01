/**
 * commentLocation — "where is this comment, exactly?", answered in one place.
 *
 * A thread stores five coordinates of meaning (`boardId`, `anchor.frameId`,
 * `anchor.pageId`, `anchor.dx/dy`, `anchor.node`) and every one of them is an
 * ID. Handed to an agent raw, they say almost nothing: `26cc49cd…` is not a
 * board, `pages/Home.tsx:5:6` is not an element, and `dx: 86` is not a place.
 * The agent then does what anyone would do with an under-specified brief —
 * guesses which element was meant, and edits the wrong one.
 *
 * So this module resolves those ids against the live project ONCE and hands
 * back a `CommentLocation`: named board, named page, its source file, the
 * position within the frame in both pixels and percent, and the element's
 * ancestor trail down from the page root. `describeCommentLocation` renders the
 * same record as prose.
 *
 * BOTH SIDES USE IT
 * ─────────────────
 * The in-editor "Send to AI" button (`commentBulkActions.ts`) and the MCP tool
 * `studio_list_comments` (`commentTools.ts`) are two doors into the same
 * question, reached by two different agents. They were describing a thread's
 * location differently and incompletely — the button named the page and module
 * id, the tool named the page and node id, neither named the board, the frame,
 * the coordinates or the surrounding structure. One builder means a thread
 * cannot be well-described through one door and badly through the other.
 *
 * The anchor confidence is computed HERE, from the tree the caller passes, for
 * the reason `anchorResolve.ts` gives at length: a stored confidence is a claim
 * about a tree that has since changed. `checkAnchor: false` is the honest way
 * to say "I did not parse the project on this call" — it yields
 * `confidence: null` (unknown) rather than the `detached` a missing tree would
 * otherwise produce, because "I did not look" and "it is gone" must never
 * render as the same sentence in a briefing an agent acts on.
 */
import { getChildren, type BaseNode, type NodeTree } from '@core/page-tree'
import { indexPathForNode, nodeTextSnippet, resolveCommentAnchor } from './anchorResolve'
import type { AnchorConfidence, CommentThread } from './types'

/** The element a thread points at, described rather than merely identified. */
export interface CommentElementContext {
  /** `relFile:line:col` — the id the agent should edit at, when trustworthy. */
  nodeId: string
  moduleId: string
  /** The element's own text, when it has any. */
  text: string
  /**
   * Labels from the page root down to the element — `['Screen', 'Sheet',
   * 'Skip']`. Empty when the anchor no longer resolves, in which case the
   * fields above are the STORED hint and describe what the comment was about,
   * not what is there now.
   */
  trail: readonly string[]
}

/** Everything needed to find a comment, with nothing left as a bare id. */
export interface CommentLocation {
  seq: number
  resolved: boolean
  boardId: string
  boardName: string | null
  frameId: string | null
  pageId: string | null
  pageTitle: string | null
  /** The page's source file, e.g. `pages/Home.tsx`. */
  pageFile: string | null
  /** Frame-local pixels, frame top-left at (0, 0). */
  dx: number
  dy: number
  /** The same point as whole percentages of the frame, when its size is known. */
  xPercent: number | null
  yPercent: number | null
  element: CommentElementContext | null
  /** `null` when the caller did not resolve anchors on this pass. */
  confidence: AnchorConfidence | null
}

export interface CommentLocationSources {
  boardName: string | null
  pageTitle: string | null
  /** The page's live tree — `null` when this page is not loaded. */
  tree: NodeTree | null
  frameWidth: number | null
  frameHeight: number | null
  /**
   * Whether a `null` tree means "gone" (default: check the anchor, and report
   * `detached`) or "not parsed on this call" (`false`: report `null`).
   */
  checkAnchor?: boolean
}

/**
 * The file part of a Studio node id (`relFile:line:col`).
 *
 * Anchored to the END of the string rather than split on the first colon: a
 * relative path may legitimately contain one, and only the trailing
 * `:line:col` pair is structural.
 */
export function sourceFileOfNodeId(nodeId: string): string | null {
  const match = /^(.+):\d+:\d+$/.exec(nodeId)
  return match?.[1] ?? null
}

/** What to call a node in a trail — the author's own label, else its module. */
function nodeLabel(node: BaseNode): string {
  const label = node.label?.trim()
  if (label) return label
  const text = nodeTextSnippet(node)
  return text ? `${node.moduleId} “${text}”` : node.moduleId
}

/**
 * Labels from the page root down to `nodeId`, root excluded (the page names
 * it). Walks down the index path rather than up `parentId` for the reason
 * `indexPathForNode` gives: `children` is the structural source of truth, and
 * the parent cache is populated separately on a freshly-parsed tree.
 */
export function nodeTrail(tree: NodeTree, nodeId: string): string[] {
  const path = indexPathForNode(tree, nodeId)
  if (!path) return []
  const trail: string[] = []
  let current: BaseNode | undefined = tree.nodes[tree.rootNodeId]
  for (const index of path) {
    if (!current) break
    current = getChildren(tree, current.id)[index]
    if (current) trail.push(nodeLabel(current))
  }
  return trail
}

function percentOf(value: number, extent: number | null): number | null {
  if (extent === null || extent <= 0) return null
  return Math.round((value / extent) * 100)
}

/** Resolve one thread's stored ids into a described location. */
export function buildCommentLocation(
  thread: CommentThread,
  sources: CommentLocationSources,
): CommentLocation {
  const { tree, checkAnchor = true } = sources
  const hint = thread.anchor.node
  const resolved = checkAnchor ? resolveCommentAnchor(hint, tree) : null

  // Prefer the node the anchor resolves to NOW; fall back to the stored hint,
  // which still tells the agent what the comment was written about.
  let element: CommentElementContext | null = null
  if (tree && resolved?.nodeId) {
    const liveNode = tree.nodes[resolved.nodeId]
    if (liveNode) {
      element = {
        nodeId: liveNode.id,
        moduleId: liveNode.moduleId,
        text: nodeTextSnippet(liveNode),
        trail: nodeTrail(tree, liveNode.id),
      }
    }
  }
  if (!element && hint) {
    element = { nodeId: hint.nodeId, moduleId: hint.moduleId, text: hint.textSnippet, trail: [] }
  }

  return {
    seq: thread.seq,
    resolved: thread.resolved,
    boardId: thread.boardId,
    boardName: sources.boardName,
    frameId: thread.anchor.frameId,
    pageId: thread.anchor.pageId,
    pageTitle: sources.pageTitle,
    pageFile:
      (element ? sourceFileOfNodeId(element.nodeId) : null) ??
      (tree ? sourceFileOfNodeId(tree.rootNodeId) : null),
    dx: Math.round(thread.anchor.dx),
    dy: Math.round(thread.anchor.dy),
    xPercent: percentOf(thread.anchor.dx, sources.frameWidth),
    yPercent: percentOf(thread.anchor.dy, sources.frameHeight),
    element,
    confidence: resolved?.confidence ?? null,
  }
}

/** One line telling the agent whether it may act on this thread's element. */
function anchorLine(confidence: AnchorConfidence): string {
  switch (confidence) {
    case 'exact':
      return 'anchor exact — the element still resolves at this id.'
    case 'moved':
      return 'anchor moved — the file shifted, and the id above is the refreshed one.'
    case 'drifted':
      return 'anchor DRIFTED — this element was edited after the comment was written, so the comment may no longer describe it. Re-read it before acting; do not resolve the thread.'
    case 'detached':
      return 'anchor DETACHED — the element is gone. The id and text above are the stale stored hint. Do not edit at that id; say so in a reply and leave the thread open.'
    case 'unanchored':
      return 'unanchored — the pin was dropped on empty canvas, so the coordinates are the whole location.'
  }
}

/**
 * The same record as prose, for a message rather than a tool result.
 *
 * Every line is a fact the agent would otherwise have to guess at, in the
 * order it needs them: which surface, where on it, what element, and how far
 * that last answer can be trusted.
 */
export function describeCommentLocation(loc: CommentLocation): string {
  const board = loc.boardName ? `“${loc.boardName}”` : loc.boardId
  const page = loc.pageTitle ? `“${loc.pageTitle}”` : (loc.pageId ?? 'no page')
  const percent =
    loc.xPercent !== null && loc.yPercent !== null
      ? ` (${loc.xPercent}% across, ${loc.yPercent}% down)`
      : ''

  const lines = [
    `### Comment #${loc.seq}${loc.resolved ? ' (resolved)' : ''}`,
    `- Board: ${board}${loc.frameId ? `, frame ${loc.frameId}` : ', not on a frame'}`,
    `- Page: ${page}${loc.pageFile ? ` — \`${loc.pageFile}\`` : ''}`,
    `- Pin position in the frame: ${loc.dx}px across, ${loc.dy}px down${percent}`,
    loc.element
      ? `- Element: \`${loc.element.moduleId}\`${loc.element.text ? ` — “${loc.element.text}”` : ''}`
      : '- Element: none — the pin is not attached to an element.',
    loc.element && loc.element.trail.length > 0
      ? `- Path from the page root: ${loc.element.trail.join(' › ')}`
      : null,
    loc.element ? `- Node id: \`${loc.element.nodeId}\`` : null,
    loc.confidence ? `- Anchor: ${anchorLine(loc.confidence)}` : null,
  ]
  return lines.filter((line) => line !== null).join('\n')
}
