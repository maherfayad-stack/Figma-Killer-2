import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { resolvePageTreeDropTarget, reindexNodeParents, moveNodes } from '@core/page-tree'

function node(id: string, moduleId: string, children: string[] = [], locked = false): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    locked,
  }
}

function page(nodes: Record<string, PageNode>, rootNodeId = 'root'): Page {
  reindexNodeParents(nodes)
  return {
    id: 'page',
    slug: 'index',
    title: 'Home',
    rootNodeId,
    nodes,
  }
}

const canHaveChildren = (moduleId: string) =>
  ['base.body', 'base.container', 'base.visual-component-ref', 'base.slot-instance'].includes(moduleId)

describe('resolvePageTreeDropTarget', () => {
  it('normalizes same-parent before and after targets around source removal', () => {
    const tree = page({
      root: node('root', 'base.body', ['a', 'b', 'c', 'd']),
      a: node('a', 'base.text'),
      b: node('b', 'base.text'),
      c: node('c', 'base.text'),
      d: node('d', 'base.text'),
    })

    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'a',
      overId: 'd',
      zone: 'after',
      canHaveChildren,
    })?.index).toBe(3)

    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'd',
      overId: 'a',
      zone: 'before',
      canHaveChildren,
    })?.index).toBe(0)
  })

  it('rejects illegal multi-drag targets for every dragged id', () => {
    const tree = page({
      root: node('root', 'base.body', ['container', 'target', 'locked']),
      container: node('container', 'base.container', ['child']),
      child: node('child', 'base.text'),
      target: node('target', 'base.container'),
      locked: node('locked', 'base.text', [], true),
    })

    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'container',
      draggedIds: ['container', 'locked'],
      overId: 'target',
      zone: 'inside',
      canHaveChildren,
    })).toBeNull()

    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'container',
      draggedIds: ['container', 'target'],
      overId: 'child',
      zone: 'inside',
      canHaveChildren,
    })).toBeNull()
  })

  it('normalizes the target index for a multi-drag by every dragged sibling removed before it (G10)', () => {
    // 8 same-parent siblings, indices 0-7. Drag the first three (a,b,c) to
    // "after f" (index 5, zone 'after' -> rawIndex 6). normalizeIndexAfterRemoval
    // must discount all THREE removed siblings that sit before rawIndex, not
    // just the pivot ('a') — moveNodes detaches the whole draggedIds set before
    // splicing (mutations.ts:580-587), so under-discounting lands the group
    // too far to the right.
    const tree = page({
      root: node('root', 'base.body', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
      a: node('a', 'base.text'),
      b: node('b', 'base.text'),
      c: node('c', 'base.text'),
      d: node('d', 'base.text'),
      e: node('e', 'base.text'),
      f: node('f', 'base.text'),
      g: node('g', 'base.text'),
      h: node('h', 'base.text'),
    })

    const target = resolvePageTreeDropTarget({
      tree,
      draggedId: 'a',
      draggedIds: ['a', 'b', 'c'],
      overId: 'f',
      zone: 'after',
      canHaveChildren,
    })
    expect(target).not.toBeNull()
    // Correct answer: after detaching a,b,c the remaining order is
    // [d,e,f,g,h]; "after f" is index 3 in that array.
    expect(target?.index).toBe(3)

    moveNodes(tree, target!.draggedIds, target!.parentId, target!.index)
    expect(tree.nodes.root.children).toEqual(['d', 'e', 'f', 'a', 'b', 'c', 'g', 'h'])
  })

  it('does not false-positive a real multi-drag as a no-op (companion to G10 — noOpTarget must simulate the whole group)', () => {
    // 4 same-parent siblings [a,b,c,d]. Drag the middle pair (b,c) to "after
    // d" (index 3, zone 'after' -> rawIndex 4). The CORRECTLY normalized
    // index (G10) happens to equal the pivot's ('c') own PRE-move index (2 in
    // the 4-item array) — a coincidence of these exact numbers, not a real
    // "nothing moved". `noOpTarget` used to compare only the pivot's own
    // index against the computed target index, which is only a valid "did
    // this change" test for a SINGLE-node drag; for n>1 it compares indices
    // into arrays of different lengths and can accidentally cancel a real,
    // order-changing move. Regression for the false `null` this produced.
    const tree = page({
      root: node('root', 'base.body', ['a', 'b', 'c', 'd']),
      a: node('a', 'base.text'),
      b: node('b', 'base.text'),
      c: node('c', 'base.text'),
      d: node('d', 'base.text'),
    })

    const target = resolvePageTreeDropTarget({
      tree,
      draggedId: 'c',
      draggedIds: ['b', 'c'],
      overId: 'd',
      zone: 'after',
      canHaveChildren,
    })
    expect(target).not.toBeNull()
    expect(target?.index).toBe(2)

    moveNodes(tree, target!.draggedIds, target!.parentId, target!.index)
    expect(tree.nodes.root.children).toEqual(['a', 'd', 'b', 'c'])
  })

  it('still recognises a genuine multi-drag no-op (dropping the group back where it already was)', () => {
    const tree = page({
      root: node('root', 'base.body', ['a', 'b', 'c', 'd']),
      a: node('a', 'base.text'),
      b: node('b', 'base.text'),
      c: node('c', 'base.text'),
      d: node('d', 'base.text'),
    })

    // a,b dropped "before c" — already immediately before c, so this is a
    // true no-op: the resulting child order is byte-identical.
    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'a',
      draggedIds: ['a', 'b'],
      overId: 'c',
      zone: 'before',
      canHaveChildren,
    })).toBeNull()
  })

  it('allows user content inside slot instances while rejecting direct visual-component-ref children', () => {
    const tree = page({
      root: node('root', 'base.body', ['vcRef', 'outsideText']),
      vcRef: node('vcRef', 'base.visual-component-ref', ['slot']),
      slot: node('slot', 'base.slot-instance', [], true),
      outsideText: node('outsideText', 'base.text'),
    })

    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'outsideText',
      overId: 'slot',
      zone: 'inside',
      canHaveChildren,
    })?.parentId).toBe('slot')

    expect(resolvePageTreeDropTarget({
      tree,
      draggedId: 'outsideText',
      overId: 'vcRef',
      zone: 'inside',
      canHaveChildren,
    })).toBeNull()
  })
})
