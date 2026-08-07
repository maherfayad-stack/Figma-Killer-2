/**
 * Integration-gap coverage (D1): `CanvasRulers` renders pure geometry that is
 * unit-tested in isolation (`CanvasRulers/__tests__/rulerGeometry.test.ts`) —
 * this file proves the OTHER half: `CanvasRoot` actually mounts it. A
 * component that renders correctly but is never mounted is not shipped
 * (see `canvas-engineer`'s "integration-gap protocol").
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { useEditorStore } from '@site/store/store'
import { DEFAULT_MODULE_INSERTER_PREFERENCE } from '@core/persistence/userPreferences'
import { __resetModuleInserterPreferenceForTests } from '@site/module-picker/useModuleInserterPreference'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
  __resetModuleInserterPreferenceForTests()
})

beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
  __resetModuleInserterPreferenceForTests()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/admin/api/cms/me/preferences/module-inserter')) {
      return new Response(JSON.stringify({ value: DEFAULT_MODULE_INSERTER_PREFERENCE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch

  const rootId = 'root'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: { [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [] }) },
  })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    runScripts: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('CanvasRoot mounts CanvasRulers (D1 integration gap)', () => {
  it('renders the rulers shell + both ruler canvases in design mode', () => {
    render(<CanvasRoot />)

    expect(screen.getByTestId('canvas-rulers')).toBeDefined()
    expect(screen.getByTestId('canvas-ruler-h')).toBeDefined()
    expect(screen.getByTestId('canvas-ruler-v')).toBeDefined()
  })

  it('does not render rulers in live mode (no pan/zoom to rule against)', () => {
    useEditorStore.setState({ canvasView: 'live' } as Parameters<typeof useEditorStore.setState>[0])
    render(<CanvasRoot />)

    expect(screen.queryByTestId('canvas-rulers')).toBeNull()
  })

  it('does not render rulers when the canvas is non-editable', () => {
    render(<CanvasRoot editable={false} />)

    expect(screen.queryByTestId('canvas-rulers')).toBeNull()
  })
})
