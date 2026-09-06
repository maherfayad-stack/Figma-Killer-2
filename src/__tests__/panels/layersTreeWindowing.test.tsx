/**
 * Everything windowing the Layers tree threatened, asserted.
 *
 * Mounting only the visible slice is easy; keeping the panel's behaviour while
 * doing it is the work. Each block below is one behaviour that stops being
 * automatic the moment a row can be absent from the DOM:
 *
 *   1. the window itself, and the spacers that keep the scrollbar honest
 *   2. the correctness fallback — unmeasurable layout renders EVERYTHING
 *   3. drop indicators and the refusal tooltip, now props instead of context
 *   4. drag-source dimming, which used to come free from a wrapper element
 *   5. keyboard focus surviving a row that scrolls out and comes back
 *   6. scroll-to-selection + ancestor auto-expand, for a row that is not mounted
 *   7. a background page's subtree costing nothing while it is off screen
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { DomPanel } from '@site/panels/DomPanel/DomPanel'
import { PageLayerSubtree } from '@site/panels/DomPanel/PageLayerSubtree'
import { LayerRowList } from '@site/panels/DomPanel/LayerRowList'
import { DomTreeProvider } from '@site/panels/DomPanel/DomTreeProvider'
import {
  DomPanelDropStateContext,
  DomPanelRowRegistryContext,
  IDLE_DROP_STATE,
  type DomPanelDropState,
} from '@site/panels/DomPanel/DomPanelDndContext'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'
import type { PageNode } from '@core/page-tree'

const TREE_NODE_SOURCE_PATH = join(
  import.meta.dir,
  '../../admin/pages/site/panels/DomPanel/TreeNode.tsx',
)

afterEach(cleanup)

// ── Fixture: a flat body with 300 children, so the window is obvious ────────
const WIDE_CHILD_COUNT = 300

function buildWidePage(pageId: string, prefix: string) {
  const nodes: Record<string, PageNode> = {}
  const rootId = `${prefix}-root`
  const childIds: string[] = []
  for (let i = 0; i < WIDE_CHILD_COUNT; i += 1) {
    const id = `${prefix}-child-${i}`
    childIds.push(id)
    nodes[id] = makeNode({ id, moduleId: 'base.text', children: [] })
  }
  nodes[rootId] = makeNode({ id: rootId, moduleId: 'base.body', children: childIds })
  return makePage({ id: pageId, rootNodeId: rootId, nodes, title: `Page ${prefix}` })
}

/** A deep spine, for the scroll-to-selection / auto-expand case. */
function buildDeepPage() {
  const nodes: Record<string, PageNode> = {}
  const rootId = 'deep-root'
  let parentId = rootId
  for (let d = 0; d < 12; d += 1) {
    const childId = `deep-${d}`
    nodes[parentId] = makeNode({
      id: parentId,
      moduleId: d === 0 ? 'base.body' : 'base.container',
      children: [childId],
    })
    parentId = childId
  }
  nodes[parentId] = makeNode({ id: parentId, moduleId: 'base.text', children: [] })
  return makePage({ id: 'page-deep', rootNodeId: rootId, nodes })
}

const VIEWPORT_HEIGHT = 280
const ROW_HEIGHT = 28

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    focusedPanel: 'canvas',
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadSite(pages: ReturnType<typeof makePage>[], activePageId: string) {
  useEditorStore.setState({
    site: makeSite({ pages }),
    activePageId,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/**
 * happy-dom performs no layout: every element reports height 0, which is
 * exactly the "cannot measure" signal the window treats as "render
 * everything". These stubs give it a real viewport and a real row height so
 * the window math runs the same code path a browser runs.
 */
function stubRowHeights() {
  const proto = (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype
  const original = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'treeitem' ? ROW_HEIGHT : 0
    },
  })
  return () => {
    if (original) Object.defineProperty(proto, 'offsetHeight', original)
    else Reflect.deleteProperty(proto, 'offsetHeight')
  }
}

interface Scroller extends HTMLElement {
  scrollToCalls: ScrollToOptions[]
}

function makeScroller(): Scroller {
  const host = document.createElement('div') as Scroller
  host.style.overflowY = 'auto'
  host.scrollToCalls = []
  Object.defineProperty(host, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true })
  host.getBoundingClientRect = () => rect(0, VIEWPORT_HEIGHT)
  host.scrollTo = ((options: ScrollToOptions) => {
    host.scrollToCalls.push(options)
  }) as HTMLElement['scrollTo']
  document.body.appendChild(host)
  return host
}

function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, left: 0, right: 400, width: 400, height,
    x: 0, y: top, toJSON: () => ({}),
  } as DOMRect
}

function treeContainer(): HTMLElement {
  return document.querySelector('[data-studio-layer-tree="true"]') as HTMLElement
}

/** Move the list under the viewport by `pixels` and let the scroll listener run. */
function scrollBy(scroller: Scroller, pixels: number) {
  const container = treeContainer()
  container.getBoundingClientRect = () => rect(-pixels, WIDE_CHILD_COUNT * ROW_HEIGHT)
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
}

function mountedRowIds(): string[] {
  return Array.from(document.querySelectorAll('[role="treeitem"]')).map(
    (el) => el.getAttribute('data-studio-node-id') ?? '',
  )
}

function spacerHeights(): number[] {
  return Array.from(treeContainer().querySelectorAll('[role="presentation"]')).map((el) => {
    const raw = (el as HTMLElement).style.getPropertyValue('--layer-spacer-h')
    return Number.parseInt(raw, 10) || 0
  })
}

beforeEach(resetStore)

// ---------------------------------------------------------------------------
// 1 — the window and its spacers
// ---------------------------------------------------------------------------

describe('Layers tree — the window', () => {
  it('mounts only the viewport slice and stands in for the rest with spacers', () => {
    const restore = stubRowHeights()
    try {
      loadSite([buildWidePage('page-1', 'w')], 'page-1')
      const scroller = makeScroller()
      render(<DomPanel />, { container: scroller })

      const ids = mountedRowIds()
      // 280px / 28px = 10 rows visible, +1 partial, +8 overscan each way.
      expect(ids.length).toBeLessThanOrEqual(28)
      expect(ids[0]).toBe('w-root')

      // Height is conserved: mounted rows + both spacers == every row.
      const total = ids.length * ROW_HEIGHT + spacerHeights().reduce((a, b) => a + b, 0)
      expect(total).toBe((WIDE_CHILD_COUNT + 1) * ROW_HEIGHT)
    } finally {
      restore()
    }
  })

  it('mounts a different slice after the list scrolls, and keeps total height', () => {
    const restore = stubRowHeights()
    try {
      loadSite([buildWidePage('page-1', 'w')], 'page-1')
      const scroller = makeScroller()
      render(<DomPanel />, { container: scroller })

      const before = mountedRowIds()
      scrollBy(scroller, 100 * ROW_HEIGHT)
      const after = mountedRowIds()

      expect(after[0]).not.toBe(before[0])
      expect(after).toContain('w-child-99')
      expect(after.length).toBeLessThanOrEqual(28)

      const total = after.length * ROW_HEIGHT + spacerHeights().reduce((a, b) => a + b, 0)
      expect(total).toBe((WIDE_CHILD_COUNT + 1) * ROW_HEIGHT)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// 2 — the correctness fallback
// ---------------------------------------------------------------------------

describe('Layers tree — unmeasurable layout', () => {
  it('renders EVERY row when there is no scroll container', () => {
    // No stubbed row height, no scroller: the panel must not silently truncate.
    loadSite([buildWidePage('page-1', 'w')], 'page-1')
    render(<DomPanel />)
    expect(mountedRowIds().length).toBe(WIDE_CHILD_COUNT + 1)
    expect(spacerHeights()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3 — drop indicators + the refusal tooltip
// ---------------------------------------------------------------------------

function renderListWithDropState(dropState: DomPanelDropState) {
  const page = buildWidePage('page-1', 'w')
  loadSite([page], 'page-1')
  return render(
    <DomTreeProvider>
      <DomPanelRowRegistryContext.Provider value={{ registerRow: () => {} }}>
        <DomPanelDropStateContext.Provider value={dropState}>
          <LayerRowList
            ariaLabel="Page element tree"
            rootNodeIds={[page.rootNodeId]}
            alwaysExpandedId={page.rootNodeId}
            editable
            revealSelection={false}
          />
        </DomPanelDropStateContext.Provider>
      </DomPanelRowRegistryContext.Provider>
    </DomTreeProvider>,
  )
}

describe('Layers tree — drop indicators survive the context split', () => {
  it('marks the row the pointer resolves to, and only that row', () => {
    renderListWithDropState({
      ...IDLE_DROP_STATE,
      activeId: 'w-child-0',
      target: {
        draggedId: 'w-child-0',
        draggedIds: ['w-child-0'],
        parentId: 'w-root',
        index: 5,
        position: 'after',
        overId: 'w-child-4',
        slot: undefined,
      },
    })

    const marked = Array.from(document.querySelectorAll('[data-drop-position]'))
    expect(marked).toHaveLength(1)
    expect(marked[0].getAttribute('data-studio-node-id')).toBe('w-child-4')
    expect(marked[0].getAttribute('data-drop-position')).toBe('after')
  })

  it('puts the source-write refusal message on the refused row as a title', () => {
    renderListWithDropState({
      ...IDLE_DROP_STATE,
      activeId: 'w-child-0',
      invalidOverId: 'w-child-3',
      invalidReason: 'This layer comes from a shared component.',
    })

    const refused = document.querySelector('[data-studio-node-id="w-child-3"]')
    expect(refused?.getAttribute('title')).toBe('This layer comes from a shared component.')
    // Rows that are not the refused target carry no tooltip.
    expect(document.querySelector('[data-studio-node-id="w-child-4"]')?.getAttribute('title'))
      .toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4 — drag-source dimming across a whole subtree
// ---------------------------------------------------------------------------

describe('Layers tree — drag source dimming', () => {
  it('dims the dragged row and everything visible under it', () => {
    const page = buildDeepPage()
    loadSite([page], 'page-deep')
    const { container } = render(
      <DomTreeProvider>
        <DomPanelRowRegistryContext.Provider value={{ registerRow: () => {} }}>
          <DomPanelDropStateContext.Provider value={{ ...IDLE_DROP_STATE, activeId: 'deep-0' }}>
            <LayerRowList
              ariaLabel="Page element tree"
              rootNodeIds={[page.rootNodeId]}
              alwaysExpandedId={page.rootNodeId}
              editable
              revealSelection={false}
            />
          </DomPanelDropStateContext.Provider>
        </DomPanelRowRegistryContext.Provider>
      </DomTreeProvider>,
    )

    // Only the body and deep-0 are visible (deep-0 is collapsed), so the
    // dragged span is exactly deep-0.
    const dimmed = Array.from(container.querySelectorAll('[data-drag-source="true"]'))
    expect(dimmed.map((el) => el.getAttribute('data-node-id'))).toEqual(['deep-0'])
  })
})

// ---------------------------------------------------------------------------
// 5 — focus survives the window
// ---------------------------------------------------------------------------

describe('Layers tree — focus survives windowing', () => {
  it('parks focus on the tree when the focused row unmounts, and gives it back', () => {
    const restore = stubRowHeights()
    try {
      loadSite([buildWidePage('page-1', 'w')], 'page-1')
      const scroller = makeScroller()
      render(<DomPanel />, { container: scroller })

      const row = document.querySelector('[data-studio-node-id="w-child-2"]') as HTMLElement
      act(() => {
        row.focus()
        fireEvent.focus(row)
      })
      expect(document.activeElement).toBe(row)

      // Scroll it far out of the window — the element is destroyed.
      scrollBy(scroller, 150 * ROW_HEIGHT)
      expect(document.querySelector('[data-studio-node-id="w-child-2"]')).toBeNull()
      expect(document.activeElement).toBe(treeContainer())

      // Scroll back — the row returns and takes focus with it.
      scrollBy(scroller, 0)
      const restored = document.querySelector('[data-studio-node-id="w-child-2"]')
      expect(restored).not.toBeNull()
      expect(document.activeElement).toBe(restored)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// 6 — scroll-to-selection for a row that is not mounted
// ---------------------------------------------------------------------------

describe('Layers tree — reveal the canvas selection', () => {
  it('expands the ancestors of a deeply nested selection', async () => {
    loadSite([buildDeepPage()], 'page-deep')
    render(<DomPanel />)

    // Nothing but the body and its single child is visible to start with.
    expect(mountedRowIds()).toEqual(['deep-root', 'deep-0'])

    act(() => {
      useEditorStore.setState({
        selectedNodeId: 'deep-11',
        selectedNodeIds: ['deep-11'],
      } as Parameters<typeof useEditorStore.setState>[0])
    })

    // Every ancestor on the path is expanded, so the selected row is visible.
    expect(mountedRowIds()).toContain('deep-11')
  })

  it('scrolls the shared scroller by index when the selected row is outside the window', async () => {
    const restore = stubRowHeights()
    try {
      loadSite([buildWidePage('page-1', 'w')], 'page-1')
      const scroller = makeScroller()
      render(<DomPanel />, { container: scroller })
      treeContainer().getBoundingClientRect = () => rect(0, WIDE_CHILD_COUNT * ROW_HEIGHT)

      act(() => {
        useEditorStore.setState({
          selectedNodeId: 'w-child-250',
          selectedNodeIds: ['w-child-250'],
        } as Parameters<typeof useEditorStore.setState>[0])
      })
      // The reveal is scheduled on the next frame, after the expand commits.
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      })

      expect(scroller.scrollToCalls.length).toBeGreaterThan(0)
      // Row 251 (body + 250 children before it), bottom-aligned into a 280px
      // viewport: (251 + 1) * 28 - 280.
      expect(scroller.scrollToCalls.at(-1)?.top).toBe(252 * ROW_HEIGHT - VIEWPORT_HEIGHT)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// 7 — a background page's subtree costs nothing off screen
// ---------------------------------------------------------------------------

describe('PageLayerSubtree — a many-frame board', () => {
  it('mounts zero rows while the page subtree is scrolled off screen', () => {
    const restore = stubRowHeights()
    try {
      const background = buildWidePage('page-2', 'b')
      loadSite([buildWidePage('page-1', 'w'), background], 'page-1')
      const scroller = makeScroller()
      render(<PageLayerSubtree page={background} />, { container: scroller })

      expect(mountedRowIds().length).toBeGreaterThan(0)

      // Push the whole subtree above the viewport.
      treeContainer().getBoundingClientRect = () =>
        rect(-(WIDE_CHILD_COUNT + 1) * ROW_HEIGHT - 500, (WIDE_CHILD_COUNT + 1) * ROW_HEIGHT)
      act(() => {
        scroller.dispatchEvent(new Event('scroll'))
      })

      expect(mountedRowIds()).toEqual([])
      // …but it still occupies its full height, so the page rows below it do
      // not jump.
      expect(spacerHeights().reduce((a, b) => a + b, 0)).toBe((WIDE_CHILD_COUNT + 1) * ROW_HEIGHT)
    } finally {
      restore()
    }
  })

  it('never reveals the canvas selection — a background page must not steal the scroll', () => {
    const restore = stubRowHeights()
    try {
      const background = buildWidePage('page-2', 'b')
      loadSite([buildWidePage('page-1', 'w'), background], 'page-1')
      const scroller = makeScroller()
      render(<PageLayerSubtree page={background} />, { container: scroller })

      act(() => {
        useEditorStore.setState({
          selectedNodeId: 'b-child-250',
          selectedNodeIds: ['b-child-250'],
        } as Parameters<typeof useEditorStore.setState>[0])
      })

      expect(scroller.scrollToCalls).toHaveLength(0)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// 8 — the wiring windowing must not have dropped
// ---------------------------------------------------------------------------

describe('Layers tree — inherited wiring', () => {
  it('still opens the layer context menu, which hosts ConstraintNotice', () => {
    loadSite([buildWidePage('page-1', 'w')], 'page-1')
    render(<DomPanel />)

    const row = screen.getByTestId('dom-tree-item-w-child-0')
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 })
    expect(screen.getByRole('menu')).toBeDefined()

    // The notice itself is `LayerNodeContextMenu`'s (base branch, panel-10);
    // this asserts the row still mounts that menu rather than a local one.
    const source = readFileSync(TREE_NODE_SOURCE_PATH, 'utf8')
    expect(source).toContain('LayerNodeContextMenu')
  })

  it('still renames inline from a double click', () => {
    loadSite([buildWidePage('page-1', 'w')], 'page-1')
    render(<DomPanel />)

    fireEvent.doubleClick(screen.getByTestId('dom-tree-item-w-child-0'))
    const input = screen.getByRole('textbox', { name: /rename/i }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed Layer' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useEditorStore.getState().site?.pages[0].nodes['w-child-0'].label).toBe('Renamed Layer')
  })
})
