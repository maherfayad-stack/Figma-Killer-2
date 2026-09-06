/**
 * layerRows — the Layers tree as a flat row list.
 *
 * The panel used to render itself recursively: a `TreeNode` per node, each
 * rendering a `role="group"` of more `TreeNode`s. That shape makes windowing
 * impossible (there is no index to slice) and it makes "how many rows are on
 * screen" unanswerable without walking React's tree.
 *
 * Flattening first makes both trivial. `flattenLayerRows` walks ONLY expanded
 * branches, so its cost is O(visible rows), never O(nodes) — a collapsed
 * 40,000-node page flattens to one row. Everything downstream (windowing,
 * scroll-to-selection, the open-container-group highlight, drag hit-testing)
 * is index math over this array.
 *
 * Pure functions, no React, no store. Unit-tested in
 * `src/__tests__/panels/layerRows.test.ts`.
 */

/** The minimum a node must expose for the flattener. */
interface FlattenableNode {
  children: string[]
}

export interface LayerRow {
  nodeId: string
  /** Indentation level; the roots passed in are depth 0. */
  depth: number
  hasChildren: boolean
  expanded: boolean
  /**
   * Index one past the last row of this row's own visible subtree. `rows
   * .slice(index, row.subtreeEnd)` is exactly "this row and everything visible
   * under it" — used by the open-container-group highlight and by the
   * drag-source dimming, both of which span a whole subtree.
   */
  subtreeEnd: number
  /** 1-based position among visible siblings (WAI-ARIA `aria-posinset`). */
  posInSet: number
  /** Number of visible siblings (WAI-ARIA `aria-setsize`). */
  setSize: number
}

/**
 * Flatten the visible rows of a tree, depth-first, in document order.
 *
 * @param nodes            the tree's node map
 * @param rootIds          the top-level rows to render (one for a page body,
 *                         many when the structural root is hidden in VC mode)
 * @param expandedIds      immutable snapshot of the panel's `ExpansionStore`
 * @param alwaysExpandedId a node forced open regardless of `expandedIds` — the
 *                         page body, which has no collapse affordance
 */
export function flattenLayerRows(
  nodes: Record<string, FlattenableNode | undefined>,
  rootIds: readonly string[],
  expandedIds: ReadonlySet<string>,
  alwaysExpandedId: string | null,
): LayerRow[] {
  const rows: LayerRow[] = []
  // A malformed tree (mid-edit, or a hand-written fixture) can contain a cycle.
  // The old recursive renderer would have recursed until React blew the stack;
  // here it costs one Set.
  const seen = new Set<string>()

  const walk = (ids: readonly string[], depth: number): void => {
    for (let i = 0; i < ids.length; i += 1) {
      const nodeId = ids[i]
      const node = nodes[nodeId]
      if (!node || seen.has(nodeId)) continue
      seen.add(nodeId)

      const hasChildren = node.children.length > 0
      const expanded = nodeId === alwaysExpandedId ? true : expandedIds.has(nodeId)
      const index = rows.length
      rows.push({
        nodeId,
        depth,
        hasChildren,
        expanded,
        subtreeEnd: index + 1,
        posInSet: i + 1,
        setSize: ids.length,
      })

      if (hasChildren && expanded) walk(node.children, depth + 1)
      rows[index].subtreeEnd = rows.length
    }
  }

  walk(rootIds, 0)
  return rows
}

/** Index of `nodeId` in a flattened row list, or -1 when it is not visible. */
export function findLayerRowIndex(rows: readonly LayerRow[], nodeId: string): number {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].nodeId === nodeId) return i
  }
  return -1
}

/**
 * Where a row sits inside a highlighted span. The recursive renderer got this
 * for free — the highlight lived on the wrapper `<div>` that contained the row
 * AND its children group. A flat list has no such wrapper, so the span is
 * reconstructed per row: the first row rounds its top corners, the last rounds
 * its bottom, the middle rounds nothing, and a one-row span rounds all four.
 */
export type LayerRowSpanPosition = 'single' | 'start' | 'middle' | 'end'

/**
 * Mark every row of every span whose head satisfies `isSpanHead`.
 *
 * Returns a parallel array — `positions[i]` is `undefined` when row `i` is in
 * no span. Nested spans overwrite outer ones; the two render identically, so
 * the inner (more specific) one wins.
 */
export function computeRowSpans(
  rows: readonly LayerRow[],
  isSpanHead: (row: LayerRow, index: number) => boolean,
): Array<LayerRowSpanPosition | undefined> {
  const positions = new Array<LayerRowSpanPosition | undefined>(rows.length).fill(undefined)

  for (let i = 0; i < rows.length; i += 1) {
    if (!isSpanHead(rows[i], i)) continue
    const end = rows[i].subtreeEnd
    if (end - i === 1) {
      positions[i] = 'single'
      continue
    }
    for (let j = i; j < end; j += 1) {
      positions[j] = j === i ? 'start' : j === end - 1 ? 'end' : 'middle'
    }
  }

  return positions
}

/**
 * Row indices covered by `nodeId` and its visible subtree — the drag-source
 * dimming, which used to come free from the wrapper `<div>`. Returns `null`
 * when the node is not visible.
 */
export function subtreeRowRange(
  rows: readonly LayerRow[],
  nodeId: string,
): { start: number; end: number } | null {
  const index = findLayerRowIndex(rows, nodeId)
  if (index < 0) return null
  return { start: index, end: rows[index].subtreeEnd }
}
