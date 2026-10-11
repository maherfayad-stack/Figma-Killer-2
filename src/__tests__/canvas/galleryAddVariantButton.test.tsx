/**
 * The "+" in a variants-gallery frame's header (CV-3): present on a gallery
 * frame whose component is a local one with a variant axis, absent everywhere
 * else, and it opens the same Add-variant form the Component section uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GalleryAddVariantButton } from '@site/canvas/BoardFramesLayer/GalleryAddVariantButton'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { makeNode, makePage } from '../fixtures'

const originalFetch = globalThis.fetch

const STYLED = {
  kind: 'data-attr',
  attr: 'data-tone',
  range: { file: 'src/Badge.tsx', line: 4, column: 10, endLine: 4, endColumn: 30 },
  rules: [{ member: 'solid', selector: '[data-tone="solid"]', range: { file: 'src/Badge.css', line: 1, column: 1, endLine: 3, endColumn: 2 } }],
}

/** A page as the loader builds it: a synthetic body, then the parsed root (the gallery's grid, or an ordinary page's first element). */
function galleryPage(topId = 'component-gallery:component-badge:grid') {
  const cell = makeNode({
    id: 'src/Badge.tsx:2:17#0',
    moduleId: 'studio.instance',
    props: { componentName: 'Badge', source: 'local', sourceFile: 'src/Badge.tsx', callSiteProps: {} },
  })
  const top = makeNode({ id: topId, moduleId: 'base.container', children: [cell.id] })
  const body = makeNode({ id: 'component-badge:body', moduleId: 'base.body', children: [top.id] })
  return makePage({ id: 'component-badge', title: 'Components / Badge', rootNodeId: body.id, nodes: { [body.id]: body, [top.id]: top, [cell.id]: cell } })
}

function serveCatalog(props: unknown[], role = 'component') {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/admin/api/studio/components')) {
      return new Response(
        JSON.stringify({ components: [{ name: 'Badge', file: 'src/Badge.tsx', exportName: 'Badge', isDefaultExport: false, line: 2, column: 17, role, props }] }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as typeof fetch
}

beforeEach(() => {
  invalidateLocalComponentCatalog()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('GalleryAddVariantButton', () => {
  it('renders on a gallery frame of a local component with a variant axis, and opens the Add variant form', async () => {
    serveCatalog([
      { name: 'tone', kind: { kind: 'enum', values: ['solid', 'soft'] }, required: false, defaultValue: 'solid', binding: STYLED },
      { name: 'size', kind: { kind: 'enum', values: ['sm', 'md'] }, required: false, defaultValue: 'md', binding: STYLED },
    ])
    const user = userEvent.setup()
    render(<GalleryAddVariantButton page={galleryPage()} />)

    const button = await screen.findByTestId('gallery-add-variant')
    expect(button.getAttribute('aria-label')).toBe('Add a Badge variant')
    await user.click(button)
    const form = await screen.findByTestId('add-variant-form')
    // Two axes: the form asks which one.
    expect(within(form).getByLabelText('Property to add a variant to')).toBeTruthy()
  })

  it('renders nothing on an ordinary frame, even for the same component', async () => {
    serveCatalog([{ name: 'tone', kind: { kind: 'enum', values: ['solid', 'soft'] }, required: false, binding: STYLED }])
    render(<GalleryAddVariantButton page={galleryPage('src/pages/Home.tsx:3:3')} />)
    await waitFor(() => expect(screen.queryByTestId('gallery-add-variant')).toBeNull())
  })

  it('renders nothing when the component is not one Studio can write (a page role) or has no variant axis', async () => {
    serveCatalog([{ name: 'tone', kind: { kind: 'enum', values: ['solid', 'soft'] }, required: false, binding: STYLED }], 'page')
    const { unmount } = render(<GalleryAddVariantButton page={galleryPage()} />)
    await waitFor(() => expect(screen.queryByTestId('gallery-add-variant')).toBeNull())
    unmount()

    invalidateLocalComponentCatalog()
    serveCatalog([{ name: 'label', kind: { kind: 'string' }, required: true }])
    render(<GalleryAddVariantButton page={galleryPage()} />)
    await waitFor(() => expect(screen.queryByTestId('gallery-add-variant')).toBeNull())
  })
})
