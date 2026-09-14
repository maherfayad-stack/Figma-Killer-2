/**
 * useSizingParentLayout — previously zero dedicated test coverage (P5,
 * STATE.md `panel-26`'s own Files section disclosed this as real, new
 * scope). Covers every branch of `SizingParentResolution`: no selection, a
 * parent outside this file's tree, a resolved parent layout (portal mode),
 * the pre-existing "no live canvas frame" reason, and the new
 * "Measuring the live frame…" reason this ticket adds for a genuinely
 * in-flight Tier 2 (bridge-mode) measurement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { useSizingParentLayout } from './useSizingParentLayout'
import { makeNode, makePage, makeSite } from '../../../../../__tests__/fixtures'
import '@modules/base/index'

const PARENT_ID = 'parent-1'
const CHILD_ID = 'child-1'
const BREAKPOINT_ID = 'desktop'

function loadPageWithParentAndChild() {
  const rootId = 'root'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [PARENT_ID] }),
      [PARENT_ID]: makeNode({ id: PARENT_ID, moduleId: 'base.div', children: [CHILD_ID] }),
      [CHILD_ID]: makeNode({ id: CHILD_ID, moduleId: 'base.div' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: CHILD_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
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

function registerPortalFrameForParent(display: string, flexDirection: string) {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument!
  frameDoc.body.setAttribute('data-breakpoint-id', BREAKPOINT_ID)
  frame.setAttribute('data-breakpoint-id', BREAKPOINT_ID)
  const el = frameDoc.createElement('div')
  el.setAttribute('data-node-id', PARENT_ID)
  el.style.display = display
  el.style.flexDirection = flexDirection
  frameDoc.body.appendChild(el)
  const adapter = new PortalFrameAdapter(frameDoc)
  registerFrameAdapter(frame, adapter)
  cleanupFns.push(() => {
    unregisterFrameAdapter(frame)
    adapter.dispose()
  })
}

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

describe('useSizingParentLayout', () => {
  it('reports "No element is selected." when nothing is selected', () => {
    const { result } = renderHook(() => useSizingParentLayout())
    expect(result.current.layout).toBeNull()
    expect(result.current.reason).toBe('No element is selected.')
  })

  it("reports the parent-outside-this-file reason when the selection has no parent in this tree", () => {
    useEditorStore.setState({
      site: makeSite({
        pages: [
          makePage({
            id: 'page-1',
            rootNodeId: CHILD_ID,
            nodes: { [CHILD_ID]: makeNode({ id: CHILD_ID, moduleId: 'base.div' }) },
          }),
        ],
      }),
      activePageId: 'page-1',
      selectedNodeId: CHILD_ID,
    } as Parameters<typeof useEditorStore.setState>[0])

    const { result } = renderHook(() => useSizingParentLayout())
    expect(result.current.layout).toBeNull()
    expect(result.current.reason).toBe(
      "This element's parent lives outside this file, so how it gets laid out isn't knowable here.",
    )
  })

  it('resolves the real layout from a live portal-mode parent element', () => {
    loadPageWithParentAndChild()
    registerPortalFrameForParent('flex', 'column')

    const { result } = renderHook(() => useSizingParentLayout())
    expect(result.current.layout).toEqual({ display: 'flex', flexDirection: 'column' })
    expect(result.current.reason).toBeUndefined()
  })

  it('defaults flexDirection to "row" when the computed value is empty', () => {
    loadPageWithParentAndChild()
    registerPortalFrameForParent('flex', '')

    const { result } = renderHook(() => useSizingParentLayout())
    expect(result.current.layout).toEqual({ display: 'flex', flexDirection: 'row' })
  })

  it('reports the "no live canvas frame" reason when the parent exists but renders nowhere', () => {
    loadPageWithParentAndChild()

    const { result } = renderHook(() => useSizingParentLayout())
    expect(result.current.layout).toBeNull()
    expect(result.current.reason).toBe(
      "Can't read the parent's layout — no live canvas frame is rendering it yet.",
    )
  })

  it('reports "Measuring the live frame…" while a Tier 2 bridge measurement for the parent is in flight', () => {
    loadPageWithParentAndChild()
    registerNeverAnsweringBridgeFrame()

    const { result } = renderHook(() => useSizingParentLayout())
    expect(result.current.layout).toBeNull()
    expect(result.current.reason).toBe('Measuring the live frame…')
  })
})
