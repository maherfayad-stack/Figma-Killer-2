/**
 * listRowPlans — OD-8: which array write a structural gesture on `.map` rows
 * is, or why it has none. Pure, tree-only; the store dresses and commits the
 * answer, the drag preview reads the same verdict (`previewStructuralMove`).
 *
 * Every planner answers `null` when the gesture touches no row at all — "not
 * this module's business", the ordinary element rules apply — so a caller can
 * ask it first, unconditionally. When a row IS involved the answer is either
 * one `list-item` edit on one array literal, or a refusal naming why:
 *
 *  - a selection mixing rows with ordinary elements, or rows of two lists —
 *    two different kinds of write that could land half-way;
 *  - a node INSIDE a row (only the row root stands for an array element);
 *  - a row whose array is not written here (`ListRowSource.refused`, or a
 *    list inside a shared component);
 *  - a move that leaves the list (a row's place is its index in the array —
 *    a spot among other siblings is not an index);
 *  - a list the board shows only part of (the first `MAX_LOOP_ITERATIONS`):
 *    a new order written from a partial view would scramble the rest.
 *
 * The id a refusal is about travels with it, so the store's refusal surface
 * can point at that row.
 */
import {
  isListRowNodeId,
  listRowArrayOf,
  listRowRefusalMessage,
  type ListItemEdit,
  type ListRowArraySource,
  type ListRowSource,
} from './listRowSource'
import type { StructuralRefusal } from './sourceStructure'
import { createScratchTree, moveOnScratch, type SequencedMove } from './moveSequence'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

/** A row gesture that writes: the one array edit, what ⌘Z is called, and which indices of the NEW array to select once it lands. */
export interface ListRowEditPlan {
  edit: ListItemEdit
  label: string
  /** Indices into the array AFTER the edit — the rows to select once the board has re-read it. */
  select: number[]
}

export type ListRowPlan =
  | ({ ok: true } & ListRowEditPlan)
  | { ok: false; refusal: StructuralRefusal; nodeId: string }

type RowNode = { id: string; listRow?: ListRowSource }

type ResolvedRows =
  | { ok: true; array: ListRowArraySource; indices: number[] }
  | { ok: false; refusal: StructuralRefusal; nodeId: string }

function refused(nodeId: string, message: string): { ok: false; refusal: StructuralRefusal; nodeId: string } {
  return { ok: false, refusal: { reason: 'list-row', message }, nodeId }
}

/**
 * The array every node in `nodes` is a row of, and their indices — or `null`
 * when none is a row, or the refusal when the selection cannot be one array
 * write. `gesture` is the past-tense verb the sentence uses.
 */
function resolveRows(nodes: readonly RowNode[], gesture: string): ResolvedRows | null {
  const rows = nodes.filter((node) => isListRowNodeId(node.id))
  if (rows.length === 0) return null
  if (rows.length !== nodes.length) {
    const other = nodes.find((node) => !isListRowNodeId(node.id))!
    return refused(
      other.id,
      'List rows are written to their array and other elements to the markup — two different changes. Select only rows, or only elements, and try again.',
    )
  }
  let array: ListRowArraySource | null = null
  const indices: number[] = []
  for (const node of rows) {
    const own = listRowArrayOf(node)
    if (!own) return refused(node.id, listRowRefusalMessage(node, gesture, true))
    if (array && own.array !== array.array) {
      return refused(node.id, 'These rows belong to two different lists, so there is no single array to write them in. Change one list at a time.')
    }
    array ??= own
    if (!indices.includes(own.index)) indices.push(own.index)
  }
  return { ok: true, array: array!, indices: indices.sort((a, b) => a - b) }
}

/** The rows of `array` among `children`, in child order. */
function rowsOf(tree: NodeTree<PageNode>, children: readonly string[], array: string): string[] {
  return children.filter((id) => {
    const node = tree.nodes[id]
    return node !== undefined && listRowArrayOf(node)?.array === array
  })
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many.replace('N', String(count))
}

/** ⌫ on rows: remove their elements from the array. */
export function planListRowRemove(nodes: readonly RowNode[]): ListRowPlan | null {
  const rows = resolveRows(nodes, 'Deleted')
  if (!rows) return null
  if (!rows.ok) return rows
  const { array, indices } = rows
  return {
    ok: true,
    edit: { kind: 'list-item', nodeId: array.array, length: array.length, op: { kind: 'remove', indices } },
    label: plural(indices.length, 'Delete row', 'Delete N rows'),
    select: [],
  }
}

/**
 * The copy op for rows `from` of `array`, landing at `at` — refused up front
 * when the rows' key cannot be made unique (a primitive item that IS its key,
 * or a computed key): two rows with one key is a bug in the user's app.
 */
function copyPlan(array: ListRowArraySource, from: number[], at: number, label: string, nodeId: string): ListRowPlan {
  if (array.key.kind === 'item' || array.key.kind === 'computed') {
    return refused(
      nodeId,
      array.key.kind === 'item'
        ? `Each row's React key is its own item, so a copy of it would share its key with the original. Studio will not write two rows with one key — add a distinct item to ${array.source} in code instead.`
        : `Each row's React key is computed from its item, so Studio cannot give a copy a key of its own. Add the item to ${array.source} in code instead.`,
    )
  }
  return {
    ok: true,
    edit: {
      kind: 'list-item',
      nodeId: array.array,
      length: array.length,
      op: { kind: 'copy', from, at, ...(array.key.kind === 'field' ? { key: array.key } : {}) },
    },
    label,
    select: from.map((_, k) => at + k),
  }
}

/** ⌘D on rows: a copy of each, together after the last of them. */
export function planListRowCopy(nodes: readonly RowNode[]): ListRowPlan | null {
  const rows = resolveRows(nodes, 'Duplicated')
  if (!rows) return null
  if (!rows.ok) return rows
  const { array, indices } = rows
  return copyPlan(array, indices, indices[indices.length - 1]! + 1, plural(indices.length, 'Duplicate row', 'Duplicate N rows'), nodes[0]!.id)
}

/**
 * The array order a move leaves: `finalChildren` is the parent's child list
 * AFTER the move (`moved` among it). `null` when no moved node is a row.
 */
function reorderPlan(
  tree: NodeTree<PageNode>,
  moved: readonly string[],
  parentId: string,
  finalChildren: readonly string[],
): ListRowPlan | null {
  const nodes = moved.map((id) => tree.nodes[id] ?? { id })
  const rows = resolveRows(nodes, 'Moved')
  if (!rows) return null
  if (!rows.ok) return rows
  const { array } = rows
  const firstId = moved[0]!
  const leaves = refused(
    firstId,
    `A row moves within its own list: Studio writes the new order into ${array.source}, and a place outside the list is not a position in it.`,
  )
  const parent = tree.nodes[parentId]
  if (!parent || !moved.every((id) => parent.children.includes(id) || finalChildren.includes(id))) return leaves
  const before = rowsOf(tree, parent.children, array.array)
  // Every row of the list must be on the board, or a new order written from
  // the part the board shows would scramble the rest.
  if (before.length !== array.length) {
    return refused(firstId, `Only part of ${array.source} is on the board, so Studio cannot write a new order for the whole array. Reorder it in code.`)
  }
  const after = rowsOf(tree, finalChildren, array.array)
  if (after.length !== array.length) return leaves
  // The rows must still be one unbroken run — a row dropped among other
  // siblings has left its list.
  const first = finalChildren.indexOf(after[0]!)
  if (after.some((id, k) => finalChildren[first + k] !== id)) return leaves
  const order = after.map((id) => listRowArrayOf(tree.nodes[id]!)!.index)
  if (order.every((oldIndex, k) => oldIndex === k)) return null
  return {
    ok: true,
    edit: { kind: 'list-item', nodeId: array.array, length: array.length, op: { kind: 'reorder', order } },
    label: plural(moved.length, 'Move row', 'Move N rows'),
    select: moved.map((id) => after.indexOf(id)).filter((k) => k >= 0),
  }
}

/**
 * A drag / ⌥↑↓ / grid step of `nodeIds` to `newIndex` of `newParentId` —
 * `moveNodes`' own convention (the moving ids detached first). `null` when no
 * moved node is a row; an ok plan with an identity order is `null` too (the
 * drop changes nothing).
 */
export function planListRowMove(
  tree: NodeTree<PageNode>,
  nodeIds: readonly string[],
  newParentId: string,
  newIndex: number,
): ListRowPlan | null {
  if (!nodeIds.some(isListRowNodeId)) return null
  const parent = tree.nodes[newParentId]
  if (!parent) return null
  const moving = nodeIds.filter((id) => parent.children.includes(id))
  const without = parent.children.filter((id) => !moving.includes(id))
  const at = Math.max(0, Math.min(newIndex, without.length))
  const finalChildren = moving.length === nodeIds.length
    ? [...without.slice(0, at), ...moving, ...without.slice(at)]
    : [] // a row dragged into another parent has left its list
  return reorderPlan(tree, nodeIds, newParentId, finalChildren)
}

/** The same, for a recorded sequence of single moves (`stepSiblings`, a multi-row drag): the order the whole sequence leaves. */
export function planListRowMoveSequence(tree: NodeTree<PageNode>, moves: readonly SequencedMove[]): ListRowPlan | null {
  const moved = moves.map((move) => move.nodeId)
  if (!moved.some(isListRowNodeId)) return null
  const parentIds = new Set(moves.map((move) => move.parentId))
  const [parentId] = parentIds
  if (parentIds.size !== 1 || parentId === undefined) return reorderPlan(tree, moved, '', [])
  const scratch = createScratchTree(tree)
  for (const move of moves) moveOnScratch(scratch, move)
  return reorderPlan(tree, moved, parentId, scratch.nodes[parentId]?.children ?? [])
}

/**
 * ⌘V / ⌥-drag of copied rows to `newIndex` of `newParentId` (`moveNodes`
 * convention, nothing detached — a copy leaves its original). Copies land in
 * the array where the drop is among that list's rows; anywhere else refuses.
 * `copied` may come from another frame (ERR-8): only its stamp is read.
 */
export function planListRowCopyTo(
  tree: NodeTree<PageNode>,
  copied: readonly RowNode[],
  newParentId: string,
  newIndex: number,
): ListRowPlan | null {
  const rows = resolveRows(copied, 'Pasted')
  if (!rows) return null
  if (!rows.ok) return rows
  const { array, indices } = rows
  const parent = tree.nodes[newParentId]
  const listed = parent ? rowsOf(tree, parent.children, array.array) : []
  const first = listed.length > 0 && parent ? parent.children.indexOf(listed[0]!) : -1
  const offset = newIndex - first
  if (first < 0 || offset < 0 || offset > listed.length || listed.length !== array.length) {
    return refused(
      copied[0]!.id,
      `A copied row can only be placed inside its own list: Studio writes it as a new item of ${array.source}, and anywhere else is not a position in that array.`,
    )
  }
  return copyPlan(array, indices, offset, plural(indices.length, 'Paste row', 'Paste N rows'), copied[0]!.id)
}
