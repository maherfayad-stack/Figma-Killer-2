/**
 * D2 G3 — `planSourceTransplant`, the plan behind a drag that crossed a board
 * frame boundary.
 *
 * Two things are asserted here that `previewStructuralTransplant`'s own suite
 * cannot: the refusal is DRESSED as an `EditConstraint` (so the refusal dialog
 * has a sentence, a reason and — where the reason has one — a remedy the user
 * can press), and the constraint is dressed against the right NODE, which for
 * this gesture may be either end. A refusal about the CONTAINER dressed against
 * the moved element would send "show me" to the wrong file.
 */
import { describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { makeNode } from '../../../../../../../__tests__/fixtures'
import { planSourceTransplant } from '../structuralSourceEdits'
import '@modules/base/index'

const HOME = 'pages/Home.tsx'
const ABOUT = 'pages/About.tsx'
const at = (file: string, line: number) => `${file}:${line}:5`

/** `<main>` with two source-derived children and one `.map` row. */
function homeTree(): NodeTree<PageNode> {
  const root = at(HOME, 3)
  const a = at(HOME, 5)
  const b = at(HOME, 6)
  const row = `${HOME}:8:5#2`
  return {
    rootNodeId: root,
    nodes: {
      [root]: makeNode({ id: root, moduleId: 'base.container', children: [a, b, row] }),
      [a]: makeNode({ id: a, moduleId: 'base.text', parentId: root }),
      [b]: makeNode({ id: b, moduleId: 'base.text', parentId: root }),
      [row]: makeNode({ id: row, moduleId: 'base.text', parentId: root }),
    },
  }
}

/** A second page: `<main>` with one heading. */
function aboutTree(): NodeTree<PageNode> {
  const root = at(ABOUT, 3)
  const h1 = at(ABOUT, 4)
  return {
    rootNodeId: root,
    nodes: {
      [root]: makeNode({ id: root, moduleId: 'base.container', children: [h1] }),
      [h1]: makeNode({ id: h1, moduleId: 'base.text', parentId: root }),
    },
  }
}

describe('planSourceTransplant — what it commits', () => {
  it('names the destination container, the neighbour, and whether it is a copy', () => {
    const plan = planSourceTransplant(homeTree(), [at(HOME, 5)], aboutTree(), at(ABOUT, 3), 0, false)

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.commit).toEqual({
      nodeId: at(HOME, 5),
      destinationParentNodeId: at(ABOUT, 3),
      anchorNodeId: at(ABOUT, 4),
      position: 'before',
      copy: false,
    })
  })

  it('carries the copy flag — Alt across frames plans through the same rule', () => {
    const plan = planSourceTransplant(homeTree(), [at(HOME, 5)], aboutTree(), at(ABOUT, 3), 0, true)

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.commit?.copy).toBe(true)
  })
})

describe('planSourceTransplant — refusals arrive dressed', () => {
  it('dresses a `.map` row refusal against the MOVED element file', () => {
    const plan = planSourceTransplant(homeTree(), [`${HOME}:8:5#2`], aboutTree(), at(ABOUT, 3), 0, false)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('list-row')
    expect(plan.nodeId).toBe(`${HOME}:8:5#2`)
    // A `list-row` is one of the reasons with a real remedy, so the dialog
    // path (not the toast path) is what the user gets.
    expect(plan.constraint.actions.length).toBeGreaterThan(0)
  })

  it('dresses a container refusal against the CONTAINER, which lives in the other tree', () => {
    const destination = aboutTree()
    const rowContainer = `${ABOUT}:9:5#1`
    destination.nodes[rowContainer] = makeNode({
      id: rowContainer,
      moduleId: 'base.container',
      parentId: at(ABOUT, 3),
    })
    destination.nodes[at(ABOUT, 3)]!.children.push(rowContainer)

    const plan = planSourceTransplant(homeTree(), [at(HOME, 5)], destination, rowContainer, 0, false)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('list-row')
    // The node the "show me" button jumps to is the CONTAINER, in About.tsx —
    // resolving it only against the origin tree would have found nothing.
    expect(plan.nodeId).toBe(rowContainer)
  })

  it('refuses more than one element with a sentence the user can act on', () => {
    const plan = planSourceTransplant(
      homeTree(),
      [at(HOME, 5), at(HOME, 6)],
      aboutTree(),
      at(ABOUT, 3),
      0,
      false,
    )

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('multi-select')
    expect(plan.constraint.explanation).toContain('one by one')
  })

  it('refuses two frames of the SAME page rather than planning a cross-file write against one file', () => {
    const plan = planSourceTransplant(homeTree(), [at(HOME, 5)], homeTree(), at(HOME, 3), 0, false)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('reparent')
  })
})
