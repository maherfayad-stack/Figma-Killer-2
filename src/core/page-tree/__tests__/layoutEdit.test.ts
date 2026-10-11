/**
 * G-8 — the placement rule while a layout file is being edited. The rule is
 * `refusePlacement` / `refuseStructuralEdit`; the mode is one module-level fact
 * (`layoutEdit.ts`) the store's `setMainEditTarget` is the only writer of.
 *
 * What matters is the SHAPE of the exception: it opens exactly one file, and
 * every other refusal keeps refusing inside it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { isEditedLayoutNodeId, layoutFileOf, layoutRouteCount, setEditedLayoutFile } from '../layoutEdit'
import type { Page } from '../page'
import { refusePlacement, refuseStructuralEdit } from '../sourceStructure'

afterEach(() => setEditedLayoutFile(null))

const ROOT_NAV = 'app/layout.tsx:5:7'
const SEGMENT_NAV = 'app/shop/layout.tsx:5:7'
const TEMPLATE_DIV = 'app/template.tsx:3:5'
const PAGE_DIV = 'app/page.tsx:4:7'

describe('refusePlacement — route-chrome', () => {
  it('refuses a layout, a segment layout and a template by default', () => {
    for (const id of [ROOT_NAV, SEGMENT_NAV, TEMPLATE_DIV]) {
      expect(refusePlacement({ id }, 'Moved')?.reason).toBe('route-chrome')
      expect(refuseStructuralEdit({ kind: 'delete', node: { id } })?.reason).toBe('route-chrome')
    }
    expect(refusePlacement({ id: PAGE_DIV }, 'Moved')).toBeNull()
  })

  it('stops refusing the ONE layout file being edited, for every gesture', () => {
    setEditedLayoutFile('app/layout.tsx')
    expect(isEditedLayoutNodeId(ROOT_NAV)).toBe(true)
    for (const kind of ['delete', 'duplicate', 'wrap', 'group', 'ungroup', 'insert'] as const) {
      expect(refuseStructuralEdit({ kind, node: { id: ROOT_NAV } })).toBeNull()
    }
    expect(refuseStructuralEdit({ kind: 'reorder', node: { id: ROOT_NAV }, anchor: { id: 'app/layout.tsx:6:7' } })).toBeNull()
    expect(refuseStructuralEdit({ kind: 'reparent', node: { id: ROOT_NAV }, destination: { id: 'app/layout.tsx:3:5' } })).toBeNull()
  })

  it('keeps refusing every other layout, a template, and an unrelated file with the same name elsewhere', () => {
    setEditedLayoutFile('app/layout.tsx')
    expect(isEditedLayoutNodeId(SEGMENT_NAV)).toBe(false)
    expect(refusePlacement({ id: SEGMENT_NAV }, 'Moved')?.reason).toBe('route-chrome')
    expect(refusePlacement({ id: TEMPLATE_DIV }, 'Moved')?.reason).toBe('route-chrome')
    expect(refusePlacement({ id: 'packages/docs/app/layout.tsx:5:7' }, 'Moved')?.reason).toBe('route-chrome')
  })

  it('every refusal that is not route-chrome still applies inside the edited layout', () => {
    setEditedLayoutFile('app/layout.tsx')
    // A node the code places (a spread, a condition) is still code-placed.
    expect(refusePlacement({ id: ROOT_NAV, lockReason: 'rendered by a spread' }, 'Moved')?.reason).toBe('code-placed')
    // A .map row inside the layout is still a row.
    expect(refusePlacement({ id: 'app/layout.tsx:9:9#2' }, 'Moved')?.reason).toBe('list-row')
    // A shared component rendered by the layout is still a shared component.
    expect(refusePlacement({ id: 'app/layout.tsx:7:7~components/Nav.tsx:3:5' }, 'Moved')?.reason).toBe('shared-component')
  })

  it('ending the mode brings the refusal back', () => {
    setEditedLayoutFile('app/layout.tsx')
    expect(refusePlacement({ id: ROOT_NAV }, 'Moved')).toBeNull()
    setEditedLayoutFile(null)
    expect(refusePlacement({ id: ROOT_NAV }, 'Moved')?.reason).toBe('route-chrome')
  })
})

describe('layoutFileOf / layoutRouteCount', () => {
  it('names the layout file of a route-chrome node and nothing else', () => {
    expect(layoutFileOf(ROOT_NAV)).toBe('app/layout.tsx')
    expect(layoutFileOf(TEMPLATE_DIV)).toBe('app/template.tsx')
    expect(layoutFileOf(PAGE_DIV)).toBeNull()
    expect(layoutFileOf('app/page.tsx:3:3~components/layout.tsx:2:2')).toBe('components/layout.tsx')
  })

  it('counts the routes that draw a layout file, per page', () => {
    const page = (...ids: string[]): Pick<Page, 'nodes'> => ({ nodes: Object.fromEntries(ids.map((id) => [id, {} as Page['nodes'][string]])) })
    const pages = [page(ROOT_NAV, PAGE_DIV), page(ROOT_NAV, SEGMENT_NAV), page('app/other/page.tsx:2:2')]
    expect(layoutRouteCount(pages, 'app/layout.tsx')).toBe(2)
    expect(layoutRouteCount(pages, 'app/shop/layout.tsx')).toBe(1)
    expect(layoutRouteCount(pages, 'app/missing/layout.tsx')).toBe(0)
  })
})
