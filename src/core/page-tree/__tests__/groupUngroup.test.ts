/**
 * K3 — the tree half of ⌘G / ⌘⇧G: `previewStructuralGroup`'s rule about WHICH
 * selections have one honest container, and `unwrapNode`'s canvas mutation.
 *
 * The refusals are the reason this file exists. Group is the first structural
 * write that spans several elements, so the rule it has to satisfy is not
 * "can this node be written" but "do these nodes name ONE span": a selection
 * with a gap, or one that crosses parents, would put the wrapper around
 * elements the user never selected. Both refuse as `multi-select` with the
 * same remedy, and a change that silently starts writing for either shape is
 * the regression this suite is here to catch.
 */
import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '../index'
import { previewStructuralGroup, reindexNodeParents, unwrapNode } from '../index'

function node(id: string, children: string[] = [], lockReason?: string): PageNode {
  return {
    id,
    moduleId: 'base.container',
    props: {},
    breakpointOverrides: {},
    children,
    locked: false,
    ...(lockReason ? { lockReason } : {}),
  }
}

function page(nodes: Record<string, PageNode>, rootNodeId = 'root'): Page {
  reindexNodeParents(nodes)
  return { id: 'page', slug: 'index', title: 'Home', rootNodeId, nodes }
}

const ROOT = 'pages/Home.tsx:10:4'
const A = 'pages/Home.tsx:20:6'
const B = 'pages/Home.tsx:22:6'
const C = 'pages/Home.tsx:24:6'
const NESTED = 'pages/Home.tsx:26:8'
const LIST_ROW = 'pages/Home.tsx:22:6#2'
const INLINED = 'pages/Home.tsx:22:6~ui/Icon.tsx:2:4'

/** `root → ROOT → [A, B, C]`, with `NESTED` living inside `C`. */
function board(overrides: Record<string, PageNode> = {}): Page {
  return page({
    root: node('root', [ROOT]),
    [ROOT]: node(ROOT, [A, B, C]),
    [A]: node(A),
    [B]: node(B),
    [C]: node(C, [NESTED]),
    [NESTED]: node(NESTED),
    ...overrides,
  })
}

describe('previewStructuralGroup', () => {
  it('commits a contiguous run in SOURCE order, whatever order it was selected in', () => {
    const result = previewStructuralGroup(board(), [C, A, B])
    expect(result).toEqual({ ok: true, commit: [A, B, C] })
  })

  it('commits a run of one — ⌘G on a single node is the wrap that already shipped', () => {
    expect(previewStructuralGroup(board(), [B])).toEqual({ ok: true, commit: [B] })
  })

  it('REFUSES a selection with a gap in it', () => {
    const result = previewStructuralGroup(board(), [A, C])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.reason).toBe('multi-select')
      expect(result.refusal.message).toContain('Select siblings next to each other')
    }
  })

  it('REFUSES a selection that crosses parents, however adjacent it looks', () => {
    const result = previewStructuralGroup(board(), [B, NESTED])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('multi-select')
  })

  it('REFUSES any member with no single honest target of its own', () => {
    const rowBoard = page({
      root: node('root', [ROOT]),
      [ROOT]: node(ROOT, [A, LIST_ROW, INLINED]),
      [A]: node(A),
      [LIST_ROW]: node(LIST_ROW),
      [INLINED]: node(INLINED),
    })
    expect(previewStructuralGroup(rowBoard, [A, LIST_ROW])).toMatchObject({
      ok: false,
      refusal: { reason: 'list-row' },
    })
    expect(previewStructuralGroup(rowBoard, [LIST_ROW, INLINED])).toMatchObject({
      ok: false,
      refusal: { reason: 'list-row' },
    })

    const locked = board({ [B]: node(B, [], 'rendered by a condition') })
    expect(previewStructuralGroup(locked, [A, B])).toMatchObject({
      ok: false,
      refusal: { reason: 'code-placed' },
    })
  })

  it('REFUSES a node with no parent to hold the wrapper', () => {
    // An orphan — present in the tree, in nobody's child list. `wrapJsxElements`
    // would have nowhere to write the container either (`no-jsx-parent`), but
    // this is the half that can be answered before a file is opened.
    const orphan = page({
      root: node('root', [ROOT]),
      [ROOT]: node(ROOT, [A]),
      [A]: node(A),
      [B]: node(B),
    })
    const result = previewStructuralGroup(orphan, [B])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('group')
  })

  it('leaves the page root ELEMENT to the codemod, the same way a single wrap does', () => {
    // The element a component returns has a parent on the CANVAS (the synthetic
    // page root), so the tree rule cannot see that it is the return value —
    // `wrapJsxElements` refuses it with `no-jsx-parent` at save time, exactly
    // as `wrapJsxElement` already does for ⌘G on one node.
    expect(previewStructuralGroup(board(), [ROOT])).toEqual({ ok: true, commit: [ROOT] })
  })

  it('leaves an ordinary CMS tree alone — no commit, no refusal', () => {
    const cms = page({
      root: node('root', ['V1StGXR8_Z5jdHi6B-myT', 'X2StGXR8_Z5jdHi6B-myT']),
      'V1StGXR8_Z5jdHi6B-myT': node('V1StGXR8_Z5jdHi6B-myT'),
      'X2StGXR8_Z5jdHi6B-myT': node('X2StGXR8_Z5jdHi6B-myT'),
    })
    expect(previewStructuralGroup(cms, ['V1StGXR8_Z5jdHi6B-myT', 'X2StGXR8_Z5jdHi6B-myT'])).toEqual({
      ok: true,
      commit: null,
    })
  })

  it('REFUSES a selection that mixes imported markup with a canvas-only node', () => {
    const mixed = page({
      root: node('root', [ROOT]),
      [ROOT]: node(ROOT, [A, 'V1StGXR8_Z5jdHi6B-myT']),
      [A]: node(A),
      'V1StGXR8_Z5jdHi6B-myT': node('V1StGXR8_Z5jdHi6B-myT'),
    })
    expect(previewStructuralGroup(mixed, [A, 'V1StGXR8_Z5jdHi6B-myT'])).toMatchObject({
      ok: false,
      refusal: { reason: 'group' },
    })
  })

  it('says nothing about an empty or unknown selection', () => {
    expect(previewStructuralGroup(board(), [])).toEqual({ ok: true, commit: null })
    expect(previewStructuralGroup(board(), ['gone'])).toEqual({ ok: true, commit: null })
  })
})

describe('unwrapNode', () => {
  it('hoists the children into the parent at the wrapper index, in order', () => {
    const tree = board()
    expect(unwrapNode(tree, C)).toBe(true)
    expect(tree.nodes[ROOT]!.children).toEqual([A, B, NESTED])
    expect(tree.nodes[NESTED]!.parentId).toBe(ROOT)
    expect(tree.nodes[C]).toBeUndefined()
  })

  it('removes a container with no children at all', () => {
    const tree = board()
    expect(unwrapNode(tree, B)).toBe(true)
    expect(tree.nodes[ROOT]!.children).toEqual([A, C])
    expect(tree.nodes[B]).toBeUndefined()
  })

  it('refuses the root and an unknown id without throwing at a keystroke', () => {
    const tree = board()
    expect(unwrapNode(tree, 'root')).toBe(false)
    expect(unwrapNode(tree, 'gone')).toBe(false)
    expect(tree.nodes[ROOT]!.children).toEqual([A, B, C])
  })
})
