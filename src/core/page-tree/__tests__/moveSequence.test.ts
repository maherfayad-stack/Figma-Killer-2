/**
 * P3-D — `planMoveSequence` / `invertMoveSequence`: a multi-element move as
 * single-element moves applied IN ORDER, and its exact inverse. Plus the two
 * `previewStructuralMove` answers P3-D added: a `.map` list's edge as an
 * anchor (WB-22), and a reparent into another file as a transplant (ERR-16).
 */
import { describe, expect, it } from 'bun:test'
import { moveNode, moveNodes } from '../mutations'
import { invertMoveSequence, planMoveSequence, type SequencedMove } from '../moveSequence'
import { previewStructuralMove } from '../sourceStructurePreview'
import type { NodeTree } from '../treeSchema'
import type { PageNode } from '../pageNode'

function node(id: string, parentId: string | null, children: string[] = []): PageNode {
  return { id, moduleId: 'base.container', props: {}, breakpointOverrides: {}, children, classIds: [], parentId }
}

/** root → [a, b, c, d, e]; c → [c1, c2]; x → [] (a second parent). */
function tree(): NodeTree<PageNode> {
  const nodes: Record<string, PageNode> = {
    root: node('root', null, ['a', 'b', 'c', 'd', 'e', 'x']),
    c: node('c', 'root', ['c1', 'c2']),
    x: node('x', 'root', []),
  }
  for (const id of ['a', 'b', 'd', 'e']) nodes[id] = node(id, 'root')
  for (const id of ['c1', 'c2']) nodes[id] = node(id, 'c')
  return { rootNodeId: 'root', nodes }
}

function apply(t: NodeTree<PageNode>, moves: readonly SequencedMove[]): NodeTree<PageNode> {
  const copy = structuredClone(t)
  for (const move of moves) moveNode(copy, move.nodeId, move.parentId, move.index)
  return copy
}

function viaMoveNodes(t: NodeTree<PageNode>, ids: string[], parentId: string, index: number): NodeTree<PageNode> {
  const copy = structuredClone(t)
  moveNodes(copy, ids, parentId, index)
  return copy
}

describe('planMoveSequence', () => {
  const cases: [string, string[], string, number][] = [
    ['two separated siblings to the end', ['a', 'd'], 'root', 4],
    ['two separated siblings to the start', ['d', 'b'], 'root', 0],
    ['into another parent, from two parents', ['c1', 'e'], 'x', 0],
    ['into a parent between its children', ['a', 'b'], 'c', 1],
  ]
  for (const [name, ids, parentId, index] of cases) {
    it(`lands exactly where moveNodes does: ${name}`, () => {
      const t = tree()
      const moves = planMoveSequence(t, ids, parentId, index)
      expect(moves).toHaveLength(ids.length)
      const sequenced = apply(t, moves)
      const direct = viaMoveNodes(t, ids, parentId, index)
      for (const id of Object.keys(t.nodes)) expect(sequenced.nodes[id]!.children).toEqual(direct.nodes[id]!.children)
    })

    it(`is undone exactly by its inverse: ${name}`, () => {
      const t = tree()
      const moves = planMoveSequence(t, ids, parentId, index)
      const back = apply(apply(t, moves), invertMoveSequence(t, moves))
      for (const id of Object.keys(t.nodes)) expect(back.nodes[id]!.children).toEqual(t.nodes[id]!.children)
    })
  }

  it('anchors every step after the one it follows — the first after an element that never moves', () => {
    const moves = planMoveSequence(tree(), ['a', 'd'], 'root', 4)
    // Children staying: [b, c, e, x]; index 4 follows `x`.
    const after = apply(tree(), moves).nodes.root!.children
    expect(after).toEqual(['b', 'c', 'e', 'x', 'a', 'd'])
  })

  it('does not touch the caller’s tree', () => {
    const t = tree()
    const before = structuredClone(t)
    planMoveSequence(t, ['a', 'd'], 'root', 4)
    invertMoveSequence(t, [{ nodeId: 'a', parentId: 'x', index: 0 }])
    expect(t).toEqual(before)
  })
})

describe('previewStructuralMove — P3-D answers', () => {
  const FILE = 'pages/Home.tsx'
  const at = (line: number, file = FILE) => `${file}:${line}:5`

  function studio(children: string[]): NodeTree<PageNode> {
    const root = at(1)
    const nodes: Record<string, PageNode> = { [root]: node(root, null, children) }
    for (const id of children) nodes[id] = node(id, root)
    return { rootNodeId: root, nodes }
  }

  it('WB-22 — lands after a .map list by naming the list, when the drop is past its last row', () => {
    const rows = [`${at(4)}#0`, `${at(4)}#1`]
    const t = studio([at(2), ...rows])
    // Move the header to just after the last row — the list ends the parent,
    // so there is no plain element on the far side to name instead.
    const preview = previewStructuralMove(t, [at(2)], at(1), 2)
    expect(preview).toEqual({ ok: true, commit: { nodeId: at(2), anchorNodeId: at(4), position: 'after' } })
  })

  it('WB-22 — between two rows of one list there is still no place to write it', () => {
    const rows = [`${at(4)}#0`, `${at(4)}#1`, `${at(4)}#2`]
    const t = studio([...rows, at(8)])
    const preview = previewStructuralMove(t, [at(8)], at(1), 1)
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.refusal.reason).toBe('no-sibling-anchor')
  })

  it('WB-22 — landing last with no writable neighbour appends to its own parent', () => {
    const t = studio([at(2), `${at(4)}#0`])
    t.nodes[`${at(4)}#0`]!.lockReason = undefined
    // Neighbour is a row of an inlined component list — not writable, not a plain list edge.
    const inlined = `${at(6)}~ui/Row.tsx:3:5`
    t.nodes[at(1)]!.children = [at(2), inlined]
    t.nodes[inlined] = node(inlined, at(1))
    const preview = previewStructuralMove(t, [at(2)], at(1), 1)
    expect(preview).toEqual({
      ok: true,
      commit: { nodeId: at(2), destinationParentNodeId: at(1), anchorNodeId: null, position: 'after' },
    })
  })

  it('ERR-16 — a reparent into a container written in another file is a transplant, not a refusal', () => {
    const foreign = at(9, 'pages/Other.tsx')
    const t = studio([at(2), foreign])
    const preview = previewStructuralMove(t, [at(2)], foreign, 0)
    expect(preview).toEqual({
      ok: true,
      commit: { nodeId: at(2), crossFile: true, destinationParentNodeId: foreign, anchorNodeId: null, position: 'after' },
    })
  })
})
