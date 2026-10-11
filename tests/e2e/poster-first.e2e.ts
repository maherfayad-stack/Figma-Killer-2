import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { profileGesture, readBoardCounts } from './helpers/canvasPerf'
import { readDomCounters } from './helpers/cdpTrace'
import { LARGE_BOARD_SHAPE, largeBoardPageId, openLargeBoardAtWorkingZoom, SCALE_BOARD_SHAPE, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { removeFixtureProject, type FixtureProject } from './helpers/studioFixtureProject'

/**
 * Poster-first mounting (SB-5): a frame is a live iframe only while the user is working in it or it is in view at a
 * readable zoom (up to the adaptive cap); every other frame shows its picture.
 *
 * Two kinds of case:
 *  - the RECORDER (`measure`), which puts a number on the 100 x 140 corpus: live iframes at rest and zoomed out, heap
 *    and DOM counters over 20 zoom cycles, pan and zoom p95, and how long a zoom-out takes to show pictures. Set
 *    `POSTER_FIRST_LABEL=before|after` to name the dump in `.tmp/poster-first/`; `POSTER_FIRST_RECORD_ONLY=1` skips
 *    the assertions (used to record the pre-change tree).
 *  - the GATES: zoom out and every frame shows a picture, never a blank; one press on a poster makes it live AND
 *    selected.
 *
 * Run: `E2E_VITE_MODE=preview bun run test:e2e tests/e2e/poster-first.e2e.ts` (the production bundle is the product).
 */

test.use({ viewport: { width: 1920, height: 1080 } })
test.describe.configure({ timeout: 480_000 })

const LABEL = process.env.POSTER_FIRST_LABEL ?? 'run'
const RECORD_ONLY = process.env.POSTER_FIRST_RECORD_ONLY === '1'
const ZOOM_CYCLES = 20
/** The floor of the adaptive cap (`liveFrameCap.ts`) plus the one transient background-fill frame. */
const MAX_LIVE_AT_REST = 21
/** A 20-frame board is small enough for the background fill to finish inside this window. */
const SMALL_BOARD_FRAMES = 20
const ALL_PICTURES_BY_MS = 90_000
/** A cold 100-frame board zoomed all the way out shows a picture in every frame in view by this long (measured 3.7-3.9 s). */
const COLD_ZOOM_OUT_PICTURES_BY_MS = 15_000

function dump(name: string, value: unknown): void {
  mkdirSync('.tmp/poster-first', { recursive: true })
  writeFileSync(`.tmp/poster-first/${name}.json`, JSON.stringify(value, null, 2))
}

function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[sb-5] ${label}: ${value}`)
}

/**
 * Chromium latches a wheel sequence to its first target, so a stationary cursor that panned under an iframe
 * swallows the Ctrl+wheel that follows (measured: zoom stayed at 41% until the mouse moved). Each zoom therefore
 * starts from a cursor position it has not wheeled at yet.
 */
let zoomAnchorJitter = 0

async function wheelZoom(page: Page, canvasRoot: Locator, steps: number, deltaY: number): Promise<void> {
  const box = await canvasRoot.boundingBox()
  if (!box) throw new Error('the canvas root has no bounding box')
  zoomAnchorJitter = (zoomAnchorJitter + 1) % 4
  await page.mouse.move(box.x + box.width / 2 + zoomAnchorJitter * 3, box.y + box.height / 2 + zoomAnchorJitter)
  await page.keyboard.down('Control')
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(40)
  }
  await page.keyboard.up('Control')
}

async function zoomCycle(page: Page, canvasRoot: Locator): Promise<void> {
  await wheelZoom(page, canvasRoot, 12, 120)
  await wheelZoom(page, canvasRoot, 12, -120)
  await page.waitForTimeout(1500)
}

interface ViewCounts {
  inView: number
  live: number
  poster: number
  cold: number
  zoom: number
}

/** What every frame that intersects the canvas viewport shows right now. */
function readViewCounts(page: Page): Promise<ViewCounts> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="canvas-root"]')!.getBoundingClientRect()
    const counts = { inView: 0, live: 0, poster: 0, cold: 0, zoom: 0 }
    const layer = document.querySelector('[data-testid="canvas-transform-layer"]') as HTMLElement | null
    const matrix = layer ? new DOMMatrixReadOnly(getComputedStyle(layer).transform) : null
    counts.zoom = matrix ? matrix.a : 0
    for (const body of document.querySelectorAll('[data-testid="board-frame-body"]')) {
      const rect = body.getBoundingClientRect()
      if (rect.right < root.left || rect.left > root.right || rect.bottom < root.top || rect.top > root.bottom) continue
      counts.inView += 1
      if (body.querySelector('iframe[title^="Canvas frame"]')) counts.live += 1
      else if (body.querySelector('[data-testid="board-frame-poster"]')) counts.poster += 1
      else counts.cold += 1
    }
    return counts
  })
}

/**
 * Poll every 100 ms until no frame in the scope is a blank placeholder; returns ms to that point, or null on
 * timeout. `scope` 'view' is the frames intersecting the canvas, 'board' is every frame on the board.
 */
async function msUntilNoBlank(page: Page, timeoutMs: number, scope: 'view' | 'board' = 'view'): Promise<{ ms: number | null; last: ViewCounts }> {
  const startedAt = Date.now()
  const read = async (): Promise<ViewCounts> => {
    if (scope === 'view') return readViewCounts(page)
    const counts = await readBoardCounts(page)
    return { inView: counts.boardFrames, live: counts.mountedFrames, poster: counts.posters, cold: counts.placeholders, zoom: (await readViewCounts(page)).zoom }
  }
  let last = await read()
  while (Date.now() - startedAt < timeoutMs) {
    if (last.inView > 0 && last.cold === 0) return { ms: Date.now() - startedAt, last }
    await page.waitForTimeout(100)
    last = await read()
  }
  return { ms: null, last }
}

async function heapUsedBytes(page: Page): Promise<number> {
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('HeapProfiler.collectGarbage')
    await client.send('HeapProfiler.collectGarbage')
    await client.send('Performance.enable')
    const { metrics } = (await client.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }
    return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  } finally {
    await client.detach()
  }
}

test.describe('poster-first on the 100 x 140 corpus', () => {
  let fixture: FixtureProject
  test.beforeAll(() => {
    fixture = writeLargeBoardCorpus(SCALE_BOARD_SHAPE)
  })
  test.afterAll(() => {
    if (fixture) removeFixtureProject(fixture)
  })

  test('cold zoom-out: how long until nothing in view is blank', { tag: '@production-bundle' }, async ({ page }) => {
    // A board opened for the first time (no stored pictures), zoomed all the way out straight away.
    const { canvasRoot } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
    await wheelZoom(page, canvasRoot, 14, 120)
    const startedAt = Date.now()
    const first = await readViewCounts(page)
    const result = await msUntilNoBlank(page, 120_000)
    const counts = await readBoardCounts(page)
    dump(`${LABEL}-cold-${Date.now()}`, { first, result, counts, sinceZoomMs: Date.now() - startedAt })
    annotate('cold zoom-out, frames in view right after the wheel: live/poster/blank', `${first.live}/${first.poster}/${first.cold} of ${first.inView}`)
    annotate('cold zoom-out: ms until no frame in view is blank', result.ms === null ? `not within 120 s (${result.last.cold} blank)` : `${result.ms}`)
    annotate('cold zoom-out: iframes / pictures once settled', `${counts.liveIframes} / ${counts.posters}`)
    if (RECORD_ONLY) return
    expect(result.ms, `${result.last.cold} frames in view still blank after 120 s`).not.toBeNull()
    expect(result.ms!, 'time until every frame in view shows a picture').toBeLessThanOrEqual(COLD_ZOOM_OUT_PICTURES_BY_MS)
    expect(counts.liveIframes, 'live iframes once a cold zoom-out has settled').toBeLessThanOrEqual(MAX_LIVE_AT_REST)
  })

  test('measure: live iframes, heap, pan and zoom p95, time to pictures', { tag: '@production-bundle' }, async ({ page }) => {
    const { canvasRoot } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
    await page.waitForTimeout(3000)
    const atRest = await readBoardCounts(page)
    const restView = await readViewCounts(page)

    const box = await canvasRoot.boundingBox()
    if (!box) throw new Error('the canvas root has no bounding box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const pan = await profileGesture(page, async () => {
      for (let i = 0; i < 25; i += 1) {
        await page.mouse.wheel(60, 30)
        await page.waitForTimeout(40)
      }
    })
    await page.waitForTimeout(1500)
    const zoom = await profileGesture(page, async () => {
      await wheelZoom(page, canvasRoot, 12, 120)
      await wheelZoom(page, canvasRoot, 12, -120)
    })
    await page.waitForTimeout(2500)

    // Zoom all the way out and time how long until every frame in view shows a picture.
    await wheelZoom(page, canvasRoot, 14, 120)
    const zoomedOutAt = Date.now()
    const justAfterZoom = await readViewCounts(page)
    await page.waitForTimeout(3000)
    const zoomedOut = await readBoardCounts(page)
    const zoomedOutView = await readViewCounts(page)
    const toPictures = await msUntilNoBlank(page, 60_000)
    const sinceZoomMs = Date.now() - zoomedOutAt

    // Back to the working view, then the memory series over the zoom cycles.
    await wheelZoom(page, canvasRoot, 14, -120)
    await page.waitForTimeout(2000)
    await zoomCycle(page, canvasRoot)
    const baseline = { heap: await heapUsedBytes(page), dom: await readDomCounters(page), iframes: (await readBoardCounts(page)).liveIframes }
    const series = [baseline]
    for (let cycle = 2; cycle <= ZOOM_CYCLES; cycle += 1) {
      await zoomCycle(page, canvasRoot)
      if (cycle % 5 === 0) series.push({ heap: await heapUsedBytes(page), dom: await readDomCounters(page), iframes: (await readBoardCounts(page)).liveIframes })
    }
    const last = series[series.length - 1]!

    const result = {
      label: LABEL,
      atRest: { ...atRest, view: restView },
      zoomedOut: { ...zoomedOut, view: zoomedOutView, justAfterZoom },
      toPicturesMs: toPictures.ms,
      toPicturesLast: toPictures.last,
      sinceZoomMs,
      pan: { p95: pan.p95FrameMs, worst: pan.worstFrameMs, over20: pan.framesOver20ms, frames: pan.frames },
      zoom: { p95: zoom.p95FrameMs, worst: zoom.worstFrameMs, over20: zoom.framesOver20ms, frames: zoom.frames },
      cycles: series.map((s) => ({ heapMB: +(s.heap / 1048576).toFixed(1), documents: s.dom.documents, nodes: s.dom.nodes, listeners: s.dom.jsEventListeners, iframes: s.iframes })),
    }
    dump(`${LABEL}-${Date.now()}`, result)
    annotate('iframes at rest / zoomed out', `${atRest.liveIframes} / ${zoomedOut.liveIframes} (board frames ${atRest.boardFrames})`)
    annotate('zoomed out, frames in view: live/poster/blank', `${zoomedOutView.live}/${zoomedOutView.poster}/${zoomedOutView.cold} of ${zoomedOutView.inView} (just after the zoom: ${justAfterZoom.live}/${justAfterZoom.poster}/${justAfterZoom.cold})`)
    annotate('time to pictures after zoom-out', toPictures.ms === null ? `not within 60 s (${toPictures.last.cold} blank)` : `${toPictures.ms} ms`)
    annotate('pan p95 / worst', `${pan.p95FrameMs.toFixed(1)} / ${pan.worstFrameMs.toFixed(1)} ms, ${pan.framesOver20ms} over 20 ms`)
    annotate('zoom p95 / worst', `${zoom.p95FrameMs.toFixed(1)} / ${zoom.worstFrameMs.toFixed(1)} ms, ${zoom.framesOver20ms} over 20 ms`)
    annotate('heap MB per cycles 1,5,10,15,20', series.map((s) => (s.heap / 1048576).toFixed(0)).join(' -> '))
    annotate('documents per cycles', series.map((s) => s.dom.documents).join(' -> '))
    annotate('listeners per cycles', series.map((s) => s.dom.jsEventListeners).join(' -> '))

    if (RECORD_ONLY) return
    expect(atRest.liveIframes, 'live iframes at rest').toBeLessThanOrEqual(MAX_LIVE_AT_REST)
    expect(zoomedOut.liveIframes, 'live iframes zoomed out').toBeLessThanOrEqual(MAX_LIVE_AT_REST)
    expect(last.dom.documents - baseline.dom.documents, 'documents grew across zoom cycles').toBeLessThanOrEqual(2)
    expect(last.heap - baseline.heap, 'JS heap grew across zoom cycles').toBeLessThanOrEqual(Math.max(30 * 1048576, baseline.heap * 0.25))
  })
})

test.describe('poster-first behaviour on a 20-frame board', () => {
  let fixture: FixtureProject
  test.beforeAll(() => {
    fixture = writeLargeBoardCorpus({ ...LARGE_BOARD_SHAPE, name: '__poster-first-corpus', frameCount: SMALL_BOARD_FRAMES, sectionsPerScreen: 3, framesPerRow: 5 })
  })
  test.afterAll(() => {
    if (fixture) removeFixtureProject(fixture)
  })

  test('zoom out: every frame in view shows a picture, none is blank', { tag: '@production-bundle' }, async ({ page }) => {
    const { canvasRoot } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
    await wheelZoom(page, canvasRoot, 14, 120)
    const result = await msUntilNoBlank(page, ALL_PICTURES_BY_MS, 'board')
    annotate('20-frame board: time to a picture in every frame', result.ms === null ? `not within ${ALL_PICTURES_BY_MS} ms` : `${result.ms} ms`)
    expect(result.last.inView, 'the board should have all its frames').toBe(SMALL_BOARD_FRAMES)
    expect(result.ms, `${result.last.cold} frames still blank`).not.toBeNull()
    // And what the user sees, the frames in view, has no blank either.
    expect((await readViewCounts(page)).cold).toBe(0)
    expect(result.last.zoom).toBeLessThan(0.35)
    // Below the poster zoom nothing but a working frame is a document.
    const counts = await readBoardCounts(page)
    expect(counts.liveIframes).toBeLessThanOrEqual(2)
    // And a picture is a real bitmap, not a transparent one.
    const decoded = await page.locator('[data-testid="board-frame-poster"]').first().evaluate(async (img) => {
      const el = img as HTMLImageElement
      await el.decode()
      return el.naturalWidth * el.naturalHeight
    })
    expect(decoded).toBeGreaterThan(0)
  })

  test('one press on a poster makes the frame live and selected', { tag: '@production-bundle' }, async ({ page }) => {
    const { canvasRoot } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
    await wheelZoom(page, canvasRoot, 14, 120)
    const result = await msUntilNoBlank(page, ALL_PICTURES_BY_MS, 'board')
    expect(result.ms, 'no pictures to press on').not.toBeNull()
    const target = page.locator(`[data-page-id="${largeBoardPageId(7)}"]`)
    await expect(target).toHaveAttribute('data-frame-mount', 'poster')
    const body = target.locator('[data-testid="board-frame-body"]')
    const box = await body.boundingBox()
    if (!box) throw new Error('the poster frame has no bounding box')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(target).toHaveAttribute('data-selected', 'true', { timeout: 2000 })
    await expect(target).toHaveAttribute('data-frame-mount', 'live', { timeout: 5000 })
    await expect(target.locator('iframe[title^="Canvas frame"]')).toHaveCount(1)
  })
})
