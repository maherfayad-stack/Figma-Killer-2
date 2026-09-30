/**
 * The mounted-frame BUDGET, asserted against the rendered DOM rather than
 * the pure policy — and the tie between `framePool.ts`'s `FRAME_MOUNT_ATTR`
 * and the `data-frame-mount` attribute `BoardFrameView` spells out in JSX
 * (JSX cannot take a computed attribute name without a spread, so the two
 * spellings can only be held together by a test that reads one through the
 * other).
 *
 * This is the gate `perf-9` added so the pool cannot quietly stop bounding
 * anything. It scripts a pan across a 24-frame board and asserts, at every
 * step, that the number of frames actually holding an iframe never exceeds
 * `framePoolBudget(cost, <frames on screen>)` — for BOTH frame costs, from
 * the one module that now decides it. Measured on the base commit before the
 * merge: portal peaked at 8 mounted frames at zoom 1 and 12 at zoom 0.25;
 * live peaked at 8 frames / 16 iframes (a `LiveBoardFrame` is a fallback
 * document AND a bridge iframe until it reports ready). Those are the same
 * numbers this gate reproduces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { createBoard, type BoardsFile } from '@core/studio-board'
import { BoardFramesLayer } from '@site/canvas/BoardFramesLayer'
import {
  framePoolBudget,
  readFrameMountReason,
  type FrameMountCost,
} from '@site/canvas/BoardFramesLayer/framePool'
import { useEditorStore } from '@site/store/store'
import { setStudioTrustTier } from '@site/studio/studioProjectTrust'
import { __resetDevServerReadinessForTests } from '@site/studio/useDevServerReadiness'
import { useAdminUi } from '@admin/state/adminUi'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch
const PROJECT_DIR = '/workspace/pool-board'

/** What `/dev-server/status` answers. `'ready'` is what makes a Tier-2 board's frames cost `'live'`. */
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
  onScreen: number
  pooled: number
  offscreen: number
  mountedBodies: number
}

function sample(container: HTMLElement): PanSample {
  const frames = [...container.querySelectorAll('[data-page-id]')]
  const reasons = frames.map((el) => readFrameMountReason(el))
  // Every frame answers, and answers through the module — this is the tie
  // between `FRAME_MOUNT_ATTR` and the attribute name written in JSX.
  expect(reasons.filter((r) => r === null)).toEqual([])
  return {
    onScreen: reasons.filter((r) => r === 'on-screen').length,
    pooled: reasons.filter((r) => r === 'pooled').length,
    offscreen: reasons.filter((r) => r === 'offscreen').length,
    mountedBodies: frames.filter((el) => el.querySelector('iframe')).length,
  }
}

/**
 * A `'live'` board is a Tier-2 board whose dev server answered `ready` — the
 * layer polls for that, so the pan starts once the poll has landed.
 */
async function panAcrossBoard(cost: FrameMountCost, zoom: number): Promise<PanSample[]> {
  setStudioTrustTier(cost === 'live' ? 'run-project' : 'static')
  devServerPhase = cost === 'live' ? 'ready' : 'stopped'
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

describe('the mounted-frame budget, from the one module that decides it', () => {
  for (const [cost, zoom] of [
    ['portal', 1],
    ['portal', 0.25],
    ['live', 1],
    ['live', 0.25],
  ] as const) {
    it(`[${cost} @ zoom ${zoom}] never mounts more frames than framePoolBudget allows, panning a ${FRAME_COUNT}-frame board`, async () => {
      const samples = await panAcrossBoard(cost, zoom)
      expect(samples).toHaveLength(FRAME_COUNT)
      for (const s of samples) {
        const mounted = s.onScreen + s.pooled
        // The DOM agrees with the reason: a frame is mounted iff it says so.
        expect(s.mountedBodies).toBe(mounted)
        expect(s.onScreen + s.pooled + s.offscreen).toBe(FRAME_COUNT)
        expect(mounted).toBeLessThanOrEqual(framePoolBudget(cost, s.onScreen))
      }
      // The pan really did exercise the pool — otherwise the budget above is
      // asserted against a board that never evicted anything.
      expect(Math.max(...samples.map((s) => s.pooled))).toBeGreaterThan(0)
      expect(Math.max(...samples.map((s) => s.offscreen))).toBeGreaterThan(0)
    })
  }

  it('a live board never keeps more frames mounted than the same board would as a portal board', async () => {
    const live = Math.max(...(await panAcrossBoard('live', 0.25)).map((s) => s.onScreen + s.pooled))
    cleanup()
    resetStore()
    __resetDevServerReadinessForTests()
    const portal = Math.max(...(await panAcrossBoard('portal', 0.25)).map((s) => s.onScreen + s.pooled))
    expect(live).toBeLessThanOrEqual(portal)
  })

  it('a Tier-2 board whose dev server is not up keeps the portal headroom, so a departed frame stays mounted for its poster (P6-C)', async () => {
    // Its frames are same-origin fallbacks until the server is ready. Under
    // the live budget (no headroom) a frame leaving a full screen was
    // evicted on the spot, before the poster queue could ever rasterize it.
    setStudioTrustTier('run-project')
    devServerPhase = 'stopped'
    seedBoard()
    const { container } = render(<BoardFramesLayer />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    let sawPortalHeadroom = false
    for (let step = 0; step < FRAME_COUNT; step += 1) {
      act(() => {
        useEditorStore.setState({ panX: -step * FRAME_STRIDE * 0.25, panY: 0, zoom: 0.25 })
      })
      const s = sample(container)
      expect(s.onScreen + s.pooled).toBeLessThanOrEqual(framePoolBudget('portal', s.onScreen))
      if (s.onScreen + s.pooled > framePoolBudget('live', s.onScreen)) sawPortalHeadroom = true
    }
    expect(sawPortalHeadroom).toBe(true)
  })

  it('panning back to a pooled frame reuses its iframe — no new document', () => {
    setStudioTrustTier('static')
    seedBoard()
    const { container } = render(<BoardFramesLayer />)
    const frameEl = () => container.querySelector('[data-frame-id="f0"]')!

    act(() => { useEditorStore.setState({ panX: 0, panY: 0, zoom: 1 }) })
    expect(readFrameMountReason(frameEl())).toBe('on-screen')
    const originalIframe = frameEl().querySelector('iframe')
    expect(originalIframe).not.toBeNull()

    // Pan two strides away: f0 is off screen but still inside the pool.
    act(() => { useEditorStore.setState({ panX: -2 * FRAME_STRIDE, panY: 0, zoom: 1 }) })
    expect(readFrameMountReason(frameEl())).toBe('pooled')
    expect(frameEl().querySelector('iframe')).toBe(originalIframe)

    // ...and back. Same element: nothing was torn down, so nothing reparsed.
    act(() => { useEditorStore.setState({ panX: 0, panY: 0, zoom: 1 }) })
    expect(readFrameMountReason(frameEl())).toBe('on-screen')
    expect(frameEl().querySelector('iframe')).toBe(originalIframe)
  })
})
