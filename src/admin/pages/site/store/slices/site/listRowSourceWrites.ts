/**
 * listRowSourceWrites — the store half of OD-8: a `.map` row's reorder,
 * delete, duplicate and paste are written to the ARRAY the `.map` iterates.
 *
 * The planners are pure and live in `@core/page-tree` (`listRowPlans.ts`),
 * where the drag preview reads the same verdict. Every structural action asks
 * its planner FIRST: `null` means no row is involved and the ordinary element
 * rules apply; otherwise this module either presents the refusal (the same
 * `presentStructuralRefusal` surface every structural gesture uses) or posts
 * the one `list-item` write.
 *
 * The tree is not touched before the write: a row's id is its INDEX in the
 * list, so an optimistic reorder would leave every id naming the wrong row.
 * The board's own re-read puts each row in its new place; once it has,
 * `onLanded` selects what the gesture moved or made and records where every
 * row of the list went (`listRowRemap.ts`), so a gesture queued behind this
 * one (⌥↓ pressed twice) acts on the row the user meant.
 */
import {
  describeStructuralRefusal,
  invertListItemEdit,
  listItemLengthAfter,
  listRowArrayOf,
  type ListItemEdit,
  type ListRowPlan,
} from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import { commitStudioListItem } from '@site/studio/studioStructuralCommits'
import { recordListRowRemap } from '@site/studio/listRowRemap'
import type { StructuralInverseTemplate } from '@site/studio/structuralUndoPlan'
import { presentStructuralRefusal, type STRUCTURAL_REFUSAL_TITLE } from './structuralSourceEdits'
import type { EditorStoreSetter } from './types'

type RefusalTitle = (typeof STRUCTURAL_REFUSAL_TITLE)[keyof typeof STRUCTURAL_REFUSAL_TITLE]

/**
 * Present `plan`'s refusal, or post its write. Returns nothing: every
 * outcome — refusal, write — is this gesture's whole answer, and the caller
 * returns right after.
 */
export function writeListRowPlan(
  plan: ListRowPlan,
  title: RefusalTitle,
  context: { get: () => EditorStore; set: EditorStoreSetter },
): void {
  const { get, set } = context
  if (!plan.ok) {
    const node = nodeOnBoard(get(), plan.nodeId)
    presentStructuralRefusal(title, describeStructuralRefusal({ refusal: plan.refusal, ...(node ? { node } : {}) }), {
      nodeId: plan.nodeId,
      getState: get,
      set,
    })
    return
  }
  const { edit, label, select } = plan
  const before = rowIdsOf(get(), edit.nodeId)
  void commitStudioListItem({ ...edit }, title, { label, template: inverseTemplate(edit) }, (outcome) => {
    const state = get()
    // The array's `[` as the write left it (a delete's import prune moves it).
    const arrayNow = outcome.listArrays.find((entry) => entry.nodeId === edit.nodeId)?.to ?? edit.nodeId
    const after = rowIdsOf(state, arrayNow)
    recordListRowRemap(rowRemap(before, after, edit))
    const selected = select.map((index) => after[index]).filter((id): id is string => id !== undefined)
    if (selected.length === 1) state.selectNode(selected[0]!)
    else if (selected.length > 1) state.selectMany(selected)
  })
}

/** ⌘Z for `edit`: the inverse edit when it is known now, else (a remove) the texts the write will report. */
function inverseTemplate(edit: ListItemEdit): StructuralInverseTemplate {
  const inverse = invertListItemEdit(edit)
  if (inverse) return { kind: 'known', inverse: [{ ...inverse }] }
  const at = edit.op.kind === 'remove' ? [...edit.op.indices].sort((a, b) => a - b) : []
  return { kind: 'list-item-restore', nodeId: edit.nodeId, length: listItemLengthAfter(edit.length, edit.op), at }
}

/** The row root ids of the list whose array is `arrayId`, by index — every frame of the board. */
function rowIdsOf(state: EditorStore, arrayId: string): string[] {
  const ids: string[] = []
  for (const page of state.site?.pages ?? []) {
    for (const node of Object.values(page.nodes)) {
      const row = listRowArrayOf(node)
      if (row?.array === arrayId) ids[row.index] = node.id
    }
  }
  return ids
}

/**
 * Old row id → new row id for every row the write kept. `edit`'s op says
 * where each old index went: follow the old indices through it (a copy's new
 * elements and an insert's restored ones carry no old index).
 */
function rowRemap(before: readonly string[], after: readonly string[], edit: ListItemEdit): Map<string, string> {
  const op = edit.op
  let order: number[] = before.map((_, index) => index)
  switch (op.kind) {
    case 'reorder':
      order = op.order.map((index) => order[index]!)
      break
    case 'remove':
      order = order.filter((index) => !op.indices.includes(index))
      break
    case 'copy':
      order = [...order.slice(0, op.at), ...op.from.map(() => -1), ...order.slice(op.at)]
      break
    case 'insert':
      for (const at of op.at) order.splice(at, 0, -1)
      break
  }
  const remap = new Map<string, string>()
  order.forEach((oldIndex, newIndex) => {
    const from = before[oldIndex]
    const to = after[newIndex]
    if (oldIndex >= 0 && from !== undefined && to !== undefined && from !== to) remap.set(from, to)
  })
  return remap
}

function nodeOnBoard(state: EditorStore, nodeId: string) {
  for (const page of state.site?.pages ?? []) {
    const node = page.nodes[nodeId]
    if (node) return node
  }
  return undefined
}
