/**
 * G-9 — when "Unroll list" is offered (`planUnrollList`). Offered exactly when
 * the array is a literal written in the same file; every other list is
 * `refused` by the parser and gets no plan, so the menu never offers what the
 * codemod would refuse for that reason.
 */
import { describe, expect, it } from 'bun:test'
import { planUnrollList } from '../listRowUnroll'
import type { ListRowSource } from '../listRowSource'
import type { PageNode } from '../pageNode'
import type { NodeTree } from '../treeSchema'

const ARRAY = 'src/Menu.tsx:3:15'
const TEMPLATE = 'src/Menu.tsx:12:9'

function node(id: string, parentId: string | null, children: string[] = [], listRow?: ListRowSource): PageNode {
  return { id, moduleId: 'base.container', props: {}, breakpointOverrides: {}, children, classIds: [], parentId, ...(listRow ? { listRow } : {}) }
}

const arrayRow = (index: number): ListRowSource => ({ kind: 'array', array: ARRAY, index, length: 3, key: { kind: 'none' }, source: 'DISHES' })

/** root → ul → [li#0, li#1, li#2], each li → [span#k]; plus a plain footer. */
function tree(row: (index: number) => ListRowSource | undefined = arrayRow): NodeTree<PageNode> {
  const ul = 'src/Menu.tsx:10:5'
  const rows = [0, 1, 2].map((k) => `${TEMPLATE}#${k}`)
  const nodes: Record<string, PageNode> = {
    root: node('root', null, [ul]),
    [ul]: node(ul, 'root', [...rows, 'src/Menu.tsx:20:5']),
    'src/Menu.tsx:20:5': node('src/Menu.tsx:20:5', ul),
  }
  rows.forEach((id, k) => {
    const inner = `src/Menu.tsx:12:30#${k}`
    nodes[id] = node(id, ul, [inner], row(k))
    nodes[inner] = node(inner, id)
  })
  return { rootNodeId: 'root', nodes }
}

describe('planUnrollList', () => {
  it('names the template, the array and the rows in array order, from a row root', () => {
    const plan = planUnrollList(tree(), `${TEMPLATE}#1`)
    expect(plan).toEqual({
      edit: { kind: 'unroll-list', nodeId: TEMPLATE, array: ARRAY, length: 3 },
      rowRootIds: [`${TEMPLATE}#0`, `${TEMPLATE}#1`, `${TEMPLATE}#2`],
      source: 'DISHES',
    })
  })

  it('a node inside a row stands for its row', () => {
    expect(planUnrollList(tree(), 'src/Menu.tsx:12:30#2')?.edit.nodeId).toBe(TEMPLATE)
  })

  it('a node outside every list has nothing to unroll', () => {
    expect(planUnrollList(tree(), 'src/Menu.tsx:20:5')).toBeNull()
    expect(planUnrollList(tree(), 'src/Menu.tsx:99:1')).toBeNull()
  })

  it('a list whose array is not a literal in this file is not offered', () => {
    for (const reason of ['imported', 'computed', 'prop', 'spread', 'nested', 'multi-root'] as const) {
      expect(planUnrollList(tree(() => ({ kind: 'refused', reason, source: 'DISHES' })), `${TEMPLATE}#0`)).toBeNull()
    }
  })

  it('a list written in a shared component’s own file is not offered (its id is inlined)', () => {
    const inlined = `src/Page.tsx:7:3~${TEMPLATE}#0`
    const t: NodeTree<PageNode> = { rootNodeId: 'root', nodes: { root: node('root', null, [inlined]), [inlined]: node(inlined, 'root', [], arrayRow(0)) } }
    expect(planUnrollList(t, inlined)).toBeNull()
  })
})
