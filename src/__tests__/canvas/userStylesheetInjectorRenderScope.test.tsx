/**
 * Track C3 regression gate — `UserStylesheetInjector` must not recompute (and
 * must not re-render) on a keystroke, and must still recompute when the
 * inputs its CSS genuinely depends on change.
 *
 * Before the fix, this component subscribed to the WHOLE `s.site` object and
 * ran `collectUserStylesheetCss` → `resolveViewportUnitsForCanvas` (regex) →
 * `rewritePrefersColorScheme` (regex) directly in the render body — so it
 * re-ran on EVERY store-touching mutation, in EVERY mounted iframe, including
 * edits to node text/props that have no bearing on which user stylesheets
 * apply. See `UserStylesheetInjector.tsx`'s "Perf (Track C3)" doc.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { UserStylesheetInjector } from '@site/canvas/UserStylesheetInjector'
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  resetStore()
})

afterEach(() => {
  cleanup()
  resetStore()
})

/**
 * Own detached document + adapter per harness — mirrors production exactly:
 * every `IframeFrameSurface` constructs exactly one `PortalFrameAdapter` for
 * its OWN iframe document. `applyOverlay`'s managed-style map lives on the
 * adapter INSTANCE, not the document, so two adapters sharing one document
 * (the pre-`live-05` version of this test) would each blindly create their
 * own `mc-user-styles` overlay rather than reusing one — not a scenario
 * production ever produces.
 */
function Harness({ id, onRender, adapter }: { id: string; onRender: ProfilerOnRenderCallback; adapter: PortalFrameAdapter }) {
  return (
    <Profiler id={id} onRender={onRender}>
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <UserStylesheetInjector />
      </CanvasFrameAdapterContext.Provider>
    </Profiler>
  )
}

describe('UserStylesheetInjector render scope (Track C3)', () => {
  it('does not re-render on a node-content edit to the active page (irrelevant to CSS), but does on a style-file change', () => {
    const page = makePage({
      id: 'page-1',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text-1'] }),
        'text-1': makeNode({ id: 'text-1', moduleId: 'base.text', props: { text: 'hi' } }),
      },
    })
    const site = makeSite({
      pages: [page],
      files: [{
        id: 'style-1',
        path: 'src/styles/site.css',
        type: 'style',
        content: '.a { color: red; }',
        createdAt: 1,
        updatedAt: 1,
      }],
    })

    useEditorStore.setState({
      site,
      activePageId: 'page-1',
    } as Parameters<typeof useEditorStore.setState>[0])

    const renderCounts: Record<string, number> = {}
    const onRender: ProfilerOnRenderCallback = (id) => {
      renderCounts[id] = (renderCounts[id] ?? 0) + 1
    }

    // Two "frames" — both keyed off the same (global) active page, mirroring
    // how `IframeFrameSurface` mounts one of these per breakpoint frame. Each
    // gets its own document + adapter (see `Harness`'s own doc).
    const doc1 = document.implementation.createHTMLDocument('frame-1')
    const doc2 = document.implementation.createHTMLDocument('frame-2')
    const adapter1 = new PortalFrameAdapter(doc1)
    const adapter2 = new PortalFrameAdapter(doc2)

    render(
      <>
        <Harness id="frame-1" onRender={onRender} adapter={adapter1} />
        <Harness id="frame-2" onRender={onRender} adapter={adapter2} />
      </>,
    )

    expect(renderCounts['frame-1']).toBe(1)
    expect(renderCounts['frame-2']).toBe(1)

    // A real keystroke on the active page's own text node, via the actual
    // store action — this must NOT touch `site.files`/`site.runtime`, so the
    // stylesheet CSS is unaffected and neither frame should recompute.
    act(() => {
      useEditorStore.getState().updateNodeProps('text-1', { text: 'edited' })
    })

    expect(renderCounts['frame-1']).toBe(1)
    expect(renderCounts['frame-2']).toBe(1)

    const styleElBefore = doc1.querySelector('[data-studio-overlay-id="mc-user-styles"]')?.textContent
    expect(styleElBefore).toContain('color: red')

    // Now change something the CSS genuinely depends on — a style file's
    // content — and confirm both frames DO pick it up.
    act(() => {
      const current = useEditorStore.getState().site!
      const nextFiles = current.files.map((f) =>
        f.id !== 'style-1' ? f : { ...f, content: '.a { color: blue; }' },
      )
      useEditorStore.setState({
        site: { ...current, files: nextFiles },
      } as Parameters<typeof useEditorStore.setState>[0])
    })

    expect(renderCounts['frame-1']).toBeGreaterThan(1)
    expect(renderCounts['frame-2']).toBeGreaterThan(1)
    expect(doc1.querySelector('[data-studio-overlay-id="mc-user-styles"]')?.textContent).toContain('color: blue')
    expect(doc2.querySelector('[data-studio-overlay-id="mc-user-styles"]')?.textContent).toContain('color: blue')

    adapter1.dispose()
    adapter2.dispose()
  })
})
