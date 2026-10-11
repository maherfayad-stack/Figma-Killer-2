/**
 * PosterFill — the background fill (SB-5): photographs the frames that were
 * never live, so the first zoom-out of a board shows pictures, not blanks.
 *
 * A frame gets its picture while it is live (`useFramePosterCapture`), so a
 * frame the user never had in view at a readable zoom, or panned past before
 * its picture was due, has none. This component finds the nearest such frame
 * to the viewport centre, mounts it as a live frame (the real injector chain,
 * so the picture is what the frame really renders), waits for its picture,
 * lets it go, and moves to the next. Always one at a time, and only once the
 * board has been quiet (`waitForBoardQuiet`): the user's hands come first.
 *
 * It mounts the frame by publishing its id to `posterFillTarget.ts`, which
 * `BoardFramesLayer` adds to its live set. That frame rides beside the cap
 * rather than taking a slot, for the seconds the picture takes.
 *
 * Skipped, by name:
 * - a Tier-2 board whose dev server is ready (`enabled` false): a live frame
 *   there is a cross-origin document against the project's dev server, which
 *   is not something to start per background picture (SB-8 owns bridge posters);
 * - a frame pinned to a locale other than the board's: its picture needs the
 *   localized page tree, which only a live frame fetches.
 * It never retries a frame whose picture did not arrive within
 * {@link FILL_TIMEOUT_MS}; that key stays blank until the page changes.
 * `posterFillTarget.ts` publishes whether it is still working (`data-poster-fill`).
 */
import { useContext, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Page } from '@core/page-tree'
import { FRAME_HEADER_HEIGHT, FRAME_HEIGHT, FRAME_WIDTH, mergePreviewAxes, type BoardFrame, type PreviewAxes } from '@core/studio-board'
import { lookupCanvasPageById, useEditorStore } from '@site/store/store'
import { selectActiveBoardFrames } from '@site/store/slices/boardSelectors'
import { CanvasViewportActionsContext } from '../CanvasContexts'
import { framePosters, selectPosterStyleSignature } from './framePosters'
import { waitForBoardQuiet } from './framePosterQueue'
import { posterKey } from './posterKey'
import { nextFillCandidate, type FillCandidate } from './posterFillPlan'
import { setPosterFillFrameId, setPosterFillState } from './posterFillTarget'
import { resolveFramesWithPages } from './resolveFramesWithPages'

/** How long one frame gets to produce its picture once mounted (its mount is staged, then settles, then is photographed). */
const FILL_TIMEOUT_MS = 8_000

const EMPTY_PAGES: (Page | null)[] = []

interface PosterFillProps {
  /** Frames the layer holds live right now (the fill target itself excluded), as a stable list. */
  liveFrameIds: readonly string[]
  enabled: boolean
}

export function PosterFill({ liveFrameIds, enabled }: PosterFillProps) {
  const frames = useEditorStore(selectActiveBoardFrames)
  const pages = useEditorStore(
    useShallow((s) => {
      const site = s.site
      if (!site) return EMPTY_PAGES
      return selectActiveBoardFrames(s).map((frame) => lookupCanvasPageById(site, frame.pageId))
    }),
  )
  const styleSignature = useEditorStore(selectPosterStyleSignature)
  const boardAxes = useEditorStore((s) => s.previewAxes)
  const viewportActions = useContext(CanvasViewportActionsContext)

  useEffect(() => {
    if (!enabled) {
      setPosterFillState('done')
      return
    }
    setPosterFillState('running')
    const controller = new AbortController()
    const candidates = fillCandidates(resolveFramesWithPages(frames, pages), styleSignature, boardAxes)
    void runPosterFill(candidates, new Set(liveFrameIds), () => viewCenter(viewportActions?.canvasRootRef.current ?? null), controller.signal).then((finished) => {
      if (finished) setPosterFillState('done')
    })
    return () => {
      controller.abort()
      setPosterFillFrameId(null)
    }
  }, [enabled, frames, pages, styleSignature, boardAxes, liveFrameIds, viewportActions])

  return null
}

/** The board-space point at the middle of the canvas viewport. */
function viewCenter(canvasRoot: HTMLElement | null): { x: number; y: number } {
  const { zoom, panX, panY } = useEditorStore.getState()
  const width = canvasRoot?.clientWidth ?? window.innerWidth
  const height = canvasRoot?.clientHeight ?? window.innerHeight
  return { x: (width / 2 - panX) / zoom, y: (height / 2 - panY) / zoom }
}

function fillCandidates(
  framesWithPages: readonly { frame: BoardFrame; page: Page }[],
  styleSignature: string,
  boardAxes: PreviewAxes,
): FillCandidate[] {
  const candidates: FillCandidate[] = []
  for (const { frame, page } of framesWithPages) {
    if (frame.axes?.locale && frame.axes.locale !== boardAxes.locale) continue
    const width = frame.width ?? FRAME_WIDTH
    const height = (frame.height ?? FRAME_HEIGHT) + FRAME_HEADER_HEIGHT
    candidates.push({
      frameId: frame.id,
      key: posterKey({ frameId: frame.id, page, styleSignature, axes: mergePreviewAxes(boardAxes, frame.axes), width }),
      centerX: frame.x + width / 2,
      centerY: frame.y + height / 2,
    })
  }
  return candidates
}

async function runPosterFill(
  candidates: readonly FillCandidate[],
  liveFrameIds: ReadonlySet<string>,
  getViewCenter: () => { x: number; y: number },
  signal: AbortSignal,
): Promise<boolean> {
  const failedKeys = new Set<string>()
  while (!signal.aborted) {
    if (!(await waitForBoardQuiet(signal))) return false
    const next = nextFillCandidate(candidates, {
      viewCenter: getViewCenter(),
      liveFrameIds,
      // A picture persisted by an earlier session counts: ask the store before mounting anything.
      hasPoster: (key) => framePosters.has(key),
      failedKeys,
    })
    if (!next) return true
    if (await framePosters.ensure(next.key)) continue
    if (signal.aborted) return false
    setPosterFillFrameId(next.frameId)
    const landed = await posterArrives(next.key, signal)
    setPosterFillFrameId(null)
    if (!landed && !signal.aborted) failedKeys.add(next.key)
  }
  return false
}

/** Resolves true when the store holds a picture for `key`; false on timeout or abort. */
function posterArrives(key: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (framePosters.has(key)) {
      resolve(true)
      return
    }
    const finish = (landed: boolean) => {
      unsubscribe()
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(landed)
    }
    const unsubscribe = framePosters.subscribe(() => {
      if (framePosters.has(key)) finish(true)
    })
    const timer = setTimeout(() => finish(false), FILL_TIMEOUT_MS)
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort)
  })
}
