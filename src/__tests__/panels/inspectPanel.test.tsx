/**
 * InspectPanel — the Inspect tab's "what actually rendered" view. Previously
 * zero dedicated test coverage (P5, STATE.md `panel-26`'s own Files section
 * disclosed this as real, new scope, not a shape-unwrap edit).
 *
 * Covers the panel's 4-way empty/loading/rendered branch, since the loading
 * branch (`isLoading && !model` -> "Measuring…") is genuinely new product
 * surface this ticket adds, not a reuse of another file's fixture:
 *
 *   1. No selection at all -> "Select an element to inspect."
 *   2. A selection with a Tier 2 bridge measurement in flight, nothing
 *      resolved yet -> "Measuring…"
 *   3. A selection rendered nowhere (no canvas frame at all) -> "Not
 *      currently rendered on the canvas."
 *   4. A selection with a real rendered element (portal mode) -> the actual
 *      Colors/Typography/Box model/CSS sections.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { InspectPanel } from '@site/panels/InspectPanel/InspectPanel'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const BREAKPOINT_ID = 'desktop'

function siteWithSelectedNode() {
  const rootId = 'root'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div' }),
    },
  })
  return makeSite({ pages: [page] })
}

let cleanupFns: Array<() => void> = []

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: BREAKPOINT_ID,
    activeConditionId: null,
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  for (const fn of cleanupFns) fn()
  cleanupFns = []
})

function selectNode() {
  useEditorStore.setState({
    site: siteWithSelectedNode(),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Registers a portal canvas frame that renders NODE_ID — the "rendered" case. */
function renderNodeInPortalFrame() {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument!
  frameDoc.body.setAttribute('data-breakpoint-id', BREAKPOINT_ID)
  frame.setAttribute('data-breakpoint-id', BREAKPOINT_ID)
  const el = frameDoc.createElement('div')
  el.setAttribute('data-node-id', NODE_ID)
  frameDoc.body.appendChild(el)
  const adapter = new PortalFrameAdapter(frameDoc)
  registerFrameAdapter(frame, adapter)
  cleanupFns.push(() => {
    unregisterFrameAdapter(frame)
    adapter.dispose()
  })
}

/** Registers a bridge canvas frame for BREAKPOINT_ID whose channel never answers a `measure` request — the "Measuring…" case. */
function registerNeverAnsweringBridgeFrame() {
  const frame = document.createElement('iframe')
  frame.setAttribute('data-breakpoint-id', BREAKPOINT_ID)
  document.body.appendChild(frame)
  const channel: BridgeFrameChannel = {
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const adapter = new BridgeFrameAdapter({
    channel,
    frameOrigin: 'https://live.studio.test',
    measureTimeoutMs: 60_000,
  })
  registerFrameAdapter(frame, adapter)
  cleanupFns.push(() => {
    unregisterFrameAdapter(frame)
    adapter.dispose()
  })
}

describe('InspectPanel', () => {
  it('shows the empty-selection message when nothing is selected', () => {
    render(<InspectPanel />)
    expect(screen.getByText('Select an element to inspect.')).toBeTruthy()
  })

  it('shows "Measuring…" while a Tier 2 bridge measurement is in flight and nothing has resolved yet', () => {
    selectNode()
    registerNeverAnsweringBridgeFrame()

    render(<InspectPanel />)
    expect(screen.getByText('Measuring…')).toBeTruthy()
  })

  it('shows the not-rendered message when the selected node has no canvas frame at all', () => {
    selectNode()

    render(<InspectPanel />)
    expect(screen.getByText('Not currently rendered on the canvas.')).toBeTruthy()
  })

  it('renders the real sections once the node has a rendered element (portal mode)', () => {
    selectNode()
    renderNodeInPortalFrame()

    render(<InspectPanel />)
    expect(screen.queryByText('Select an element to inspect.')).toBeNull()
    expect(screen.queryByText('Measuring…')).toBeNull()
    expect(screen.queryByText('Not currently rendered on the canvas.')).toBeNull()
    expect(screen.getByText('Typography')).toBeTruthy()
    expect(screen.getByText('Box model')).toBeTruthy()
  })
})
