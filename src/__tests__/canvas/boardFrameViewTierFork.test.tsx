/**
 * BoardFrameView — L8 Phase A (`perf-06`, STATE.md): the load-bearing
 * correctness property this whole work order stands or falls on. Tier 0/1
 * boards (`trust !== 'run-project'`) must render the EXACT SAME portal
 * `BreakpointFrame` this branch has always rendered — proven here, not just
 * eyeballed from the diff. Tier 2 (`trust === 'run-project'`) is the one new
 * branch, proven separately to route to `LiveBoardFrame` instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { BoardFrameView } from '@site/canvas/BoardFramesLayer/BoardFrameView'
import { useEditorStore } from '@site/store/store'
import { setStudioTrustTier } from '@site/studio/studioProjectTrust'
import { makeNode, makePage } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    boards: { version: 1, boards: [] },
    activeBoardId: null,
    boardsLoaded: false,
    boardsDirty: false,
    selectedFrameIds: [],
    selectedAnnotations: [],
    frameDefaults: {},
    zoom: 1,
    panX: 0,
    panY: 0,
    boardSnapGuides: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
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
  // Neither branch under test needs a real network round trip — Tier 0/1
  // never calls `useLiveOrigin`/`useDevServerReadiness` at all (this IS the
  // property under test), and the Tier-2 assertion only checks which
  // component mounted, not what it resolves to. Stubbed so a stray
  // `console.error` from an unmockable relative fetch doesn't dirty the
  // test output.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ liveOrigin: null }), { status: 200 })) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  setStudioTrustTier('static')
})

function renderFrame() {
  const button = makeNode({ id: 'cta', moduleId: 'base.button' })
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: [button.id] })
  const page = makePage({ id: 'home', rootNodeId: root.id, nodes: { [root.id]: root, [button.id]: button } })
  const frame = { id: 'frame-1', pageId: page.id, x: 0, y: 0 }

  return render(
    <BoardFrameView
      frame={frame}
      page={page}
      x={0}
      y={0}
      width={1024}
      height={800}
      hasManualHeight={false}
      isActive={false}
      isSelected={false}
      isOnScreen
    />,
  )
}

describe('BoardFrameView — Tier 0/1 is byte-for-byte unaffected', () => {
  it('renders the plain portal BreakpointFrame — no LiveBoardFrame, no bridge iframe, no `src`-mode iframe anywhere', () => {
    // Default trust tier ('static') — every existing board today.
    const { container } = renderFrame()

    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.hasAttribute('srcdoc')).toBe(true)
    expect(iframe?.hasAttribute('src')).toBe(false)

    // The one marker `LiveBoardFrame` mounts and nothing else does.
    expect(container.querySelector('[data-testid="live-board-frame-bridge"]')).toBeNull()
  })
})

describe('BoardFrameView — Tier 2 routes to LiveBoardFrame', () => {
  it('mounts LiveBoardFrame (bridge container present) once trust === "run-project"', () => {
    setStudioTrustTier('run-project')
    const { container } = renderFrame()

    expect(container.querySelector('[data-testid="live-board-frame-bridge"]')).not.toBeNull()
  })
})
