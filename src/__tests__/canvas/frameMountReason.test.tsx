/**
 * The live-frame CAP, asserted against the rendered DOM rather than the pure
 * policy, and the tie between `frameMount.ts`'s `FRAME_MOUNT_ATTR` and the
 * `data-frame-mount` attribute `BoardFrameView` spells out in JSX (JSX cannot
 * take a computed attribute name without a spread, so the two spellings can
 * only be held together by a test that reads one through the other).
 *
 * It scripts a pan across a 24-frame board and asserts, at every step, that
 * the number of frames actually holding an iframe never exceeds the cap
 * (`liveFrameCap.ts`), that the DOM agrees with the stamped reason, and that
 * below the poster zoom no frame is live at all (SB-5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { BoardFramesLayer } from '@site/canvas/BoardFramesLayer'
import { readFrameMountReason } from '@site/canvas/BoardFramesLayer/frameMount'
import { LIVE_CAP_BRIDGE, LIVE_CAP_FLOOR, POSTER_ZOOM, computeLiveFrameCap } from '@site/canvas/BoardFramesLayer/liveFrameCap'
import { useEditorStore } from '@site/store/store'
import { setStudioTrustTier } from '@site/studio/studioProjectTrust'
import { __resetDevServerReadinessForTests } from '@site/studio/useDevServerReadiness'
import { useAdminUi } from '@admin/state/adminUi'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch
const PROJECT_DIR = '/workspace/pool-board'

/** What `/dev-server/status` answers. `'ready'` is what puts a Tier-2 board on the bridge cap. */
let devServerPhase: 'stopped' | 'ready' = 'stopped'

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
  // Tier 2's `LiveBoardFrame` asks the server for a live origin on mount.
  // Stubbed so the assertion under test isn't racing a rejected relative
  // fetch; `null` keeps every frame on its Tier-0 fallback, which is exactly
  // the state a board is in before a dev server answers.
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes('/dev-server/status')
      ? new Response(JSON.stringify({ phase: devServerPhase, pid: null, startedAt: null, log: '' }), { status: 200 })
      : new Response(JSON.stringify({ liveOrigin: null }), { status: 200 })) as typeof fetch
  __resetDevServerReadinessForTests()
  useAdminUi.setState({ studioProject: { dir: PROJECT_DIR, name: 'pool-board' } })
})

afterEach(() => {
  cleanup()
  resetStore()
  globalThis.fetch = originalFetch
  setStudioTrustTier('static')
  __resetDevServerReadinessForTests()
  useAdminUi.setState({ studioProject: null })
  devServerPhase = 'stopped'
})

const FRAME_COUNT = 24
/** Board-space stride between frames — wider than one frame, so a pan changes membership. */
const FRAME_STRIDE = 1200

function seedBoard() {
  const pages = Array.from({ length: FRAME_COUNT }, (_, i) =>
    makePage({
      id: `p${i}`,
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t'] }),
        t: makeNode({ id: 't', moduleId: 'base.text', props: { text: `page ${i}` } }),
      },
    }),
  )
  const board = createBoard('board-1', 'Board 1')
  board.frames = pages.map((page, i) => ({ id: `f${i}`, pageId: page.id, x: i * FRAME_STRIDE, y: 0 }))
  const file: BoardsFile = { version: 1, boards: [board] }
  useEditorStore.setState({
    site: makeSite({ pages }),
    activePageId: pages[0]!.id,
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadBoards(file)
  useEditorStore.setState({ activeBoardId: board.id })
}

interface PanSample {
  live: number
  poster: number
  cold: number
  mountedBodies: number
}

function sample(container: HTMLElement): PanSample {
  const frames = [...container.querySelectorAll('[data-page-id]')]
  const reasons = frames.map((el) => readFrameMountReason(el))
  // Every frame answers, and answers through the module: this is the tie
  // between `FRAME_MOUNT_ATTR` and the attribute name written in JSX.
  expect(reasons.filter((r) => r === null)).toEqual([])
  return {
    live: reasons.filter((r) => r === 'live').length,
    poster: reasons.filter((r) => r === 'poster').length,
    cold: reasons.filter((r) => r === 'cold').length,
    mountedBodies: frames.filter((el) => el.querySelector('iframe')).length,
  }
}

/**
 * A bridge board is a Tier-2 board whose dev server answered `ready`; the
 * layer polls for that, so the pan starts once the poll has landed.
 */
async function panAcrossBoard(bridge: boolean, zoom: number): Promise<PanSample[]> {
  setStudioTrustTier(bridge ? 'run-project' : 'static')
  devServerPhase = bridge ? 'ready' : 'stopped'
  seedBoard()
  const { container } = render(<BoardFramesLayer />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const samples: PanSample[] = []
  for (let step = 0; step < FRAME_COUNT; step += 1) {
    act(() => {
      useEditorStore.setState({ panX: -step * FRAME_STRIDE * zoom, panY: 0, zoom })
    })
    samples.push(sample(container))
  }
  return samples
}

const PORTAL_CAP = computeLiveFrameCap({})

describe('the live-frame cap, from the one module that decides it', () => {
  it('panning a 24-frame board at zoom 1 keeps in-view frames live and nothing else, never above the cap', async () => {
    const samples = await panAcrossBoard(false, 1)
    expect(samples).toHaveLength(FRAME_COUNT)
    for (const s of samples) {
      // The DOM agrees with the reason: a frame holds an iframe iff it says live.
      expect(s.mountedBodies).toBe(s.live)
      expect(s.live + s.poster + s.cold).toBe(FRAME_COUNT)
      expect(s.live).toBeLessThanOrEqual(PORTAL_CAP)
      // The stride is wider than the viewport, so at most the frame in view and a neighbour clipping its edge.
      expect(s.live).toBeLessThanOrEqual(3)
    }
    expect(Math.max(...samples.map((s) => s.live))).toBeGreaterThan(0)
    expect(Math.max(...samples.map((s) => s.cold))).toBeGreaterThan(0)
  })

  it(`below zoom ${POSTER_ZOOM} no frame is live: the whole board is pictures`, async () => {
    for (const s of await panAcrossBoard(false, POSTER_ZOOM - 0.1)) {
      expect(s.live).toBe(0)
      expect(s.mountedBodies).toBe(0)
    }
  })

  it('a Tier-2 board whose dev server is ready has its own, lower cap', async () => {
    expect(LIVE_CAP_BRIDGE).toBeLessThan(LIVE_CAP_FLOOR)
    for (const s of await panAcrossBoard(true, 1)) expect(s.live).toBeLessThanOrEqual(LIVE_CAP_BRIDGE)
  })

  it('a frame that has left the view is torn down, not kept', () => {
    setStudioTrustTier('static')
    seedBoard()
    const { container } = render(<BoardFramesLayer />)
    const frameEl = () => container.querySelector('[data-frame-id="f0"]')!

    act(() => { useEditorStore.setState({ panX: 0, panY: 0, zoom: 1 }) })
    expect(readFrameMountReason(frameEl())).toBe('live')
    expect(frameEl().querySelector('iframe')).not.toBeNull()

    act(() => { useEditorStore.setState({ panX: -2 * FRAME_STRIDE, panY: 0, zoom: 1 }) })
    expect(readFrameMountReason(frameEl())).toBe('cold')
    expect(frameEl().querySelector('iframe')).toBeNull()
  })

  it('selecting a frame far out of view promotes it to live, and releasing it lets it go', () => {
    setStudioTrustTier('static')
    seedBoard()
    const { container } = render(<BoardFramesLayer />)
    const far = () => container.querySelector('[data-frame-id="f20"]')!

    act(() => { useEditorStore.setState({ panX: 0, panY: 0, zoom: 1 }) })
    expect(readFrameMountReason(far())).toBe('cold')

    act(() => { useEditorStore.getState().selectFrame('p20') })
    expect(readFrameMountReason(far())).toBe('live')
    expect(far().querySelector('iframe')).not.toBeNull()

    act(() => { useEditorStore.getState().clearFrameSelection() })
    expect(readFrameMountReason(far())).toBe('cold')
  })

  it('a frame holding the selected layer is live even below the poster zoom', () => {
    setStudioTrustTier('static')
    seedBoard()
    const { container } = render(<BoardFramesLayer />)
    act(() => { useEditorStore.setState({ panX: 0, panY: 0, zoom: 0.1 }) })
    expect(container.querySelectorAll('iframe')).toHaveLength(0)

    act(() => {
      useEditorStore.setState({ activePageId: 'p5', selectedNodeIds: ['t'], selectedNodeId: 't', selectedNodeFrameId: 'f5' })
    })
    expect(readFrameMountReason(container.querySelector('[data-frame-id="f5"]'))).toBe('live')
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
  })
})
