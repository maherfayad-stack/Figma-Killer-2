/**
 * AssetsPanel — the left-rail library that replaced the insert dialog.
 *
 * Carries the dialog tests' intent onto the panel: Visual Components are
 * listed and insertable through `insertComponentRef` (never a raw
 * `insertNode` with a VC-ref module id), auto-materialized internals never
 * appear, search narrows by name AND by keyword, and the favourite star pins
 * to the notch without inserting anything.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AssetsPanel } from '@site/panels/AssetsPanel'
import { useEditorStore } from '@site/store/store'
import { __resetAssetFavoritesForTests } from '@site/panels/AssetsPanel/assetsPrefs'
import { registry } from '@core/module-engine'
import type { VisualComponent } from '@core/visualComponents'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeVC(id: string, name: string, paramCount = 0): VisualComponent {
  const rootId = `root-${id}`
  return {
    id,
    name,
    tree: {
      rootNodeId: rootId,
      nodes: {
        [rootId]: {
          id: rootId,
          moduleId: 'base.body',
          props: {},
          children: [],
          breakpointOverrides: {},
          classIds: [],
        },
      },
    },
    params: Array.from({ length: paramCount }, (_, i) => ({
      id: `param-${i}`,
      name: `param${i}`,
      type: 'string' as const,
      defaultValue: '',
      required: false,
    })),
    breakpoints: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
  }
}

function loadSite(vcs: VisualComponent[] = []) {
  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: {
      'root-home': makeNode({ id: 'root-home', moduleId: 'base.body' }),
    },
  })

  useEditorStore.setState({
    site: makeSite({ pages: [home], files: [], visualComponents: vcs }),
    activePageId: 'page-home',
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  localStorage.clear()
  __resetAssetFavoritesForTests()
  globalThis.fetch = mock(async () => jsonResponse({ value: null })) as typeof fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeDocument: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

function search(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search assets' }), {
    target: { value },
  })
}

describe('AssetsPanel', () => {
  it('lists Visual Components as cards in Saved components', () => {
    loadSite([makeVC('vc-1', 'Hero Card', 2)])
    render(<AssetsPanel />)

    const card = document.querySelector('[data-asset-id="vc-1"]')
    expect(card).toBeTruthy()
    expect(card?.getAttribute('data-asset-kind')).toBe('component')
    expect(card?.textContent).toContain('Hero Card')
    expect(card?.textContent).toContain('2 params')
  })

  it('inserts a Visual Component through insertComponentRef', () => {
    loadSite([makeVC('vc-1', 'Hero Card')])
    render(<AssetsPanel />)

    fireEvent.click(document.querySelector('[data-asset-id="vc-1"]') as HTMLElement)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((item) => item.id === 'page-home')
    const refs = page
      ? Object.values(page.nodes).filter((n) => n.moduleId === 'base.visual-component-ref')
      : []
    expect(refs).toHaveLength(1)
    expect(refs[0]?.props.componentId).toBe('vc-1')
  })

  it('never offers the auto-materialized internals', () => {
    loadSite()
    render(<AssetsPanel />)

    for (const hidden of ['base.body', 'base.visual-component-ref', 'base.slot-instance', 'base.slot-outlet']) {
      expect(document.querySelector(`[data-asset-id="${hidden}"]`)).toBeNull()
    }
    // …while an intrinsic element IS offered.
    expect(document.querySelector('[data-asset-id="base.container"]')).toBeTruthy()
  })

  it('narrows the cards by name', () => {
    loadSite([makeVC('vc-1', 'Hero Card')])
    render(<AssetsPanel />)

    search('hero')

    expect(document.querySelector('[data-asset-id="vc-1"]')).toBeTruthy()
    expect(document.querySelector('[data-asset-id="base.container"]')).toBeNull()
  })

  it('finds a module by a keyword and says which keyword matched', () => {
    const container = registry.get('base.container')
    const originalKeywords = container?.keywords
    if (container) container.keywords = ['wrapper', 'box']
    try {
      loadSite()
      render(<AssetsPanel />)

      search('wrapper')

      const card = document.querySelector('[data-asset-id="base.container"]')
      expect(card).toBeTruthy()
      expect(card?.textContent).toContain('wrapper')
    } finally {
      if (container) container.keywords = originalKeywords
    }
  })

  it('reports an empty search honestly', () => {
    loadSite()
    render(<AssetsPanel />)

    search('zzzznothing')

    expect(screen.getByText('No matches')).toBeTruthy()
  })

  it('pins a card to the notch without inserting it', async () => {
    const calls: Array<{ init?: RequestInit }> = []
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init })
      if (init?.method === 'PUT') return jsonResponse({ value: JSON.parse(String(init.body)).value })
      return jsonResponse({ value: { favorites: [] } })
    }) as typeof fetch

    loadSite()
    render(<AssetsPanel />)

    const toggle = await screen.findByRole('button', { name: 'Add Text to notch favorites' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PUT')).toBe(true))

    const save = calls.find((call) => call.init?.method === 'PUT')
    expect(JSON.parse(String(save?.init?.body))).toEqual({
      value: { favorites: [{ kind: 'module', id: 'base.text' }] },
    })

    const page = useEditorStore.getState().site?.pages.find((item) => item.id === 'page-home')
    const textNodes = page
      ? Object.values(page.nodes).filter((node) => node.moduleId === 'base.text')
      : []
    expect(textNodes).toHaveLength(0)
  })

  it('remembers an insert in the Recent section', () => {
    loadSite()
    render(<AssetsPanel />)

    fireEvent.click(document.querySelector('[data-asset-id="base.text"]') as HTMLElement)

    expect(screen.getByRole('button', { name: /^Recent/ })).toBeTruthy()
  })

  // `speed-06` — the card is also a drag source, sharing `useCanvasInsertionDrag`
  // with the notch's own primitives.
  describe('dragging a card onto a frame', () => {
    function mountFrame() {
      const viewport = document.createElement('div')
      viewport.dataset.breakpointId = 'desktop'
      viewport.getBoundingClientRect = () => domRect({ x: 0, y: 0, width: 400, height: 400 })
      const container = document.createElement('section')
      container.dataset.nodeId = 'root-home'
      container.getBoundingClientRect = () => domRect({ x: 20, y: 20, width: 200, height: 120 })
      viewport.append(container)
      document.body.append(viewport)
      return viewport
    }

    function domRect(init: { x: number; y: number; width: number; height: number }): DOMRect {
      return {
        x: init.x, y: init.y, left: init.x, top: init.y,
        right: init.x + init.width, bottom: init.y + init.height,
        width: init.width, height: init.height, toJSON: () => ({}),
      } as DOMRect
    }

    afterEach(() => {
      document.body.querySelectorAll('[data-breakpoint-id]').forEach((el) => el.remove())
    })

    it('shows a drop preview while dragging, and a plain click still inserts at the current selection', async () => {
      loadSite()
      render(<AssetsPanel />)
      mountFrame()

      const card = document.querySelector('[data-asset-id="base.text"]') as HTMLElement
      expect(document.querySelector('[data-position]')).toBeNull()

      fireEvent.pointerDown(card, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 100, clientY: 60, pointerId: 1 })
      await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))

      const preview = document.querySelector('[data-position]')
      expect(preview).not.toBeNull()
      expect(preview?.textContent).toContain('Drop Text')

      fireEvent.pointerUp(window, { clientX: 100, clientY: 60, pointerId: 1 })

      // The drag's own release inserted — not a click on the card.
      expect(document.querySelector('[data-position]')).toBeNull()
      const page = useEditorStore.getState().site?.pages.find((item) => item.id === 'page-home')
      const textNodesAfterDrag = page ? Object.values(page.nodes).filter((n) => n.moduleId === 'base.text') : []
      expect(textNodesAfterDrag).toHaveLength(1)

      // The pointerup-triggered click suppression clears on the next tick —
      // a LATER, independent click still inserts.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
      fireEvent.click(card)
      const pageAfterClick = useEditorStore.getState().site?.pages.find((item) => item.id === 'page-home')
      const textNodesAfterClick = pageAfterClick ? Object.values(pageAfterClick.nodes).filter((n) => n.moduleId === 'base.text') : []
      expect(textNodesAfterClick).toHaveLength(2)
    })

    it('does not insert twice when the pointerup-triggered click fires on the card that started the drag', () => {
      loadSite()
      render(<AssetsPanel />)
      mountFrame()

      const card = document.querySelector('[data-asset-id="base.text"]') as HTMLElement
      fireEvent.pointerDown(card, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 100, clientY: 60, pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: 100, clientY: 60, pointerId: 1 })
      // The browser fires a `click` on the element the pointer went down on.
      fireEvent.click(card)

      const page = useEditorStore.getState().site?.pages.find((item) => item.id === 'page-home')
      const textNodes = page ? Object.values(page.nodes).filter((n) => n.moduleId === 'base.text') : []
      expect(textNodes).toHaveLength(1)
    })
  })
})
