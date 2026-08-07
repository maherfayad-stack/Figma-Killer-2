/**
 * `refuseStructuralEdit` — the rule that decides whether a move or a delete on
 * the board has one honest target in the user's source, plus the id grammar it
 * rests on.
 *
 * The property that matters most is the FIRST one: a CMS node must be
 * completely unaffected. These rules are consulted by the same store actions
 * the ordinary database-backed editor uses, and narrowing what that editor can
 * do would be a regression far larger than the feature.
 */
import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '../index'
import {
  isRouteChromeNodeId,
  isSourceDerivedNodeId,
  isStudioPageRootId,
  previewStructuralMove,
  reindexNodeParents,
  refuseMintedNodeInsert,
  refuseStructuralEdit,
} from '../index'

const PLAIN = 'pages/Home.tsx:12:6'
const SIBLING = 'pages/Home.tsx:14:6'
const LIST_ROW = 'pages/Home.tsx:12:6#3'
const INLINED = 'pages/Home.tsx:12:6~ui/Icon.tsx:2:4'

describe('studio node id grammar', () => {
  it('recognises the ids the importer mints and nothing else', () => {
    expect(isSourceDerivedNodeId(PLAIN)).toBe(true)
    expect(isSourceDerivedNodeId('pages/Home.tsx:12:6#2')).toBe(true)
    expect(isSourceDerivedNodeId('pages/Home.tsx:12:6#1#0')).toBe(true)
    expect(isSourceDerivedNodeId('pages/Home.tsx:12:6~components/Icon.tsx:3:4')).toBe(true)

    // A CMS nanoid and the synthetic page root are not source locations.
    expect(isSourceDerivedNodeId('V1StGXR8_Z5jdHi6B-myT')).toBe(false)
    expect(isSourceDerivedNodeId('home:body')).toBe(false)
  })

  it('recognises the synthetic page root without mistaking a nanoid for one', () => {
    expect(isStudioPageRootId('home:body')).toBe(true)
    expect(isStudioPageRootId('V1StGXR8_Z5jdHi6B-myT')).toBe(false)
  })

  it('flags route chrome by filename, at any App Router depth', () => {
    expect(isRouteChromeNodeId('app/layout.tsx:3:4')).toBe(true)
    expect(isRouteChromeNodeId('app/(marketing)/blog/template.jsx:9:2')).toBe(true)
    expect(isRouteChromeNodeId('app/layouts/Hero.tsx:3:4')).toBe(false)
  })
})

describe('refuseStructuralEdit', () => {
  it('never narrows an ordinary CMS node', () => {
    const node = { id: 'V1StGXR8_Z5jdHi6B-myT' }
    for (const kind of ['reorder', 'reparent', 'delete', 'insert', 'duplicate', 'wrap'] as const) {
      expect(refuseStructuralEdit({ kind, node, anchor: node })).toBeNull()
    }
  })

  it('allows a plain sibling reorder and a plain delete', () => {
    expect(
      refuseStructuralEdit({ kind: 'reorder', node: { id: PLAIN }, anchor: { id: SIBLING } }),
    ).toBeNull()
    expect(refuseStructuralEdit({ kind: 'delete', node: { id: PLAIN } })).toBeNull()
  })

  it('refuses a `.map` row, its anchor, and anything inlined or shared', () => {
    expect(refuseStructuralEdit({ kind: 'delete', node: { id: 'pages/Home.tsx:12:6#3' } })?.reason).toBe('list-row')
    expect(
      refuseStructuralEdit({ kind: 'delete', node: { id: 'pages/Home.tsx:12:6~ui/Icon.tsx:2:4' } })?.reason,
    ).toBe('shared-component')
    expect(refuseStructuralEdit({ kind: 'delete', node: { id: 'app/layout.tsx:5:4' } })?.reason).toBe('route-chrome')
    expect(
      refuseStructuralEdit({ kind: 'reorder', node: { id: PLAIN }, anchor: { id: 'pages/Home.tsx:14:6#1' } })?.reason,
    ).toBe('no-sibling-anchor')
  })

  it('refuses a node the code decides the position of, quoting the parser', () => {
    const refusal = refuseStructuralEdit({
      kind: 'delete',
      node: { id: PLAIN, lockReason: 'dynamic — rendered in code' },
    })
    expect(refusal?.reason).toBe('code-placed')
    expect(refusal?.message).toContain('dynamic — rendered in code')
  })

  it('refuses every gesture that would need a source position that does not exist yet', () => {
    expect(refuseStructuralEdit({ kind: 'reparent', node: { id: PLAIN } })?.reason).toBe('reparent')
    expect(refuseStructuralEdit({ kind: 'duplicate', node: { id: PLAIN } })?.reason).toBe('duplicate')
    expect(refuseStructuralEdit({ kind: 'wrap', node: { id: PLAIN } })?.reason).toBe('wrap')
  })

  it('allows an INSERT into a plain container — the new element is written, not minted', () => {
    // `insertJsxElement` writes the element and its import into the file and the
    // board re-reads it, so the question here is only whether this container can
    // hold a written child. No anchor is needed: appending is a real position.
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: PLAIN } })).toBeNull()
  })

  it('refuses an insert into a container whose own placement is not writable', () => {
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: LIST_ROW } })?.reason).toBe('list-row')
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: INLINED } })?.reason).toBe('shared-component')
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: 'app/layout.tsx:3:4' } })?.reason).toBe('route-chrome')
    expect(
      refuseStructuralEdit({ kind: 'insert', node: { id: PLAIN, lockReason: 'a spread' } })?.reason,
    ).toBe('code-placed')
  })

  it('refuses adding an ALREADY-MINTED node to a studio tree, and only there', () => {
    // The plugin/agent path (`applyTreeOperation`): the node object arrives with
    // an id of its own, which can never be a source location.
    expect(refuseMintedNodeInsert({ parent: { id: PLAIN }, studioPageRoot: false })?.reason).toBe('insert')
    expect(refuseMintedNodeInsert({ parent: { id: 'home:body' }, studioPageRoot: true })?.reason).toBe('insert')
    // An ordinary CMS tree is completely unaffected.
    expect(refuseMintedNodeInsert({ parent: { id: 'V1StGXR8_Z5jdHi6B-myT' }, studioPageRoot: false })).toBeNull()
  })

  it('refuses a multi REORDER but not a multi DELETE', () => {
    expect(
      refuseStructuralEdit({ kind: 'reorder', node: { id: PLAIN }, anchor: { id: SIBLING }, multi: true })?.reason,
    ).toBe('multi-select')
    expect(refuseStructuralEdit({ kind: 'delete', node: { id: PLAIN }, multi: true })).toBeNull()
  })

  it('refuses a reorder whose anchor lives in another file', () => {
    expect(
      refuseStructuralEdit({ kind: 'reorder', node: { id: PLAIN }, anchor: { id: 'pages/About.tsx:9:4' } })?.reason,
    ).toBe('cross-file')
  })

  it('refuses a reorder with no sibling to be written against', () => {
    expect(refuseStructuralEdit({ kind: 'reorder', node: { id: PLAIN }, anchor: null })?.reason).toBe(
      'no-sibling-anchor',
    )
  })

  it('says nothing about the synthetic page root — it is not a source location', () => {
    // The root is never asked this question any more: `planSourceInsert`
    // resolves it to the page's returned root element first, and the
    // minted-node path asks `refuseMintedNodeInsert` instead (above).
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: 'home:body' } })).toBeNull()
  })
})

// ─── previewStructuralMove (D2/G5) ─────────────────────────────────────────

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

const A = 'pages/Home.tsx:20:6'
const B = 'pages/Home.tsx:22:6'
const C = 'pages/Home.tsx:24:6'

describe('previewStructuralMove', () => {
  it('previews a same-parent reorder as ok, with the anchor it would write against', () => {
    const tree = page({
      root: node('root', [A, B, C]),
      [A]: node(A),
      [B]: node(B),
      [C]: node(C),
    })

    // Move A to after C: raw index 3.
    const result = previewStructuralMove(tree, [A], 'root', 3)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.commit).toEqual({ nodeId: A, anchorNodeId: C, position: 'after' })
    }
  })

  it('previews a true no-op (dropping back where it started) as ok with no commit', () => {
    const tree = page({
      root: node('root', [A, B, C]),
      [A]: node(A),
      [B]: node(B),
      [C]: node(C),
    })
    const result = previewStructuralMove(tree, [A], 'root', 0)
    expect(result).toEqual({ ok: true, commit: null })
  })

  it('refuses a reparent (different parent) for a source-derived node, before anything else is computed', () => {
    const tree = page({
      root: node('root', ['container', C]),
      container: node('container', [A, B]),
      [A]: node(A),
      [B]: node(B),
      [C]: node(C),
    })
    const result = previewStructuralMove(tree, [A], 'root', 0)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('reparent')
  })

  it('refuses moving a canvas-only (nanoid) node into a studio-imported parent — nothing to write', () => {
    const tree = page({
      root: node('root', [A, 'canvasOnly']),
      [A]: node(A),
      canvasOnly: node('V1StGXR8_Z5jdHi6B-myT'),
    })
    // Rename the canvas-only child's own id to a real nanoid shape (children
    // array must reference the SAME id as the node's own `id`).
    tree.nodes['V1StGXR8_Z5jdHi6B-myT'] = tree.nodes.canvasOnly!
    delete tree.nodes.canvasOnly
    tree.nodes.root!.children = [A, 'V1StGXR8_Z5jdHi6B-myT']
    reindexNodeParents(tree.nodes)

    // Reorder the canvas-only node within the same (studio) parent.
    const result = previewStructuralMove(tree, ['V1StGXR8_Z5jdHi6B-myT'], 'root', 0)
    expect(result.ok).toBe(true) // same parent already -> reorder path, not the reparent guard
  })

  it('refuses reordering a shared-component (inlined) node — identical vocabulary to refuseStructuralEdit', () => {
    const tree = page({
      root: node('root', [INLINED, B]),
      [INLINED]: node(INLINED),
      [B]: node(B),
    })
    const result = previewStructuralMove(tree, [INLINED], 'root', 2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('shared-component')
  })

  it('refuses a multi-node reorder (each write shifts the others\' lines)', () => {
    const tree = page({
      root: node('root', [A, B, C]),
      [A]: node(A),
      [B]: node(B),
      [C]: node(C),
    })
    const result = previewStructuralMove(tree, [A, B], 'root', 3)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('multi-select')
  })

  it('is a no-op (ok, no refusal invented) for a stale target — missing node or parent', () => {
    const tree = page({
      root: node('root', [A]),
      [A]: node(A),
    })
    expect(previewStructuralMove(tree, ['missing'], 'root', 0)).toEqual({ ok: true, commit: null })
    expect(previewStructuralMove(tree, [A], 'missing-parent', 0)).toEqual({ ok: true, commit: null })
  })
})
