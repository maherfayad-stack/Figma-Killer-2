/**
 * canvasSelectionUtils — Phase 4 canvas selection helpers.
 *
 * Utilities for resolving which page-level base.visual-component-ref node
 * "owns" a clicked node, when that node lives inside an inlined VC tree.
 *
 * Architecture source: Phase 4 component system (F4).
 * Constraint #269 does NOT apply here (this is in editor/, not core/).
 */

import type { NodeTree, PageNode } from '@core/page-tree'
import { getParent } from '@core/page-tree'

// ---------------------------------------------------------------------------
// AnnotatedPageNode
// ---------------------------------------------------------------------------

/**
 * A page node that may carry in-memory Phase 4 canvas metadata.
 * These fields are set by `instantiateVCAtRef` and are NEVER persisted.
 * Standard page nodes (not inlined from a VC) have neither field set.
 *
 * The extended type is intentionally compatible with `PageNode` so callers
 * can safely cast or pass a merged node map that contains both plain page
 * nodes and annotated inlined nodes.
 */
export type AnnotatedPageNode = PageNode & {
  /** ID of the page-level base.visual-component-ref that owns this inlined node */
  _owningRefId?: string
  /**
   * True if this node came from a slot-instance's children (user-authored, editable
   * in page context). False if it came from the VC body (template-owned).
   */
  _fromSlotContent?: boolean
}

// ---------------------------------------------------------------------------
// findEnclosingComponentRef
// ---------------------------------------------------------------------------

/**
 * Walks the ancestor chain of `nodeId` to find the outermost on-page
 * `base.visual-component-ref` ancestor.
 *
 * Returns null when the node is not inside any inlined VC tree (i.e. it is
 * a plain page node without `_owningRefId`).
 *
 * **Combined node map:** Because inlined VC nodes live in a separate flat map
 * produced by `instantiateVCAtRef` (they are NOT merged into `page.nodes`),
 * callers must provide a combined map containing both `page.nodes` and any
 * inlined nodes they wish to inspect. Plain page nodes without `_owningRefId`
 * are treated correctly — they return null from this helper.
 *
 * **Nested VC resolution:** When VC1 places VC2 (VC2-ref is inside VC1's
 * body), clicking deep inside VC2 should resolve to the outermost page-level
 * ref (VC1-ref). The helper walks up via `_owningRefId` chains until it finds
 * a ref node with no `_owningRefId` of its own (a plain page node).
 *
 * @param nodes  Combined flat map of page nodes + inlined VC nodes.
 * @param nodeId The ID of the node to inspect.
 * @returns The outermost enclosing ref id and whether the clicked node lives
 *          in user-editable slot content, or null if not inside any VC.
 */
export function findEnclosingComponentRef(
  nodes: Record<string, AnnotatedPageNode>,
  nodeId: string,
): { refId: string; isInsideSlotContent: boolean } | null {
  const node = nodes[nodeId]

  // No node or no annotation → plain page node, not inside any inlined VC.
  if (!node || !node._owningRefId) return null

  // Slot content: user-authored nodes that are editable in page context.
  // The IMMEDIATE owning ref is the enclosing ref for slot content — no walk-up
  // needed because slot content is authored at that ref's level.
  if (node._fromSlotContent) {
    return { refId: node._owningRefId, isInsideSlotContent: true }
  }

  // VC body node: walk up the _owningRefId chain to find the outermost on-page ref.
  // The outermost ref is the one whose own node entry has no _owningRefId
  // (i.e. it is a plain page node, not itself inside another VC's inlined body).
  let refId = node._owningRefId
  for (;;) {
    const refNode = nodes[refId]
    if (refNode?._owningRefId) {
      refId = refNode._owningRefId
    } else {
      break
    }
  }

  return { refId, isInsideSlotContent: false }
}

// ---------------------------------------------------------------------------
// findEnclosingInstance
// ---------------------------------------------------------------------------

/**
 * instance-ui-01 — the `studio.instance` (WS-4.2) counterpart to
 * `findEnclosingComponentRef` above. A `studio.instance` renders NO DOM
 * element (a bare React Fragment — see `src/modules/base/instance/
 * InstanceEditor.tsx`), and its children are ORDINARY nodes in the real page
 * tree (not a separate annotated map produced at instantiation time like a
 * Visual Component's inlined body), so this walks the actual tree via
 * `getParent` instead of an `_owningRefId` chain.
 *
 * Figma's nesting model: a click anywhere inside an instance's subtree
 * selects the instance, not the specific descendant — UNLESS the user has
 * already "entered" that instance (double-click / Enter), in which case
 * clicks land on the real node again, same as any other part of the canvas,
 * until a NESTED instance boundary is crossed.
 *
 * Walks from `nodeId` up through its ancestors (inclusive) and returns the
 * id of the OUTERMOST `studio.instance` ancestor that is NOT in
 * `enteredInstanceIds`. Returns `null` when `nodeId` isn't inside any
 * not-yet-entered instance — either it's outside every instance, or every
 * instance ancestor on its path has been entered.
 *
 * OUTERMOST, not nearest (P2-B): a `Button` instance inside a `Card`
 * instance is part of the card until the card is entered. Returning the
 * nearest made the first click on the button select the BUTTON, and a
 * double-click then entered the button while the card stayed closed — so the
 * next click selected the card again. Figma selects the card, and each
 * double-click opens one level (`resolveInstanceEntry`).
 *
 * `tree` is a `Page` (or any `NodeTree<PageNode>`) — callers pass the
 * specific frame's page via `selectCanvasPageFor`, matching the VC lock-down
 * call sites above.
 */
export function findEnclosingInstance(
  tree: NodeTree<PageNode>,
  nodeId: string,
  enteredInstanceIds: readonly string[],
): string | null {
  const visited = new Set<string>()
  let current: PageNode | undefined = tree.nodes[nodeId]
  let outermost: string | null = null

  while (current) {
    if (visited.has(current.id)) return null // cycle guard
    visited.add(current.id)

    if (current.moduleId === 'studio.instance' && !enteredInstanceIds.includes(current.id)) {
      outermost = current.id
    }

    current = getParent(tree, current.id)
  }

  return outermost
}

/**
 * A double-click on `nodeId` inside a not-yet-entered instance: which
 * instance it OPENS, and what it selects once that one is open — the next
 * closed instance on the way down, or `nodeId` itself when there is none.
 * One level per double-click, as in Figma. `null` when `nodeId` is not
 * inside any closed instance (the double-click means something else).
 */
export function resolveInstanceEntry(
  tree: NodeTree<PageNode>,
  nodeId: string,
  enteredInstanceIds: readonly string[],
): { enter: string; select: string } | null {
  const enter = findEnclosingInstance(tree, nodeId, enteredInstanceIds)
  if (enter === null) return null
  const select = findEnclosingInstance(tree, nodeId, [...enteredInstanceIds, enter]) ?? nodeId
  return { enter, select }
}

// ---------------------------------------------------------------------------
// canvasClickSelectionMode
// ---------------------------------------------------------------------------

/**
 * What a click on the CANVAS does to the selection, given its modifiers
 * (OD-3, IX-2): ⇧-click and ⌘/Ctrl-click both TOGGLE the node in or out —
 * Figma's and Penpot's canvas (`actions.cljs`: `select-shape id shift?`).
 *
 * The canvas used to read ⇧ as a tree RANGE, the Layers panel's meaning. On
 * a board a range is a depth-first run through the source tree, so ⇧-clicking
 * two cards selected every node between them — headings, icons, wrappers — a
 * selection nobody could see the shape of. The Layers panel keeps ⇧ = range
 * (`TreeNode.tsx`), where the rows between the two clicks ARE the range.
 *
 * Every canvas click path calls this — the frame's React click, a bridge
 * frame's forwarded click, and a native `<select>` activation — so the three
 * can never disagree about a modifier.
 */
export function canvasClickSelectionMode(modifiers: {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}): 'toggle' | 'replace' {
  return modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey ? 'toggle' : 'replace'
}
