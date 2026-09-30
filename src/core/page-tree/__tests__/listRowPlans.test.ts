/**
 * OD-8 — which array write a structural gesture on `.map` rows is, or why it
 * has none (`listRowPlans.ts`), and the drag preview reading the same verdict
 * (`previewStructuralMove`). The refusals matter as much as the writes: a row
 * gesture that used to refuse and now writes must write to exactly one
 * honest place, and every case that has none must still say so.
 */
import { describe, expect, it } from 'bun:test'
import {
  planListRowCopy,
  planListRowCopyTo,
  planListRowMove,
  planListRowMoveSequence,
  planListRowRemove,
} from '../listRowPlans'
import { invertListItemEdit, type ListRowSource } from '../listRowSource'
import { previewStructuralMove } from '../sourceStructurePreview'
import type { NodeTree } from '../treeSchema'
import type { PageNode } from '../pageNode'

const ARRAY = 'src/Board.tsx:3:17'
const TPL = 'src/Board.tsx:12:9'

function node(id: string, parentId: string | null, children: string[] = [], listRow?: ListRowSource): PageNode {
  return {
    id,
    moduleId: 'base.container',
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    parentId,
    ...(listRow ? { listRow } : {}),
  }
}

const row = (index: number, length = 3): ListRowSource => ({
  kind: 'array',
  array: ARRAY,
  index,
  length,
  key: { kind: 'field', field: 'id' },
  source: 'COLUMNS',
})

/** main → [header, col#0, col#1, col#2, footer]; col#k → [col-title#k]. */
function tree(rowSource: (index: number) => ListRowSource | undefined = row): NodeTree<PageNode> {
  const main = 'src/Board.tsx:10:5'
  const rows = [0, 1, 2].map((k) => `${TPL}#${k}`)
  const nodes: Record<string, PageNode> = {
    root: node('root', null, [main]),
    [main]: node(main, 'root', ['src/Board.tsx:11:7', ...rows, 'src/Board.tsx:15:7']),
    'src/Board.tsx:11:7': node('src/Board.tsx:11:7', main),
    'src/Board.tsx:15:7': node('src/Board.tsx:15:7', main),
  }
  rows.forEach((id, k) => {
    const title = `src/Board.tsx:12:30#${k}`
    nodes[id] = node(id, main, [title], rowSource(k))
    nodes[title] = node(title, id)
  })
  return { rootNodeId: 'root', nodes }
}

const MAIN = 'src/Board.tsx:10:5'
const ROW = (k: number) => `${TPL}#${k}`

describe('planListRowMove — a reorder written to the array', () => {
  it('moving the first row to the end is a permutation of the literal, selecting the moved row', () => {
    const plan = planListRowMove(tree(), [ROW(0)], MAIN, 3)
    expect(plan).toEqual({
      ok: true,
      edit: { kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'reorder', order: [1, 2, 0] } },
      label: 'Move row',
      select: [2],
    })
  })

  it('an order that does not change is no write at all', () => {
    expect(planListRowMove(tree(), [ROW(1)], MAIN, 2)).toBeNull()
  })

  it('two rows moved together, in the order they were given', () => {
    const plan = planListRowMove(tree(), [ROW(2), ROW(0)], MAIN, 1)
    expect(plan?.ok && plan.edit.op).toEqual({ kind: 'reorder', order: [2, 0, 1] })
  })

  it('a grid step recorded as a sequence of single moves lands as ONE reorder', () => {
    const plan = planListRowMoveSequence(tree(), [{ nodeId: ROW(0), parentId: MAIN, index: 3 }])
    expect(plan?.ok && plan.edit.op).toEqual({ kind: 'reorder', order: [1, 2, 0] })
  })

  it('no row involved — not this module’s business', () => {
    expect(planListRowMove(tree(), ['src/Board.tsx:11:7'], MAIN, 4)).toBeNull()
  })

  it('refuses a row dropped outside its list, or into another parent', () => {
    const outside = planListRowMove(tree(), [ROW(1)], MAIN, 0)
    expect(outside?.ok).toBe(false)
    expect(!outside?.ok && outside?.refusal.message).toContain('moves within its own list')
    expect(planListRowMove(tree(), [ROW(1)], 'root', 0)?.ok).toBe(false)
  })

  it('refuses a node INSIDE a row, a row mixed with an element, and a list the board shows only part of', () => {
    const inside = planListRowMove(tree(), ['src/Board.tsx:12:30#1'], ROW(1), 0)
    expect(!inside?.ok && inside?.refusal.message).toContain('select the whole row')
    const mixed = planListRowMove(tree(), [ROW(0), 'src/Board.tsx:15:7'], MAIN, 0)
    expect(!mixed?.ok && mixed?.refusal.message).toContain('Select only rows')
    const partial = planListRowMove(tree((k) => row(k, 150)), [ROW(0)], MAIN, 3)
    expect(!partial?.ok && partial?.refusal.message).toContain('Only part of COLUMNS')
  })

  it('refuses a row whose array is not written here, naming why', () => {
    const imported = tree(() => ({ kind: 'refused', reason: 'imported', source: 'COLUMNS' }))
    const plan = planListRowMove(imported, [ROW(0)], MAIN, 3)
    expect(plan?.ok).toBe(false)
    expect(!plan?.ok && plan?.refusal).toEqual({
      reason: 'list-row',
      message: expect.stringContaining('COLUMNS is imported from another file'),
    })
  })

  it('refuses a list inside a shared component (an inlined row id)', () => {
    const t = tree()
    const inlined = `pages/Home.tsx:4:5~${ROW(0)}`
    t.nodes[inlined] = { ...t.nodes[ROW(0)]!, id: inlined }
    t.nodes[MAIN]!.children = t.nodes[MAIN]!.children.map((id) => (id === ROW(0) ? inlined : id))
    const plan = planListRowMove(t, [inlined], MAIN, 3)
    expect(!plan?.ok && plan?.refusal.message).toContain("shared component's own file")
  })

  it('previewStructuralMove reads the same verdict: ok with the list write, or the same refusal', () => {
    const ok = previewStructuralMove(tree(), [ROW(0)], MAIN, 3)
    expect(ok.ok && ok.commit).toBeNull()
    expect(ok.ok && ok.listRow?.edit.op).toEqual({ kind: 'reorder', order: [1, 2, 0] })
    const refused = previewStructuralMove(tree(), [ROW(1)], MAIN, 0)
    expect(!refused.ok && refused.refusal.reason).toBe('list-row')
    // A row dropped onto its own place writes nothing and never falls through to the JSX rules.
    expect(previewStructuralMove(tree(), [ROW(1)], MAIN, 2)).toEqual({ ok: true, commit: null })
  })
})

describe('planListRowRemove / planListRowCopy / planListRowCopyTo', () => {
  it('delete removes the selected elements, sorted', () => {
    const t = tree()
    expect(planListRowRemove([t.nodes[ROW(2)]!, t.nodes[ROW(0)]!])).toEqual({
      ok: true,
      edit: { kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'remove', indices: [0, 2] } },
      label: 'Delete 2 rows',
      select: [],
    })
  })

  it('duplicate copies the rows after the last of them, rewriting the key field, and selects the copies', () => {
    const t = tree()
    expect(planListRowCopy([t.nodes[ROW(1)]!])).toEqual({
      ok: true,
      edit: { kind: 'list-item', nodeId: ARRAY, length: 3, op: { kind: 'copy', from: [1], at: 2, key: { kind: 'field', field: 'id' } } },
      label: 'Duplicate row',
      select: [2],
    })
  })

  it('duplicate refuses when a copy could not get a key of its own', () => {
    const t = tree((k) => ({ ...row(k), key: { kind: 'item' } }))
    const plan = planListRowCopy([t.nodes[ROW(0)]!])
    expect(!plan?.ok && plan?.refusal.message).toContain('React key is its own item')
  })

  it('paste lands a copy where the drop is among the list’s rows, and refuses anywhere else', () => {
    const t = tree()
    const here = planListRowCopyTo(t, [t.nodes[ROW(2)]!], MAIN, 2) // between row 0 and row 1
    expect(here?.ok && here.edit.op).toEqual({ kind: 'copy', from: [2], at: 1, key: { kind: 'field', field: 'id' } })
    expect(planListRowCopyTo(t, [t.nodes[ROW(2)]!], MAIN, 5)?.ok).toBe(false) // after the footer
    expect(planListRowCopyTo(t, [t.nodes[ROW(2)]!], 'root', 0)?.ok).toBe(false)
  })

  it('no row involved — every planner answers null', () => {
    const t = tree()
    const plain = t.nodes['src/Board.tsx:11:7']!
    expect(planListRowRemove([plain])).toBeNull()
    expect(planListRowCopy([plain])).toBeNull()
    expect(planListRowCopyTo(t, [plain], MAIN, 1)).toBeNull()
  })
})

describe('invertListItemEdit', () => {
  it('a reorder is undone by the inverse permutation, a copy by removing what it wrote', () => {
    const edit = { kind: 'list-item' as const, nodeId: ARRAY, length: 4 }
    expect(invertListItemEdit({ ...edit, op: { kind: 'reorder', order: [2, 0, 3, 1] } })?.op).toEqual({ kind: 'reorder', order: [1, 3, 0, 2] })
    expect(invertListItemEdit({ ...edit, op: { kind: 'copy', from: [0, 3], at: 4 } })).toEqual({
      ...edit,
      length: 6,
      op: { kind: 'remove', indices: [4, 5] },
    })
    expect(invertListItemEdit({ ...edit, op: { kind: 'remove', indices: [1] } })).toBeNull()
  })
})
