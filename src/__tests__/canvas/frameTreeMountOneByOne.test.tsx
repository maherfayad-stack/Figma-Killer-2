/**
 * P6-B finding 1 — a board's frames mount their node trees ONE BY ONE.
 *
 * Every frame used to start its tree's `startTransition` from its own effect
 * in the same burst, and React renders pending transition lanes together: all
 * of a board's trees committed in ONE commit, so the first frame could not
 * paint before the last. `frameTreeMountQueue.ts` now grants one frame at a
 * time. Each frame's `onContentReadyChange(true)` runs in the passive effects
 * of the commit that mounted its tree; at that moment only the frames granted
 * so far may have a tree in their document. On the old code every callback saw
 * all three trees (`[3, 3, 3]`).
 *
 * Rendered through `BreakpointFrame` under its own `CanvasPageContext`, the
 * way `BoardFrameView` mounts a board frame.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { CanvasPageContext } from '@site/canvas/CanvasContexts'
import { frameTreeMountQueueState } from '@site/canvas/frameTreeMountQueue'
import { useEditorStore } from '@site/store/store'
import type { Page } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const BREAKPOINT = { id: 'studio', label: 'Studio', mediaQuery: '(max-width: 1024px)', width: 800 }
const NAMES = ['a', 'b', 'c'] as const

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    selectedNodeFrameId: null,
    activeBreakpointId: BREAKPOINT.id,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function makePages(): Page[] {
  return NAMES.map((name) => {
    const text = makeNode({ id: `text-${name}`, moduleId: 'base.text', props: { text: name } })
    const root = makeNode({ id: `root-${name}`, moduleId: 'base.body', children: [text.id] })
    return makePage({ id: `page-${name}`, slug: name, rootNodeId: root.id, nodes: { [root.id]: root, [text.id]: text } })
  })
}

/** How many canvas documents hold their page's tree right now. */
function treesInDocuments(): number {
  return [...document.querySelectorAll('iframe')].filter((iframe) => iframe.contentDocument?.querySelector('[data-node-id^="text-"]')).length
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  cleanup()
  resetStore()
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  resetStore()
  globalThis.fetch = originalFetch
})

function renderFrames(pages: readonly Page[], onReady: (pageId: string) => void) {
  return (
    <>
      {pages.map((page) => (
        <CanvasPageContext.Provider key={page.id} value={page.id}>
          <BreakpointFrame
            page={page}
            breakpoint={BREAKPOINT}
            isActive={false}
            onActivate={() => {}}
            frameId={`frame-${page.id}`}
            showBreakpointChrome={false}
            onContentReadyChange={(ready) => {
              if (ready) onReady(page.id)
            }}
          />
        </CanvasPageContext.Provider>
      ))}
    </>
  )
}

describe('board frames mount their trees one by one', () => {
  it('each frame commits its tree in its own commit, never together with the others', async () => {
    const pages = makePages()
    useEditorStore.setState({ site: makeSite({ pages }), activePageId: pages[0]!.id } as Parameters<typeof useEditorStore.setState>[0])
    const treesAtReady = new Map<string, number>()
    render(renderFrames(pages, (pageId) => {
      if (!treesAtReady.has(pageId)) treesAtReady.set(pageId, treesInDocuments())
    }))

    await waitFor(() => expect(treesAtReady.size).toBe(NAMES.length), { timeout: 5000 })
    expect([...treesAtReady.values()].sort()).toEqual([1, 2, 3])
    expect(treesInDocuments()).toBe(3)
    expect(frameTreeMountQueueState()).toEqual({ waiting: 0, granted: false })
  })

  it('frames that leave while waiting or holding the grant do not stall the one that stays', async () => {
    const pages = makePages()
    useEditorStore.setState({ site: makeSite({ pages }), activePageId: pages[0]!.id } as Parameters<typeof useEditorStore.setState>[0])
    const ready = new Set<string>()
    const { rerender } = render(renderFrames(pages, (pageId) => ready.add(pageId)))
    rerender(renderFrames([pages[2]!], (pageId) => ready.add(pageId)))

    await waitFor(() => expect(ready.has('page-c')).toBe(true), { timeout: 5000 })
    expect(frameTreeMountQueueState()).toEqual({ waiting: 0, granted: false })
  })
})
