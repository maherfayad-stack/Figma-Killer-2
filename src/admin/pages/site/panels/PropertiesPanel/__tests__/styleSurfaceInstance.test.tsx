/**
 * A component instance's props are reachable in the Design tab (P2-G).
 *
 * The bug this pins: `StyleSurface` answers "no style target is writable"
 * with ONE notice in place of every section — and a `studio.instance` with no
 * writable class is exactly that case, because an instance's inline styles
 * belong to the component's own source. The Component section was one of the
 * sections the notice replaced, so selecting an instance showed "Inline
 * styles come from this component's own source." and no props at all. The
 * Component section writes a call site, not a style; no style lock says
 * anything about it (`inspector/sections/index.ts`'s `writes` doc).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { StyleSurface } from '../StyleSurface'
import { designPrimarySections } from '@site/inspector/sections'
import type { SelectionModel } from '@site/inspector/selectionModel'
import { useEditorStore } from '@site/store/store'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { makeNode, makePage, makeSite } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const originalFetch = globalThis.fetch
const INSTANCE_ID = 'src/pages/Home.tsx:5:3'

function seedInstance() {
  const instance = makeNode({
    id: INSTANCE_ID,
    moduleId: 'studio.instance',
    props: {
      componentName: 'Card',
      source: 'local',
      sourceFile: 'src/components/Card.tsx',
      callSiteProps: { title: 'Hello' },
    },
  })
  const rootId = 'page-1:body'
  const root = makeNode({ id: rootId, moduleId: 'base.body', children: [instance.id] })
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: root, [instance.id]: instance } })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: page.id,
    activeDocument: null,
    selectedNodeId: instance.id,
    selectedNodeIds: [instance.id],
    activeBreakpointId: 'desktop',
    _nodeIdToPageIds: new Map([
      [instance.id, [page.id]],
      [rootId, [page.id]],
    ]),
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  invalidateLocalComponentCatalog()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/admin/api/studio/components')) {
      return new Response(
        JSON.stringify({
          components: [
            {
              name: 'Card',
              file: 'src/components/Card.tsx',
              exportName: 'default',
              isDefaultExport: true,
              props: [{ name: 'title', kind: { kind: 'string' }, required: true }],
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('StyleSurface — a component instance', () => {
  it('mounts the Component section even though no style of the instance is writable', async () => {
    seedInstance()
    const { container } = render(<StyleSurface moduleContent={null} />)

    // The style notice is still honest about styles…
    expect(screen.getByText("Inline styles come from this component's own source.")).toBeTruthy()
    // …and no longer stands in for the props.
    expect(container.querySelector('[data-section-id="component"]')).not.toBeNull()
    expect(await screen.findByTestId('instance-call-site-prop-title')).toBeTruthy()
  })

  it('orders Component directly under Measures (UX-7)', () => {
    const selection = {
      isMultiSelect: false,
      selectedNode: makeNode({ id: INSTANCE_ID, moduleId: 'studio.instance' }),
      selectedNodes: [],
    } as unknown as SelectionModel
    const ids = designPrimarySections(selection).map((section) => section.id)
    expect(ids.indexOf('component')).toBe(ids.indexOf('measures') + 1)
    expect(ids.indexOf('component')).toBeLessThan(ids.indexOf('export'))
  })
})
