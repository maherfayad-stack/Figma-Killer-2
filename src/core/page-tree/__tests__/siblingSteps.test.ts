/**
 * P2-C2 (OD-16) — a multi-selection stepped among its siblings as INDEPENDENT
 * single-element moves: what moves, where it lands, and what refuses.
 *
 * "Independent" is checked the only way that matters: applying the planned
 * moves one after another, in EITHER order, with their recorded indices, lands
 * the same child order — which is what lets a save batch apply them
 * bottom-to-top as one write.
 */
import { describe, expect, it } from 'bun:test'
import { moveNode } from '../mutations'
import { planSiblingSteps, type SiblingMove } from '../siblingSteps'
import { invertMoveSequence, topLevelSelection } from '../moveSequence'
import type { NodeTree } from '../treeSchema'
import type { PageNode } from '../pageNode'

function node(id: string, parentId: string | null, children: string[] = [], extra: Partial<PageNode> = {}): PageNode {
  return { id, moduleId: 'base.container', props: {}, breakpointOverrides: {}, children, classIds: [], parentId, ...extra }
}

/** root → [a, b, c, d, e, f]; b → [b1, b2, b3]. */
function tree(overrides: Record<string, Partial<PageNode>> = {}): NodeTree<PageNode> {
  const nodes: Record<string, PageNode> = {
    root: node('root', null, ['a', 'b', 'c', 'd', 'e', 'f']),
    b: node('b', 'root', ['b1', 'b2', 'b3']),
  }
  for (const id of ['a', 'c', 'd', 'e', 'f']) nodes[id] = node(id, 'root')
  for (const id of ['b1', 'b2', 'b3']) nodes[id] = node(id, 'b')
  for (const [id, patch] of Object.entries(overrides)) nodes[id] = { ...nodes[id]!, ...patch }
  return { rootNodeId: 'root', nodes }
}

function apply(t: NodeTree<PageNode>, moves: readonly SiblingMove[]): NodeTree<PageNode> {
  const copy = structuredClone(t)
  for (const move of moves) moveNode(copy, move.nodeId, move.parentId, move.index)
  return copy
}

function plan(t: NodeTree<PageNode>, ids: string[], stepOf: (parentId: string) => number | null) {
  const result = planSiblingSteps(t, ids, stepOf)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result.moves
}

const every = (step: number) => () => step

describe('planSiblingSteps', () => {
  it('a run of two steps one place as ONE move: the neighbour jumps over it', () => {
    const t = tree()
    const moves = plan(t, ['c', 'd'], every(1))
    expect(moves).toEqual([{ nodeId: 'e', parentId: 'root', index: 2 }])
    expect(apply(t, moves).nodes.root!.children).toEqual(['a', 'b', 'e', 'c', 'd', 'f'])
    expect(apply(t, plan(t, ['c', 'd'], every(-1))).nodes.root!.children).toEqual(['a', 'c', 'd', 'b', 'e', 'f'])
  })

  it('non-contiguous layers each step, keep their order, and the moves are independent', () => {
    const t = tree()
    const moves = plan(t, ['a', 'd'], every(1))
    expect(moves).toHaveLength(2)
    const expected = ['b', 'a', 'c', 'e', 'd', 'f']
    expect(apply(t, moves).nodes.root!.children).toEqual(expected)
    expect(apply(t, [...moves].reverse()).nodes.root!.children).toEqual(expected)
  })

  it('a run at the end stays; the others still move; nothing overtakes', () => {
    const t = tree()
    expect(apply(t, plan(t, ['d', 'f'], every(1))).nodes.root!.children).toEqual(['a', 'b', 'c', 'e', 'd', 'f'])
    expect(plan(t, ['e', 'f'], every(1))).toEqual([])
  })

  it('layers under different parents step together, each in its own parent', () => {
    const t = tree()
    const moves = plan(t, ['b1', 'e'], every(1))
    const after = apply(t, moves)
    expect(after.nodes.b!.children).toEqual(['b2', 'b1', 'b3'])
    expect(after.nodes.root!.children).toEqual(['a', 'b', 'c', 'd', 'f', 'e'])
  })

  it('a descendant of a selected layer rides with it', () => {
    expect(topLevelSelection(tree(), ['b', 'b2', 'root'])).toEqual(['b'])
  })

  it('a single layer steps a whole grid row; past the last row it does not move', () => {
    const t = tree()
    expect(apply(t, plan(t, ['a'], every(3))).nodes.root!.children).toEqual(['b', 'c', 'd', 'a', 'e', 'f'])
    expect(plan(t, ['e'], every(3))).toEqual([])
    expect(plan(t, ['b'], every(-3))).toEqual([])
  })

  it('refuses a grid-row step of two or more layers (multi-row)', () => {
    expect(planSiblingSteps(tree(), ['a', 'b'], every(3))).toEqual({ ok: false, reason: 'multi-row' })
    // Two single layers whose row steps cross the same siblings.
    expect(planSiblingSteps(tree(), ['a', 'c'], every(3))).toEqual({ ok: false, reason: 'multi-row' })
  })

  it('refuses when one move would carry another moving parent (nested)', () => {
    // `c` stepping back crosses `b`, and inside `b` the selected `b2` is
    // moving too: the first write would move the bytes the second targets.
    expect(planSiblingSteps(tree(), ['c', 'b2'], every(-1))).toEqual({ ok: false, reason: 'nested' })
  })

  it('refuses a selection holding a locked layer', () => {
    expect(planSiblingSteps(tree({ c: { locked: true } }), ['a', 'c'], every(1))).toEqual({ ok: false, reason: 'locked' })
  })

  it('a parent with no step (an arrow across its axis) moves nothing', () => {
    const t = tree()
    const moves = plan(t, ['b1', 'e'], (parentId) => (parentId === 'b' ? 1 : null))
    expect(moves).toEqual([{ nodeId: 'b1', parentId: 'b', index: 1 }])
  })

  it('the inverse batch restores the original order', () => {
    const t = tree()
    const moves = plan(t, ['a', 'c', 'd'], every(1))
    const back = apply(apply(t, moves), invertMoveSequence(t, moves))
    expect(back.nodes.root!.children).toEqual(t.nodes.root!.children)
  })
})
