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

/**
 * The "Duplicate into frame instead" remedy, from both sides.
 *
 * It exists because the commonest cross-frame refusal on a real imported
 * project - markup that belongs to a shared component or to a layout file -
 * says the move "would apply to every place that component is used", which is
 * true of a move and false of a copy. The button is therefore not a
 * consolation prize; it is the one gesture that does what the user asked
 * without the consequence they were warned about.
 *
 * The property pinned here is that it is offered ONLY when it would work.
 * `planSourceTransplant` establishes that by re-asking the same rule with
 * `copy: true` - so a refusal a copy shares must NOT carry the action, or the
 * button would lead straight back to the sentence it was offered under.
 */
describe('planSourceTransplant - the copy remedy is offered only when it would land', () => {
  const inlined = `${HOME}:5:5~ui/Badge.tsx:2:3`

  function homeWithInlined(): NodeTree<PageNode> {
    const tree = homeTree()
    tree.nodes[inlined] = makeNode({ id: inlined, moduleId: 'base.text', parentId: tree.rootNodeId })
    tree.nodes[tree.rootNodeId]!.children.push(inlined)
    return tree
  }

  it('offers it on a shared-component refusal, where a copy touches nobody else', () => {
    const plan = planSourceTransplant(homeWithInlined(), [inlined], aboutTree(), at(ABOUT, 3), 0, false)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('shared-component')
    const remedy = plan.constraint.actions.find((action) => action.kind === 'duplicate-into-frame')
    expect(remedy?.label).toBe('Duplicate into frame instead')
  })

  it('does NOT offer it on a `.map` row, which a copy cannot read either', () => {
    const plan = planSourceTransplant(homeTree(), [`${HOME}:8:5#2`], aboutTree(), at(ABOUT, 3), 0, false)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.actions.some((action) => action.kind === 'duplicate-into-frame')).toBe(false)
  })

  it('does NOT offer it to a gesture that was ALREADY a copy', () => {
    const plan = planSourceTransplant(homeTree(), [`${HOME}:8:5#2`], aboutTree(), at(ABOUT, 3), 0, true)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.actions.some((action) => action.kind === 'duplicate-into-frame')).toBe(false)
  })
})
