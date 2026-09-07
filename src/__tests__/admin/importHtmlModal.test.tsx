import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { ImportHtmlModal } from '@admin/modals/ImportHtml'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

function resetStore() {
  localStorage.clear()

  const rootId = 'root-1'
  const containerId = 'container-1'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({
        id: rootId,
        moduleId: 'base.body',
        children: [containerId],
      }),
      [containerId]: makeNode({
        id: containerId,
        moduleId: 'base.container',
        props: { tag: 'main' },
        children: [],
      }),
    },
  })

  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: { kind: 'page', pageId: 'page-1' },
    importHtmlModalOpen: true,
    importHtmlModalParentId: containerId,
    importHtmlModalPrefill: '<section><h1>Hello</h1><p>World</p></section>',
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

describe('ImportHtmlModal', () => {
  it('uses a CodeMirror editor and DOM-panel tree preview without a parent picker', async () => {
    render(<ImportHtmlModal />)

    expect(screen.queryByRole('combobox', { name: /choose a parent/i })).toBeNull()
    expect(document.querySelector('textarea#import-html-textarea')).toBeNull()

    const editor = await screen.findByTestId('import-html-code-editor')
    // CodeMirror is behind a dynamic `import()` — `codemirror-lazy-only.test.ts`
    // gates that it stays that way — so this waits on a real module fetch and
    // evaluation, not on a render. The global `asyncUtilTimeout` of 5s is sized
    // for renders and is not enough for a cold chunk on a shared CI runner:
    // this was the one non-canvas failure left in the first green-ish CI run.
    // 15s sits comfortably under the 20s per-test budget, so a genuine hang
    // still reports itself here rather than as an opaque test timeout.
    await waitFor(
      () => {
        expect(editor.querySelector('[data-codemirror-container]')).toBeTruthy()
      },
      { timeout: 15_000 },
    )

    const preview = screen.getByRole('tree', { name: 'Imported node preview' })
    await waitFor(() => {
      expect(within(preview).getAllByRole('treeitem').length).toBeGreaterThan(0)
    })
  })
})
