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
import { makeNode, makePage, makeSite } from '../fixtures'
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
  // Tier 2's `LiveBoardFrame` asks the server for a live origin on mount.
  // Stubbed so the assertion under test isn't racing a rejected relative
  // fetch; `null` keeps every frame on its Tier-0 fallback, which is exactly
  // the state a board is in before a dev server answers.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ liveOrigin: null }), { status: 200 })) as typeof fetch
})

afterEach(() => {
  cleanup()
  resetStore()
  globalThis.fetch = originalFetch
  setStudioTrustTier('static')
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

function panAcrossBoard(cost: FrameMountCost, zoom: number): PanSample[] {
  setStudioTrustTier(cost === 'live' ? 'run-project' : 'static')
  seedBoard()
  const { container } = render(<BoardFramesLayer />)
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
    it(`[${cost} @ zoom ${zoom}] never mounts more frames than framePoolBudget allows, panning a ${FRAME_COUNT}-frame board`, () => {
      const samples = panAcrossBoard(cost, zoom)
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

  it('a live board never keeps more frames mounted than the same board would as a portal board', () => {
    const live = Math.max(...panAcrossBoard('live', 0.25).map((s) => s.onScreen + s.pooled))
    cleanup()
    resetStore()
    const portal = Math.max(...panAcrossBoard('portal', 0.25).map((s) => s.onScreen + s.pooled))
    expect(live).toBeLessThanOrEqual(portal)
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
