/**
 * K2 — `planSourceDuplicateTo`, the plan behind Alt+drag on a studio-imported
 * tree.
 *
 * The invariant worth a test file of its own: **Alt+drag refuses for exactly
 * the reasons the same drag WITHOUT Alt would refuse for.** A modifier that
 * quietly widens what Studio will write to a user's repository is the failure
 * mode this gesture could most easily ship, so the refusals are asserted by
 * name here rather than left to the two functions the plan composes.
 *
 * The COMMIT half matters too and is the one thing the plan does NOT inherit
 * from a move: a move resolves its anchor from the child list with the dragged
 * node removed, a copy removes nothing, so the anchor is resolved the way an
 * INSERT resolves one.
 */
import { describe, expect, it } from 'bun:test'
import type { NodeTree, PageNode } from '@core/page-tree'
import { makeNode } from '../../../../../../../__tests__/fixtures'
import { planSourceDuplicateTo } from '../structuralSourceEdits'
import '@modules/base/index'

const FILE = 'pages/Home.tsx'
const at = (line: number) => `${FILE}:${line}:5`

/**
 * A studio-imported page: a real `rel:line:col` root element with three
 * source-derived children, plus an empty container to copy INTO.
 */
function studioTree(): NodeTree<PageNode> {
  const root = at(3)
  const a = at(5)
  const b = at(6)
  const box = at(7)
  return {
    rootNodeId: root,
    nodes: {
      [root]: makeNode({ id: root, moduleId: 'base.container', children: [a, b, box] }),
      [a]: makeNode({ id: a, moduleId: 'base.text', parentId: root }),
      [b]: makeNode({ id: b, moduleId: 'base.text', parentId: root }),
      [box]: makeNode({ id: box, moduleId: 'base.container', parentId: root }),
    },
  }
}

describe('planSourceDuplicateTo — where the copy is written', () => {
  it('names the container and the sibling the copy lands beside', () => {
    const tree = studioTree()
    // Index 2 of [a, b, box] — the copy goes between `b` and `box`, which the
    // source is written as "after b". The anchor is resolved from the CURRENT
    // child list (an insert's question), not from the list with the dragged
    // node removed (a move's) — those differ by one whenever the drop is below
    // the element being copied, and a copy removes nothing.
    const plan = planSourceDuplicateTo(tree, [at(5)], at(3), 2)

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.commit).toEqual({
      nodeId: at(5),
      parentNodeId: at(3),
      anchorNodeId: at(6),
      position: 'after',
    })
  })

  it('appends into an empty container — a position with no anchor is still a position', () => {
    const tree = studioTree()
    const plan = planSourceDuplicateTo(tree, [at(5)], at(7), 0)

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.commit?.parentNodeId).toBe(at(7))
    expect(plan.commit?.anchorNodeId).toBeNull()
  })

  it('returns no commit for a tree with no source behind it — the caller takes its in-memory path', () => {
    const tree: NodeTree<PageNode> = {
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.container', children: ['a'] }),
        a: makeNode({ id: 'a', moduleId: 'base.text', parentId: 'root' }),
      },
    }
    const plan = planSourceDuplicateTo(tree, ['a'], 'root', 1)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.commit).toBeNull()
  })
})

describe('planSourceDuplicateTo — what it refuses', () => {
  it('refuses a multi-node Alt+drag, because N copies at one position have no order in the code', () => {
    const tree = studioTree()
    const plan = planSourceDuplicateTo(tree, [at(5), at(6)], at(7), 0)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.constraint.reason).toBe('multi-select')
    // The remedy has to be something the user can actually do.
    expect(plan.constraint.explanation).toContain('one by one')
  })

  it('refuses a `.map` row — the same reason ⌘D refuses it', () => {
    const tree = studioTree()
    const row = `${FILE}:5:5#2`
    tree.nodes[row] = makeNode({ id: row, moduleId: 'base.text', parentId: at(3) })
    tree.nodes[at(3)]!.children = [row, at(6), at(7)]

    const plan = planSourceDuplicateTo(tree, [row], at(7), 0)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.constraint.reason).toBe('list-row')
  })

  it('refuses a copy into a container in a different file — the same reason a reparent refuses it', () => {
    const tree = studioTree()
    const foreign = 'pages/Other.tsx:9:3'
    tree.nodes[foreign] = makeNode({ id: foreign, moduleId: 'base.container', parentId: at(3) })
    tree.nodes[at(3)]!.children = [at(5), at(6), foreign]

    const plan = planSourceDuplicateTo(tree, [at(5)], foreign, 0)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.constraint.reason).toBe('cross-file')
  })

  it('refuses a locked container, and says which one', () => {
    const tree = studioTree()
    tree.nodes[at(7)]!.lockReason = 'This element comes from a shared component'

    const plan = planSourceDuplicateTo(tree, [at(5)], at(7), 0)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.constraint.explanation.length).toBeGreaterThan(0)
  })

  it('is a silent no-op for a drop source that has already gone', () => {
    const tree = studioTree()
    const plan = planSourceDuplicateTo(tree, ['gone'], at(7), 0)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.commit).toBeNull()
  })
})
