/**
 * listRowUnroll — G-9 / OD-24: which `.map` the "Unroll list" action would
 * write out for a node on the board, or `null` when it would not be offered.
 *
 * "Offered" is exactly "the array is a literal written in the same file":
 * `ListRowSource.kind === 'array'` is the parser's own stamp for that (an
 * imported, computed, prop-fed, spread, nested or multi-root list is
 * `refused`), and a list inside a shared component's file has an inlined id.
 * The codemod (`unrollMapExpression`) re-derives all of it from the AST, so
 * this is the cheap early answer, never the authority.
 *
 * Pure and tree-only. A node INSIDE a row stands for its row: the stamp is on
 * the row root, and unrolling the list is what gives the node inside a place
 * of its own.
 */
import { listRowArrayOf, type ListRowArraySource } from './listRowSource'
import type { PageNode } from './pageNode'
import { loopTemplateNodeId } from './sourceNodeId'
import type { NodeTree } from './treeSchema'

/** The `unroll-list` edit as it goes on the wire (`studioUnrollWriteback.ts`'s schema, mirrored by hand like every client-built edit). */
export type UnrollListEdit = {
  kind: 'unroll-list'
  /** The row root's `rel:line:col`, without its `#n` — the one JSX site that renders every row. */
  nodeId: string
  /** The array literal's `[`, in the same file. */
  array: string
  /** The item count the board read. */
  length: number
}

export interface UnrollListPlan {
  edit: UnrollListEdit
  /** The rows' current root ids on the board, in array order — what the written elements replace. */
  rowRootIds: string[]
  /** The expression the `.map` is called on (`TRACKS`), for the sentence a person reads. */
  source: string
}

/** The row root `nodeId` is, or sits inside; `null` when it is not in a list Studio can unroll. */
function rowRootOf(tree: NodeTree<PageNode>, nodeId: string): (PageNode & { listRow: ListRowArraySource }) | null {
  let current: PageNode | undefined = tree.nodes[nodeId]
  for (; current; current = current.parentId ? tree.nodes[current.parentId] : undefined) {
    const row = listRowArrayOf(current)
    if (row) return { ...current, listRow: row }
  }
  return null
}

export function planUnrollList(tree: NodeTree<PageNode>, nodeId: string): UnrollListPlan | null {
  const root = rowRootOf(tree, nodeId)
  if (!root) return null
  const template = loopTemplateNodeId(root.id)
  if (!template) return null
  const rows: { id: string; index: number }[] = []
  for (const node of Object.values(tree.nodes)) {
    const row = listRowArrayOf(node)
    if (row && row.array === root.listRow.array && loopTemplateNodeId(node.id) === template) rows.push({ id: node.id, index: row.index })
  }
  rows.sort((a, b) => a.index - b.index)
  return {
    edit: { kind: 'unroll-list', nodeId: template, array: root.listRow.array, length: root.listRow.length },
    rowRootIds: rows.map((row) => row.id),
    source: root.listRow.source,
  }
}
