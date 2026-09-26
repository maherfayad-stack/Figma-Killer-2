/**
 * P5-D SVG-5 — an icon in Assets → Icons INSERTS on click (it used to only
 * copy its markup): one subtree insert of the converted, sanitised `<svg>`,
 * right after the selection — the paste's own write (`canvasSvgInsert.ts`).
 * Copying moved to the icon's context menu.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { IconsSection } from '@site/panels/AssetsPanel/IconsSection'
import { invalidateStudioIconCatalog } from '@site/studio/iconCatalog'
import { makeNode, makePage, makeSite } from '../fixtures'

const realFetch = globalThis.fetch
const insertJsxSubtreeIntoPage = mock((_request: unknown) => {})
const realInsert = useEditorStore.getState().insertJsxSubtreeIntoPage

const ICON = {
  id: 'pkg/wifi',
  name: 'wifi',
  group: 'line',
  pkg: 'pkg',
  markup: '<svg viewBox="0 0 24 24" onload="steal()"><path d="M4 4h16" style="stroke:#000"/></svg>',
}

beforeEach(() => {
  invalidateStudioIconCatalog()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ icons: [ICON] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  insertJsxSubtreeIntoPage.mockClear()
  const page = makePage({
    id: 'home',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
      a: makeNode({ id: 'a', moduleId: 'base.container', parentId: 'root' }),
      b: makeNode({ id: 'b', moduleId: 'base.container', parentId: 'root' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'home',
    activeDocument: null,
    selectedNodeId: 'a',
    selectedNodeIds: ['a'],
    insertJsxSubtreeIntoPage,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  useEditorStore.setState({ insertJsxSubtreeIntoPage: realInsert } as Parameters<typeof useEditorStore.setState>[0])
})

describe('Assets → Icons', () => {
  it('a click inserts the icon as inline JSX right after the selection, sanitised and converted', async () => {
    const { findByRole } = render(<IconsSection query="" collapsed={false} onToggle={() => {}} />)
    const tile = await findByRole('button', { name: 'Add the wifi icon' })
    fireEvent.click(tile)
    await waitFor(() => expect(insertJsxSubtreeIntoPage).toHaveBeenCalledTimes(1))
    const request = insertJsxSubtreeIntoPage.mock.calls[0]![0] as {
      pageId: string
      parentId: string
      index: number
      node: { name: string; props?: Record<string, unknown>; children?: { name: string; props?: Record<string, unknown> }[] }
      undoLabel: string
    }
    expect(request).toMatchObject({ pageId: 'home', parentId: 'root', index: 1, undoLabel: 'Add wifi icon' })
    expect(request.node.name).toBe('svg')
    // The handler never reaches the source, and a style string became an attribute.
    expect(JSON.stringify(request.node)).not.toContain('onload')
    expect(request.node.children?.[0]?.props).toMatchObject({ d: 'M4 4h16', stroke: '#000' })
  })

  it('copying moved to the context menu', async () => {
    const { findByRole, getByRole } = render(<IconsSection query="" collapsed={false} onToggle={() => {}} />)
    const tile = await findByRole('button', { name: 'Add the wifi icon' })
    fireEvent.contextMenu(tile, { clientX: 10, clientY: 10 })
    expect(getByRole('menuitem', { name: /Copy SVG/ })).toBeDefined()
    expect(insertJsxSubtreeIntoPage).not.toHaveBeenCalled()
  })
})
