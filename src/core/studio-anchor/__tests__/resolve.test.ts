/**
 * The five anchor confidences, driven off a real tree shape.
 *
 * These are the tests that matter most in anything that points at an element
 * across a re-parse: every one of them describes a way a stored reference could
 * end up naming the WRONG element in a user's source file. Both consumers —
 * review comments and prototype links — refuse on the outcomes asserted here as
 * un-actionable.
 */
import { describe, it, expect } from 'bun:test'
import type { BaseNode, NodeTree } from '@core/page-tree'
import {
  captureNodeHint,
  indexPathForNode,
  nodeAtIndexPath,
  nodeTextSnippet,
  resolveNodeAnchor,
} from '../resolve'
import { TEXT_SNIPPET_MAX, type NodeHint } from '../types'

function node(id: string, moduleId: string, children: string[] = [], props: Record<string, unknown> = {}): BaseNode {
  return { id, moduleId, props, breakpointOverrides: {}, children }
}

/**
 * root
 *  ├─ header            (base.container)
 *  │   └─ title         (base.text, "Get started")
 *  └─ body              (base.container)
 *      ├─ lede          (base.text, "Ship faster")
 *      └─ cta           (base.button)
 */
function tree(overrides: Record<string, BaseNode> = {}): NodeTree {
  const nodes: Record<string, BaseNode> = {
    root: node('root', 'base.body', ['header', 'body']),
    header: node('header', 'base.container', ['title']),
    title: node('title', 'base.text', [], { text: 'Get started' }),
    body: node('body', 'base.container', ['lede', 'cta']),
    lede: node('lede', 'base.text', [], { text: 'Ship faster' }),
    cta: node('cta', 'base.button', [], { label: 'Go' }),
    ...overrides,
  }
  return { nodes, rootNodeId: 'root' }
}

describe('indexPathForNode / nodeAtIndexPath', () => {
  it('round-trips every node in the tree', () => {
    const t = tree()
    for (const id of Object.keys(t.nodes)) {
      const path = indexPathForNode(t, id)
      expect(path).not.toBeNull()
      expect(nodeAtIndexPath(t, path!)?.id).toBe(id)
    }
  })

  it('gives the root an empty path', () => {
    expect(indexPathForNode(tree(), 'root')).toEqual([])
  })

  it('returns null for a node that is not in the tree', () => {
    expect(indexPathForNode(tree(), 'nope')).toBeNull()
  })

  it('returns undefined when a path runs off the end', () => {
    expect(nodeAtIndexPath(tree(), [1, 9])).toBeUndefined()
  })
})

describe('nodeTextSnippet', () => {
  it('reads props.text and props.children alike', () => {
    expect(nodeTextSnippet(node('a', 'base.text', [], { text: 'hello' }))).toBe('hello')
    expect(nodeTextSnippet(node('a', 'base.text', [], { children: 'hello' }))).toBe('hello')
  })

  it('collapses whitespace so a reformat does not read as an edit', () => {
    // A prettier run that moves a string onto its own line changes the raw
    // value but not the content. That must not downgrade an anchor to
    // `drifted` — the whole point of the snippet is to detect real edits.
    expect(nodeTextSnippet(node('a', 'base.text', [], { text: '  Get\n  started  ' }))).toBe('Get started')
  })

  it('is empty for a node with no text, which is what lets non-text nodes match', () => {
    expect(nodeTextSnippet(node('a', 'base.container'))).toBe('')
    expect(nodeTextSnippet(node('a', 'base.text', [], { text: 42 }))).toBe('')
    expect(nodeTextSnippet(undefined)).toBe('')
  })

  it('truncates to the stored maximum', () => {
    const long = 'x'.repeat(TEXT_SNIPPET_MAX + 50)
    expect(nodeTextSnippet(node('a', 'base.text', [], { text: long })).length).toBe(TEXT_SNIPPET_MAX)
  })
})

describe('resolveNodeAnchor', () => {
  it('exact — the stored id still resolves', () => {
    const t = tree()
    const hint = captureNodeHint(t, 'title')!
    expect(resolveNodeAnchor(hint, t)).toEqual({ confidence: 'exact', nodeId: 'title' })
  })

  it('moved — the id went stale but the structure and text still match', () => {
    // This is what a source edit ABOVE the node looks like: node ids are
    // `file:line:col`, so inserting a line renames every id below it while
    // changing nothing about the tree's shape.
    const before = tree()
    const hint = captureNodeHint(before, 'title')!

    const after = tree({
      header: node('header', 'base.container', ['title@newline']),
      'title@newline': node('title@newline', 'base.text', [], { text: 'Get started' }),
    })
    delete after.nodes.title

    expect(resolveNodeAnchor(hint, after)).toEqual({ confidence: 'moved', nodeId: 'title@newline' })
  })

  it('drifted — same place, same module, different text', () => {
    const before = tree()
    const hint = captureNodeHint(before, 'title')!

    const after = tree({
      header: node('header', 'base.container', ['title@newline']),
      'title@newline': node('title@newline', 'base.text', [], { text: 'Begin here' }),
    })
    delete after.nodes.title

    expect(resolveNodeAnchor(hint, after)).toEqual({ confidence: 'drifted', nodeId: 'title@newline' })
  })

  it('detached — a different KIND of node took the same address', () => {
    // Without the moduleId check, deleting the heading and dropping a button
    // in its place would silently inherit the heading's comment thread.
    const before = tree()
    const hint = captureNodeHint(before, 'title')!

    const after = tree({
      header: node('header', 'base.container', ['swapped']),
      swapped: node('swapped', 'base.button', [], { label: 'Get started' }),
    })
    delete after.nodes.title

    expect(resolveNodeAnchor(hint, after)).toEqual({ confidence: 'detached', nodeId: null })
  })

  it('detached — the element is gone entirely', () => {
    const before = tree()
    const hint = captureNodeHint(before, 'cta')!

    const after = tree({ body: node('body', 'base.container', ['lede']) })
    delete after.nodes.cta

    expect(resolveNodeAnchor(hint, after).confidence).toBe('detached')
  })

  it('unanchored — a pin dropped on empty canvas, which is NOT the same as detached', () => {
    // The distinction is load-bearing, not cosmetic. Collapsing these two made
    // every free-floating comment permanently un-resolvable by the agent (the
    // gate refuses `detached`) and made every one of them wear a stale badge
    // it had not earned. That the gate PASSES `unanchored` is asserted in
    // `@core/studio-comments`'s `agentGate.test.ts` — this file only has to
    // keep the two confidences distinct.
    expect(resolveNodeAnchor(null, tree())).toEqual({ confidence: 'unanchored', nodeId: null })
  })

  it('detached — no tree at all (page not loaded)', () => {
    const hint = captureNodeHint(tree(), 'title')!
    expect(resolveNodeAnchor(hint, null).confidence).toBe('detached')
  })

  it('prefers the live id over the index path when both would resolve', () => {
    // A tree where the stored id EXISTS but its index path now points at a
    // different node. The id wins: it is the stronger claim, and re-walking
    // would move a pin that never moved.
    const t = tree({
      header: node('header', 'base.container', ['lede2', 'title']),
      lede2: node('lede2', 'base.text', [], { text: 'Inserted above' }),
    })
    const hint: NodeHint = {
      nodeId: 'title',
      indexPath: [0, 0], // now resolves to `lede2`, not `title`
      moduleId: 'base.text',
      textSnippet: 'Get started',
    }
    expect(resolveNodeAnchor(hint, t)).toEqual({ confidence: 'exact', nodeId: 'title' })
  })
})


describe('captureNodeHint', () => {
  it('captures everything the resolver needs', () => {
    expect(captureNodeHint(tree(), 'lede')).toEqual({
      nodeId: 'lede',
      indexPath: [1, 0],
      moduleId: 'base.text',
      textSnippet: 'Ship faster',
    })
  })

  it('returns null for a node outside the tree — a coordinate-only pin', () => {
    expect(captureNodeHint(tree(), 'nope')).toBeNull()
  })
})
