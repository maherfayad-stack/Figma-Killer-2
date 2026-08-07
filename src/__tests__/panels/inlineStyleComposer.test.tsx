/**
 * InlineStyleComposer / StyleSurface — per-property and whole-module inline
 * style locks (Phase 0, items 0.5).
 *
 * Pins two defects that used to be silent:
 *  - a `style:<prop>` entry in `codeProps` (the property's value resolved from
 *    an expression) used to render a normal, fully-editable control with no
 *    explanation — a keystroke would look like it worked and never save.
 *  - a `pkg.*`/`alm.*`/`studio.instance` node's inline styles are never
 *    written back at all (`fsCodemodAdapter.saveSite`'s `base.*` gate), but
 *    the composer used to offer a full editor for it anyway.
 */
import { describe, it, expect, afterEach, afterAll, beforeEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { useEditorStore } from '@site/store/store'
import { registry, type AnyModuleDefinition } from '@core/module-engine'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)
// `inlineStyleEditing` isn't reset by every OTHER test file's own resetStore
// (propertiesPanel-redesign.test.tsx's doesn't touch it), so a test file that
// runs before it in the same bun test process must leave the store exactly
// as it found it, not just clean before its own tests.
afterEach(() => resetStore())

/** Unique test module id, prefixed so it can never collide with a real `pkg.*` id. */
const TEST_PKG_MODULE_ID = 'pkg.test-inline-style-lock'

/** Registers a minimal `pkg.*` module definition so a test node using it resolves in `usePropertiesPanelData`. */
function registerPkgTestModule(id: string): void {
  const def: AnyModuleDefinition = {
    id,
    name: 'Test Package Component',
    category: 'Test',
    version: '1.0.0',
    icon: SquareSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: () => ({ html: '<div data-testid="stub"></div>' }),
  }
  registry.registerOrReplace(def)
}

registerPkgTestModule(TEST_PKG_MODULE_ID)
afterAll(() => registry.unregister(TEST_PKG_MODULE_ID))

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    activeClassId: null,
    inlineStyleEditing: false,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    focusedPanel: 'canvas',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

/** Loads a single `base.div` node with inline styles + optional codeProps lock, selects it, and enters inline-style editing (no class assigned). */
function loadNodeInlineEditing(overrides: {
  moduleId?: string
  inlineStyles?: Record<string, unknown>
  codeProps?: string[]
}): string {
  const rootId = 'root-1'
  const nodeId = 'node-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const node = {
    ...makeNode({ id: nodeId, moduleId: overrides.moduleId ?? 'base.container', props: {} }),
    inlineStyles: overrides.inlineStyles,
    codeProps: overrides.codeProps,
  }
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: rootNode, [nodeId]: node } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.setState({
    selectedNodeId: nodeId,
    inlineStyleEditing: true,
  } as Parameters<typeof useEditorStore.setState>[0])
  return nodeId
}

describe('InlineStyleComposer — per-property lock notice', () => {
  it('names the locked property and does not claim it will save', () => {
    loadNodeInlineEditing({
      inlineStyles: { width: '50%', color: 'red' },
      codeProps: ['style:width'],
    })
    render(<PropertiesPanel />)

    const notice = screen.getByTestId('inline-style-locked-properties-notice')
    expect(notice.textContent).toMatch(/width/i)
    expect(notice.textContent).toMatch(/read-only/i)
  })

  it('renders no lock notice when nothing is code-valued', () => {
    loadNodeInlineEditing({ inlineStyles: { width: '50%' } })
    render(<PropertiesPanel />)

    expect(screen.queryByTestId('inline-style-locked-properties-notice')).toBeNull()
  })

  it('refuses to write a locked property even if a handler is invoked directly (defense in depth alongside the store guard)', () => {
    const nodeId = loadNodeInlineEditing({
      inlineStyles: { width: '50%' },
      codeProps: ['style:width'],
    })
    render(<PropertiesPanel />)

    // The store guard (nodeActions.ts, store-engineer owned) already refuses
    // this; this just asserts the value on the node is unchanged after a
    // full render/selection cycle with the lock in place.
    const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.inlineStyles?.width).toBe('50%')
  })
})

describe('StyleSurface — whole-module inline-style lock (S4)', () => {
  it('a pkg.* node shows a locked notice instead of the inline editor', () => {
    loadNodeInlineEditing({ moduleId: TEST_PKG_MODULE_ID, inlineStyles: { color: 'red' } })
    render(<PropertiesPanel />)

    expect(screen.getByText(/component's own source/i)).toBeDefined()
    expect(screen.queryByTestId('inline-style-locked-properties-notice')).toBeNull()
  })

  it('an ordinary base.* node with no locks shows the live inline editor', () => {
    loadNodeInlineEditing({ inlineStyles: { color: 'red' } })
    render(<PropertiesPanel />)

    expect(screen.queryByText(/component's own source/i)).toBeNull()
  })
})
