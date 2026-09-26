/**
 * P5-F / IX-22 — a free move of a multi-selection.
 *
 * K6 planned a free move per `draggedId`: with two absolute layers selected,
 * only the one under the pointer moved. Now every dragged layer is a member
 * of one plan, all move by the SAME snapped delta (so the arrangement is
 * kept), the snap runs on the union box against the peers that are NOT
 * moving, and the commit is one patch per member.
 *
 * happy-dom has no layout: every rect comes from the candidate list, every
 * computed style from inline CSS.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { makeNode, makePage } from '../fixtures'
import {
  freeMoveStylePatches,
  resolveFreeMove,
  stepFreeMove,
} from '@site/canvas/canvasFreeMove'
import { DEFAULT_SNAP_PREFERENCES } from '@site/canvas/snapPreferences'
import type { CanvasDropCandidate } from '@site/canvas/canvasDnd'
import '@modules/base/index'

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function candidate(nodeId: string, depth: number, r: ReturnType<typeof rect>): CanvasDropCandidate {
  return { nodeId, depth, axis: 'vertical', rect: r }
}

/**
 * `stage` (relative, 400 × 300) holds `a` and `b` (absolute), `c` (absolute,
 * the one that stays put), and `flow` (in flow). `a` has a child `inner`.
 */
function seed() {
  const tree = makePage({
    id: 'home',
    rootNodeId: 'stage',
    nodes: {
      stage: makeNode({ id: 'stage', moduleId: 'base.container', children: ['a', 'b', 'c', 'flow'] }),
      a: makeNode({ id: 'a', moduleId: 'base.container', parentId: 'stage', children: ['inner'] }),
      inner: makeNode({ id: 'inner', moduleId: 'base.container', parentId: 'a' }),
      b: makeNode({ id: 'b', moduleId: 'base.container', parentId: 'stage' }),
      c: makeNode({ id: 'c', moduleId: 'base.container', parentId: 'stage' }),
      flow: makeNode({ id: 'flow', moduleId: 'base.container', parentId: 'stage' }),
    },
  })
  const el = (id: string, style: string, parent: HTMLElement = document.body) => {
    const node = document.createElement('div')
    node.setAttribute('data-node-id', id)
    node.setAttribute('style', style)
    parent.appendChild(node)
    return node
  }
  const stage = el('stage', 'position: relative')
  const a = el('a', 'position: absolute; left: 10px; top: 10px', stage)
  el('inner', 'position: absolute; left: 0px; top: 0px', a)
  el('b', 'position: absolute; left: 100px; top: 10px', stage)
  el('c', 'position: absolute; left: 300px; top: 200px', stage)
  el('flow', '', stage)
  const candidates = [
    candidate('stage', 0, rect(0, 0, 400, 300)),
    candidate('a', 1, rect(10, 10, 50, 40)),
    candidate('inner', 2, rect(10, 10, 20, 20)),
    candidate('b', 1, rect(100, 10, 50, 40)),
    candidate('c', 1, rect(300, 200, 50, 40)),
    candidate('flow', 1, rect(0, 280, 400, 20)),
  ]
  return { tree, candidates }
}

function resolve(nodeIds: string[], modifierHeld = false) {
  const { tree, candidates } = seed()
  return resolveFreeMove({
    doc: document,
    tree,
    nodeIds,
    candidates,
    modifierHeld,
    guideLines: [],
    preferences: DEFAULT_SNAP_PREFERENCES,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('IX-22 — two absolute layers move together', () => {
  it('plans both, on the union of their boxes', () => {
    const resolution = resolve(['a', 'b'])
    if (!resolution?.ok) throw new Error('expected a free move')
    expect(resolution.plan.members.map((member) => member.nodeId)).toEqual(['a', 'b'])
    expect(resolution.plan.rect).toEqual({ x: 10, y: 10, width: 140, height: 40 })
  })

  it('writes one patch per layer, both moved by the same delta', () => {
    const resolution = resolve(['a', 'b'])
    if (!resolution?.ok) throw new Error('expected a free move')
    const step = stepFreeMove(resolution.plan, 25, 33, 1)
    expect(freeMoveStylePatches(resolution.plan, step)).toEqual([
      { nodeId: 'a', patch: { left: '35px', top: '43px' } },
      { nodeId: 'b', patch: { left: '125px', top: '43px' } },
    ])
  })

  it('a moving layer is never its partner\'s snap peer; a still one is', () => {
    const resolution = resolve(['a', 'b'])
    if (!resolution?.ok) throw new Error('expected a free move')
    const peers = resolution.plan.peers
    expect(peers).toContainEqual({ x: 300, y: 200, width: 50, height: 40 })
    expect(peers).not.toContainEqual({ x: 100, y: 10, width: 50, height: 40 })
    expect(peers).not.toContainEqual({ x: 10, y: 10, width: 50, height: 40 })
  })

  it('the union box snaps: its right edge lands on the still layer', () => {
    const resolution = resolve(['a', 'b'])
    if (!resolution?.ok) throw new Error('expected a free move')
    // Union right edge 150 + 147 = 297, three px from c's left edge at 300.
    const step = stepFreeMove(resolution.plan, 147, 100, 1)
    expect(step.dx).toBe(150)
  })

  it('a layer inside another member moves with it, not twice', () => {
    const resolution = resolve(['a', 'inner', 'b'])
    if (!resolution?.ok) throw new Error('expected a free move')
    expect(resolution.plan.members.map((member) => member.nodeId)).toEqual(['a', 'b'])
  })
})

describe('IX-22 — all or nothing', () => {
  it('a flow layer in the selection makes the gesture a reorder', () => {
    expect(resolve(['a', 'flow'])).toBeNull()
  })

  it('with the modifier held, the flow layer becomes absolute with the others', () => {
    const resolution = resolve(['a', 'flow'], true)
    if (!resolution?.ok) throw new Error('expected a free move')
    expect(resolution.plan.members.map((member) => [member.nodeId, member.needsAbsolute])).toEqual([
      ['a', false],
      ['flow', true],
    ])
  })
})
