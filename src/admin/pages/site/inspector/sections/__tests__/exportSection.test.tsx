/**
 * ExportSection — Penpot's Export section (`STATE.md` `panel-25`, P3 item
 * 10). There is no old component-level test to port from (only
 * `nodeExportModel.test.ts`, covering the pure value logic reused verbatim
 * here) — every assertion below is written fresh, the same posture
 * `layerSection.test.tsx` took for its own from-scratch coverage.
 *
 * Covers:
 *   1. Gating — renders nothing with no selection, and nothing OUTSIDE a
 *      Studio session (a CMS page's root never ends in `:body`), matching
 *      the pre-migration mount's own `nodeId && selectedNode && activePageId
 *      && studioSession` gate (`ExportSection.tsx`'s own doc).
 *   2. Law 1 — no rows renders the empty header (title + a single "+"), no
 *      chevron, no toggle — `Section`'s `empty` prop, not the pre-migration
 *      file's `defaultOpen={false}` (a live Rule-2 gap this migration
 *      closes, see `ExportSection.tsx`'s own doc on the `empty`/`forceOpen`
 *      swap).
 *   3. Adding a row via the typed "+" menu reveals the resident row, and the
 *      populated section has NO working collapse toggle (`forceOpen`) —
 *      Rule 2 for the populated state too.
 *   4. The row list is local, per-node session state that resets when the
 *      selection moves to a different node — the `key={nodeId}` remount
 *      `ExportSection.tsx`'s own doc explains reproducing internally, since
 *      the manifest's own shared mount loop keys every entry by a constant
 *      section id, not by node.
 *   5. Copy CSS reads the winner's value out of provenance and writes it to
 *      the clipboard through the (mocked) client, never the network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'

const copyTextToClipboard = mock((_text: string) => Promise.resolve())
const copyPngToClipboard = mock(() => Promise.resolve())
const downloadNodePng = mock(() => Promise.resolve())
const downloadNodeSvg = mock(() => Promise.resolve())
const readNodeJsxSource = mock(() => Promise.resolve('<div />'))

// `mock.module` is process-wide and PERMANENT — `mock.restore()` does not undo
// it, and `bun test --parallel=4` gives each worker a process, not a file. The
// real namespace is snapshotted as a plain object BEFORE mocking (the
// namespace object itself is live and gets rewritten) and handed back in
// `afterAll`. Gated by `mock-module-must-restore.test.ts`.
const realNodeExportClient = { ...(await import('../../../panels/PropertiesPanel/nodeExportClient')) }

mock.module('../../../panels/PropertiesPanel/nodeExportClient', () => ({
  ...realNodeExportClient,
  copyTextToClipboard,
  copyPngToClipboard,
  downloadNodePng,
  downloadNodeSvg,
  readNodeJsxSource,
}))

afterAll(() => {
  mock.module('../../../panels/PropertiesPanel/nodeExportClient', () => realNodeExportClient)
})

const { ExportSection } = await import('../ExportSection')
const { makeSite, makePage, makeNode } = await import('../../../../../../__tests__/fixtures')
await import('@modules/base/index')

const NODE_ID = 'node-1'
const OTHER_NODE_ID = 'node-2'
const STUDIO_ROOT_ID = 'page-1:body'

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
  copyTextToClipboard.mockClear()
  copyPngToClipboard.mockClear()
  downloadNodePng.mockClear()
  downloadNodeSvg.mockClear()
  readNodeJsxSource.mockClear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

/** A Studio-parsed page (`rootNodeId` ends in `:body`) with two sibling nodes. */
function selectStudioNode(nodeId: string = NODE_ID, overrides: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: STUDIO_ROOT_ID,
    nodes: {
      [STUDIO_ROOT_ID]: makeNode({
        id: STUDIO_ROOT_ID,
        moduleId: 'base.body',
        children: [NODE_ID, OTHER_NODE_ID],
      }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div', label: 'Card', ...overrides }),
      [OTHER_NODE_ID]: makeNode({ id: OTHER_NODE_ID, moduleId: 'base.div', label: 'Other' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: nodeId,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** A CMS page — its root is a plain nanoid, never `:body`. */
function selectCmsNode() {
  const rootId = 'root'
  const page = makePage({
    id: 'page-cms',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-cms',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

async function addRow(label: string) {
  fireEvent.click(screen.getByTestId('export-section-add'))
  const menu = await screen.findByRole('menu', { name: 'Add export' })
  fireEvent.click(within(menu).getByText(label))
}

// ---------------------------------------------------------------------------
// 1. Gating
// ---------------------------------------------------------------------------

describe('ExportSection — gating', () => {
  it('renders nothing with no node selected', () => {
    const { container } = render(<ExportSection />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing outside a Studio session (a CMS page)', () => {
    selectCmsNode()
    const { container } = render(<ExportSection />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the section inside a Studio session', () => {
    selectStudioNode()
    render(<ExportSection />)
    expect(screen.getByText('Export')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 2. Law 1 — empty rest state
// ---------------------------------------------------------------------------

describe('ExportSection — empty rest state', () => {
  it('renders one static header row with a "+", no chevron, no working toggle', () => {
    selectStudioNode()
    render(<ExportSection />)

    expect(screen.getByText('Export')).toBeTruthy()
    expect(screen.getByTestId('export-section-add')).toBeTruthy()
    // `Section`'s `empty` branch renders no toggle button at all — only the
    // add trigger is a button in this header.
    expect(screen.queryAllByRole('button')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Adding a row — reveals the resident row, no manual collapse once populated
// ---------------------------------------------------------------------------

describe('ExportSection — populated state', () => {
  it('adding a PNG row reveals the resident row and the "N ready" meta', async () => {
    selectStudioNode()
    render(<ExportSection />)

    await addRow('PNG @2×')

    expect(screen.getByText('1 ready')).toBeTruthy()
    expect(screen.getByTestId('export-section-dot')).toBeTruthy()
    expect(screen.getByText('PNG')).toBeTruthy()
    expect(screen.getByText('2×')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export PNG 2×' })).toBeTruthy()
  })

  it('the populated header has no working collapse toggle (forceOpen, Rule 2)', async () => {
    selectStudioNode()
    render(<ExportSection />)
    await addRow('SVG')

    // The row is visible without any click on the header — clicking the
    // header again must not hide it (`forceOpen` suppresses the toggle).
    expect(screen.getByText('SVG')).toBeTruthy()
    fireEvent.click(screen.getByText('Export'))
    expect(screen.getByText('SVG')).toBeTruthy()
  })

  it('removing a row returns to the empty rest state', async () => {
    selectStudioNode()
    render(<ExportSection />)
    await addRow('PNG @1×')
    expect(screen.getByText('1 ready')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Remove/ }))
    expect(screen.queryByText('1 ready')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. Rows are per-node session state
// ---------------------------------------------------------------------------

describe('ExportSection — rows reset on selection change', () => {
  it('a row added for one node is gone once a different node is selected', async () => {
    selectStudioNode(NODE_ID)
    const { rerender } = render(<ExportSection />)
    await addRow('SVG')
    expect(screen.getByText('1 ready')).toBeTruthy()

    act(() => {
      selectStudioNode(OTHER_NODE_ID)
    })
    rerender(<ExportSection />)
    expect(screen.queryByText('1 ready')).toBeNull()
    expect(screen.getByText('Export')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 5. Copy CSS
// ---------------------------------------------------------------------------

describe('ExportSection — Copy CSS', () => {
  it('copies the declared properties, not a full computed bag', async () => {
    selectStudioNode(NODE_ID, { inlineStyles: { color: 'red' } })
    render(<ExportSection />)

    fireEvent.click(screen.getByTestId('export-section-add'))
    const menu = await screen.findByRole('menu', { name: 'Add export' })
    await act(async () => {
      fireEvent.click(within(menu).getByText('Copy CSS'))
      await Promise.resolve()
    })

    expect(copyTextToClipboard).toHaveBeenCalledTimes(1)
    const copied = copyTextToClipboard.mock.calls[0]?.[0] as string
    expect(copied).toContain('color: red;')
  })
})
