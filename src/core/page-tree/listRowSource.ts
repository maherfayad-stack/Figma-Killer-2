/**
 * listRowSource — OD-8's structural half: a `.map` row's reorder, delete,
 * duplicate and paste are written to the ARRAY the `.map` iterates, not to
 * the JSX.
 *
 * A row has no source location of its own (`…:14:9#2` deliberately fails the
 * location grammar): one piece of JSX renders every row, so there is no JSX
 * position an edit to row 2 could occupy without changing all of them. But the
 * row's DATA does have one. When the `.map` iterates an array literal written
 * in the same file — inline (`[a, b].map(…)`) or a `const` (`const ROWS = […]`)
 * — element `k` of that literal IS row `k`, and permuting, removing or copying
 * elements is exactly one honest write: the array literal is one place.
 *
 * The parser decides which rows qualify and stamps each row's ROOT node with
 * {@link ListRowSource} (`ParsedNode.listRow` → `PageNode.listRow`): either the
 * array's own position and this row's index in it, or the reason there is no
 * array to edit (imported, computed, a prop, a spread, a list nested in another
 * list's row, several elements per item). Everything else here is pure and
 * reads only that stamp and the id grammar.
 *
 * `array` is the literal's own `[` position. It is stable across the literal's
 * own edits (every write lands after the `[`), which is what lets an undo that
 * was recorded before a write address the array after it.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { isInlinedNodeId, loopTemplateNodeId } from './sourceNodeId'

/**
 * How a row's React `key` is read off its item — what a COPY has to change so
 * two rows never share a key. `none`: no key, or the index (a copy is fine as
 * it is). `field`: `key={item.id}`. `item`: `key={item}` (a primitive item is
 * its own key — a copy cannot differ without changing what it shows).
 * `computed`: anything else, which Studio cannot make unique.
 */
export const ListRowKeySchema = Type.Union([
  Type.Object({ kind: Type.Literal('none') }),
  Type.Object({ kind: Type.Literal('item') }),
  Type.Object({ kind: Type.Literal('field'), field: Type.String() }),
  Type.Object({ kind: Type.Literal('computed') }),
])
export type ListRowKey = Static<typeof ListRowKeySchema>

/** Why a row's array cannot be edited from the board. See {@link LIST_ROW_REFUSAL_TEXT}. */
export const ListRowRefusalCodeSchema = Type.Union([
  Type.Literal('imported'),
  Type.Literal('computed'),
  Type.Literal('prop'),
  Type.Literal('spread'),
  Type.Literal('nested'),
  Type.Literal('multi-root'),
])
export type ListRowRefusalCode = Static<typeof ListRowRefusalCodeSchema>

/**
 * Stamped on a `.map` row's ROOT node by the parser. `source` is the text of
 * the expression the `.map` is called on (`ROWS`, `plans.filter(…)`), for the
 * sentence a person reads.
 */
export const ListRowSourceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('array'),
    /** The array literal's own `rel:line:col` (its `[`). */
    array: Type.String(),
    index: Type.Integer({ minimum: 0 }),
    /** How many elements the literal has — the identity a write checks before touching it. */
    length: Type.Integer({ minimum: 1 }),
    key: ListRowKeySchema,
    source: Type.String(),
  }),
  Type.Object({ kind: Type.Literal('refused'), reason: ListRowRefusalCodeSchema, source: Type.String() }),
])
export type ListRowSource = Static<typeof ListRowSourceSchema>
export type ListRowArraySource = Extract<ListRowSource, { kind: 'array' }>

/**
 * The three operations on an array literal (`editListItems` in
 * `@core/ast-codemods`), in terms of element indices of the literal AS IT IS
 * when the edit runs.
 *
 *  - `reorder` — `order[k]` is the old index of the element that ends at `k`.
 *  - `remove` — those elements go.
 *  - `copy` — copies of `from` (in that order) are written so the first sits
 *    at `at`. `key` names the field a copy rewrites to stay unique.
 *
 * None carries source text: ⌘Z of a `remove` is the undo journal's `restore`
 * (P3-F), which puts back the server's own pre-image of the file.
 */
export const ListItemOpSchema = Type.Union([
  Type.Object({ kind: Type.Literal('reorder'), order: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }) }),
  Type.Object({ kind: Type.Literal('remove'), indices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }) }),
  Type.Object({
    kind: Type.Literal('copy'),
    from: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
    at: Type.Integer({ minimum: 0 }),
    key: Type.Optional(ListRowKeySchema),
  }),
])
export type ListItemOp = Static<typeof ListItemOpSchema>

/** One array-literal write, as it goes on the wire (`kind: 'list-item'`). `length` is the element count the op expects to find. */
export interface ListItemEdit {
  kind: 'list-item'
  nodeId: string
  length: number
  op: ListItemOp
}

/** How many elements the literal has after `op`. */
export function listItemLengthAfter(length: number, op: ListItemOp): number {
  switch (op.kind) {
    case 'reorder':
      return length
    case 'remove':
      return length - op.indices.length
    case 'copy':
      return length + op.from.length
  }
}

/**
 * The edit that takes `edit` back, when it is knowable before the write: a
 * reorder by the inverse permutation, a copy by removing what it wrote. `null`
 * for a `remove` — its inverse is the undo journal's `restore` of the file.
 */
export function invertListItemEdit(edit: ListItemEdit): ListItemEdit | null {
  const length = listItemLengthAfter(edit.length, edit.op)
  const back = (op: ListItemOp): ListItemEdit => ({ kind: 'list-item', nodeId: edit.nodeId, length, op })
  switch (edit.op.kind) {
    case 'reorder': {
      const inverse: number[] = []
      edit.op.order.forEach((oldIndex, newIndex) => {
        inverse[oldIndex] = newIndex
      })
      return back({ kind: 'reorder', order: inverse })
    }
    case 'copy': {
      const { at, from } = edit.op
      return back({ kind: 'remove', indices: from.map((_, k) => at + k) })
    }
    case 'remove':
      return null
  }
}

/** A row's array stamp, or `null` when `node` is not a row root the parser could tie to an array. */
export function listRowArrayOf(node: { id: string; listRow?: ListRowSource }): ListRowArraySource | null {
  return node.listRow?.kind === 'array' && !isInlinedNodeId(node.id) ? node.listRow : null
}

/** True for any node the parser minted inside a `.map` row — the row root and everything in it. */
export function isListRowNodeId(nodeId: string): boolean {
  return loopTemplateNodeId(nodeId) !== null
}

const LEAD = 'Studio edits a list row by changing the array its .map() reads'

/** The sentence for each code, completing {@link LEAD}. */
const LIST_ROW_REFUSAL_TEXT: Record<ListRowRefusalCode, (source: string) => string> = {
  imported: (source) => `, and ${source} is imported from another file — its items are written there. Open that file to edit them.`,
  computed: (source) => `, and ${source} is computed by the code rather than written out as an array here, so there is no array to change.`,
  prop: (source) => `, and ${source} is handed to this component from outside, so the array is not written in this file.`,
  spread: (source) => `, and ${source} spreads another list into it, so a row's place on the board is not its place in the source.`,
  nested: () => `, and this list is drawn once inside every row of an outer list — its array is shared by all of them, so changing it here would change every copy.`,
  'multi-root': (source) => `, and each item of ${source} renders several elements, so one of them cannot change without the others. Edit the array in code.`,
}

/**
 * Why a `.map` row (or anything inside one) cannot be moved, deleted or copied
 * THROUGH ITS ARRAY with `gesture`, or `null` when it can (`gestureWritesArray`
 * and a row root with an editable array).
 *
 * `gestureWritesArray` is false for every gesture the array cannot express —
 * wrap, group, reparent, extract, an insert INTO a row — which keep the old
 * sentence: one piece of source JSX renders every row.
 */
export function listRowRefusalMessage(
  node: { id: string; listRow?: ListRowSource },
  gesture: string,
  gestureWritesArray: boolean,
): string {
  const row = node.listRow
  if (isInlinedNodeId(node.id) && row) {
    return `${LEAD}, and this list is written in a shared component's own file — its array is shared by every place the component is used.`
  }
  if (row?.kind === 'refused') return `${LEAD}${LIST_ROW_REFUSAL_TEXT[row.reason](row.source)}`
  if (row?.kind === 'array' && gestureWritesArray) return '' // not refused — the caller writes the array
  if (row?.kind === 'array') {
    return `${gesture} a row of a list that the code generates. Studio can reorder, duplicate or delete a row by editing the array it maps over, but one piece of source JSX renders every row, so this cannot change for one row alone.`
  }
  return `${gesture} part of a row of a list that the code generates. One piece of source JSX renders every row, so this cannot change in one row alone — select the whole row to reorder, duplicate or delete it, which edits the array.`
}
