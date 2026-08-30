/**
 * previewAxesFrameAttributes.test.tsx — WS-10 Phase 1. Proves:
 *   1. `previewAxes.direction`/`colorScheme` land on the frame document's
 *      `<html>` (`dir`, `lang`, `data-studio-scheme`, `data-theme`, inline
 *      `color-scheme`) — `data-theme` written EXPLICITLY in both schemes,
 *      never removed, because absence is not light (see `VENDOR_THEME_ATTR`).
 *   2. Toggling either axis does NOT remount the frame — risk §7.1. A
 *      `srcDoc`/`key`-based implementation would swap in a fresh iframe
 *      document; this asserts the SAME iframe element and the SAME
 *      `contentDocument` survive the toggle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { DEFAULT_PREVIEW_AXES } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { makeNode, makePage, makeSite } from '../fixtures'
import { getCanvasFrameDocument, waitForCanvasFrameDocument } from './iframeCanvasQuery'
import '@modules/base'

const originalFetch = globalThis.fetch

function renderCanvas() {
  return render(<DndContext><CanvasRoot /></DndContext>)
}

beforeEach(() => {
  cleanup()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    canvasView: 'design',
    collapsedBreakpointIds: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    previewAxes: DEFAULT_PREVIEW_AXES,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('preview axes on the frame document', () => {
  it('applies dir/lang/scheme to <html> and toggling them does not remount the frame', async () => {
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [] })
    const page = makePage({ id: 'page', rootNodeId: root.id, nodes: { [root.id]: root } })

    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')
    const iframeBefore = document.querySelector<HTMLIFrameElement>('iframe[title="Canvas frame for desktop"]')
    expect(iframeBefore).toBeTruthy()

    await waitFor(() => {
      expect(frameDocument.documentElement.getAttribute('dir')).toBe('ltr')
    })
    expect(frameDocument.documentElement.getAttribute('data-studio-scheme')).toBe('light')
    // Written, not merely absent: the vendor stylesheet injected into every
    // frame declares its light tokens under `:root:not([data-theme=light])`,
    // so an unset attribute reads as DARK. See `VENDOR_THEME_ATTR`.
    expect(frameDocument.documentElement.getAttribute('data-theme')).toBe('light')
    expect(frameDocument.documentElement.style.colorScheme).toBe('light')
    expect(frameDocument.documentElement.hasAttribute('lang')).toBe(false)

    act(() => {
      useEditorStore.getState().setPreviewAxes({ direction: 'rtl', colorScheme: 'dark' })
    })

    await waitFor(() => {
      expect(frameDocument.documentElement.getAttribute('dir')).toBe('rtl')
    })
    expect(frameDocument.documentElement.getAttribute('lang')).toBe('ar')
    expect(frameDocument.documentElement.getAttribute('data-studio-scheme')).toBe('dark')
    expect(frameDocument.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(frameDocument.documentElement.style.colorScheme).toBe('dark')

    // No remount: same iframe element, same contentDocument identity.
    const iframeAfter = document.querySelector<HTMLIFrameElement>('iframe[title="Canvas frame for desktop"]')
    expect(iframeAfter).toBe(iframeBefore)
    expect(getCanvasFrameDocument('desktop')).toBe(frameDocument)

    // Toggling back to ltr/light removes `lang` again rather than leaving a stale guess.
    act(() => {
      useEditorStore.getState().setPreviewAxes({ direction: 'ltr', colorScheme: 'light' })
    })
    await waitFor(() => {
      expect(frameDocument.documentElement.getAttribute('dir')).toBe('ltr')
    })
    expect(frameDocument.documentElement.hasAttribute('lang')).toBe(false)
    expect(frameDocument.documentElement.getAttribute('data-theme')).toBe('light')
  })

  // An iframe document that paints no background of its own is TRANSPARENT —
  // the embedding element is what shows through, and a grow-to-content frame
  // leaves a lot of it uncovered below a short page. A fixed `--overlay` there
  // painted every dark-mode preview on white paper: dark content on top, a
  // white band under it. The paper follows the previewed scheme now.
  it('paints the frame paper from the previewed colour scheme, not the admin theme', async () => {
    const root = makeNode({ id: 'page-root', moduleId: 'base.body', children: [] })
    const page = makePage({ id: 'page', rootNodeId: root.id, nodes: { [root.id]: root } })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    await waitForCanvasFrameDocument('desktop')
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Canvas frame for desktop"]')
    expect(iframe?.getAttribute('data-preview-scheme')).toBe('light')

    act(() => {
      useEditorStore.getState().setPreviewAxes({ colorScheme: 'dark' })
    })
    await waitFor(() => {
      expect(iframe?.getAttribute('data-preview-scheme')).toBe('dark')
    })
  })
})
