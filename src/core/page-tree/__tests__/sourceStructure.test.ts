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
import {
  isRouteChromeNodeId,
  isSourceDerivedNodeId,
  isStudioPageRootId,
  refuseStructuralEdit,
} from '../index'

const PLAIN = 'pages/Home.tsx:12:6'
const SIBLING = 'pages/Home.tsx:14:6'

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
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: PLAIN } })?.reason).toBe('insert')
    expect(refuseStructuralEdit({ kind: 'duplicate', node: { id: PLAIN } })?.reason).toBe('duplicate')
    expect(refuseStructuralEdit({ kind: 'wrap', node: { id: PLAIN } })?.reason).toBe('wrap')
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

  it('answers for the synthetic page root only when the caller says it is source-backed', () => {
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: 'home:body' } })).toBeNull()
    expect(refuseStructuralEdit({ kind: 'insert', node: { id: 'home:body' }, sourceBacked: true })?.reason).toBe(
      'insert',
    )
  })
})
