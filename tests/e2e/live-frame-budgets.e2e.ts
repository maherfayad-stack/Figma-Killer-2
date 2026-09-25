import { expect, test, type CDPSession, type Frame, type Locator, type Page } from '@playwright/test'
import { liveBridgeIframe, settleCanvasFrameMode } from './helpers/canvasIframe'
import { ANIMATED_PAGE_ID, LIVE_BOARD_FRAME_COUNT, writeLiveAnimatedFixture } from './helpers/liveAnimatedFixture'
import { openFixtureBoard, panIntoView, removeFixtureProject, type FixtureProject } from './helpers/studioFixtureProject'

/**
 * Budgets on a REAL Tier-2 board — ROADMAP P6-C, audit `01-perf.md` §3 item
 * 13 (PERF-9) and the live-frame memory baseline
 * (`docs/audits/2026-09-13-live-frame-memory-baseline.md`).
 *
 * Every other live-frame gate in this suite runs against a fixture whose dev
 * server cannot boot, so it measures the static fallback.
 * `helpers/liveAnimatedFixture.ts` gives its fixture a real Vite, so these
 * frames are real cross-origin documents running the project's own code.
 *
 *   - **animated frame**: a page that animates from JavaScript every frame
 *     must not have its fit re-derived (a full-document forced layout) on
 *     every frame. Counted inside the live document: every reset writes the
 *     body's fit pin back to the floor.
 *   - **memory per live frame**: the live documents' renderer heap and DOM
 *     counters with every frame live, then after a pan evicts some.
 */

/** PLACEHOLDER budgets — calibrated from this spec's own runs (P6-C PR). */
const BUDGET_FIT_RESETS_PER_SECOND = 1000
const BUDGET_ANIMATED_WORST_FRAME_MS = 10_000

const SAMPLE_MS = 5000

test.use({ viewport: { width: 1920, height: 1080 } })

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = writeLiveAnimatedFixture()
})

// Stop the fixture's dev server after every case, so no Vite outlives the run.
test.afterEach(async ({ page }) => {
  if (!fixture || page.url() === 'about:blank') return
  await page.request
    .post('/admin/api/studio/dev-server/stop', { data: { dir: fixture.dir }, headers: { Origin: new URL(page.url()).origin } })
    .catch(() => undefined)
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[p6-c live] ${label}: ${value}`)
}

async function liveContent(boardFrame: Locator): Promise<Frame> {
  const handle = await liveBridgeIframe(boardFrame).elementHandle()
  const frame = await handle?.contentFrame()
  if (!frame) throw new Error('the live bridge iframe has no content frame')
  return frame
}

async function openLiveBoard(page: Page): Promise<{ canvasRoot: Locator; boardFrame: Locator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const boardFrame = page.locator(`[data-page-id="${ANIMATED_PAGE_ID}"]`).first()
  await panIntoView(page, canvasRoot, boardFrame)
  const mode = await settleCanvasFrameMode(page, boardFrame, fixture.dir, 180_000)
  expect(mode, 'the fixture\'s dev server never booted, so there is no live frame to measure (see liveAnimatedFixture.ts)').toBe('live')
  return { canvasRoot, boardFrame }
}

test.describe('P6-C budgets on a booted Tier-2 board', () => {
  test.setTimeout(300_000)

  test('a JavaScript-animated live frame does not re-derive its fit every frame', async ({ page }) => {
    const { boardFrame } = await openLiveBoard(page)
    const live = await liveContent(boardFrame)
    await expect(live.locator('.animated__spinner')).toBeVisible({ timeout: 30_000 })
    // Let the first fit settle.
    await page.waitForTimeout(1500)

    await live.evaluate(() => {
      const state = { resets: 0, pinWrites: 0, intervals: [] as number[], last: performance.now(), handle: 0, observer: null as MutationObserver | null }
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.target !== document.body || record.attributeName !== 'style') continue
          state.pinWrites += 1
          // `frameFitRules.ts`'s DEFAULT_FRAME_FIT_HEIGHT: a reset writes the pin back to the floor.
          if (document.body.style.height === '800px') state.resets += 1
        }
      })
      state.observer.observe(document.body, { attributes: true, attributeFilter: ['style'] })
      const tick = () => {
        const now = performance.now()
        state.intervals.push(now - state.last)
        state.last = now
        state.handle = requestAnimationFrame(tick)
      }
      state.handle = requestAnimationFrame(tick)
      ;(window as unknown as { __p6cFit: typeof state }).__p6cFit = state
    })
    await page.waitForTimeout(SAMPLE_MS)
    const sample = await live.evaluate(() => {
      const state = (window as unknown as { __p6cFit: { resets: number; pinWrites: number; intervals: number[]; handle: number; observer: MutationObserver } }).__p6cFit
      cancelAnimationFrame(state.handle)
      state.observer.disconnect()
      const intervals = state.intervals.slice(1)
      return { resets: state.resets, pinWrites: state.pinWrites, frames: intervals.length, worst: Math.max(...intervals), over20: intervals.filter((n) => n > 20).length }
    })
    const resetsPerSecond = (sample.resets * 1000) / SAMPLE_MS
    annotate('animated: fit resets per second', resetsPerSecond.toFixed(1))
    annotate('animated: body pin writes in window', String(sample.pinWrites))
    annotate('animated: live-frame worst frame', `${sample.worst.toFixed(1)}ms`)
    annotate('animated: live-frame frames >20ms', `${sample.over20}/${sample.frames}`)
    expect(sample.frames, 'the live frame painted too few frames to measure').toBeGreaterThan(60)
    expect(resetsPerSecond).toBeLessThanOrEqual(BUDGET_FIT_RESETS_PER_SECOND)
    expect(sample.worst).toBeLessThan(BUDGET_ANIMATED_WORST_FRAME_MS)
  })

  test('memory per live frame: the renderer heap and documents with every frame live, then after a pan evicts some', async ({ page }) => {
    const { canvasRoot, boardFrame } = await openLiveBoard(page)
    const bridges = page.locator('[data-testid="live-board-frame-bridge"]:not([hidden])')
    // Zoom out until every frame is on screen, then wait for all of them to go live.
    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('canvas root has no bounding box')
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.keyboard.down('Control')
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 120)
      await page.waitForTimeout(150)
    }
    await page.keyboard.up('Control')
    await expect(bridges, 'not every frame went live with the whole board on screen').toHaveCount(LIVE_BOARD_FRAME_COUNT, { timeout: 180_000 })
    await page.waitForTimeout(3000)

    const live = await liveContent(boardFrame)
    const liveCdp: CDPSession = await page.context().newCDPSession(live)
    const pageCdp: CDPSession = await page.context().newCDPSession(page)
    await pageCdp.send('Performance.enable')
    const measure = async () => {
      await liveCdp.send('HeapProfiler.collectGarbage')
      await pageCdp.send('HeapProfiler.collectGarbage')
      await page.waitForTimeout(300)
      const heap = (await liveCdp.send('Runtime.getHeapUsage')) as { usedSize: number }
      const dom = (await liveCdp.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number }
      const { metrics } = (await pageCdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }
      const editorHeap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? Number.NaN
      return { liveHeapMb: heap.usedSize / 1_048_576, liveDocuments: dom.documents, liveNodes: dom.nodes, editorHeapMb: editorHeap / 1_048_576, bridges: await bridges.count() }
    }
    const all = await measure()
    annotate('memory: live frames', String(all.bridges))
    annotate('memory: live renderer heap MB / documents / nodes', `${all.liveHeapMb.toFixed(1)} / ${all.liveDocuments} / ${all.liveNodes}`)
    annotate('memory: editor heap MB', all.editorHeapMb.toFixed(1))

    // Zoom back in on the animated frame: the live pool keeps
    // max(on screen, 8), so the frames that leave beyond eight are evicted.
    await panIntoView(page, canvasRoot, boardFrame)
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.keyboard.down('Control')
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(150)
    }
    await page.keyboard.up('Control')
    await expect.poll(() => bridges.count(), { timeout: 30_000 }).toBeLessThan(LIVE_BOARD_FRAME_COUNT)
    await page.waitForTimeout(3000)
    const fewer = await measure()
    const evicted = all.bridges - fewer.bridges
    annotate('memory: live frames after the pan', String(fewer.bridges))
    annotate('memory: live renderer heap MB / documents / nodes (after)', `${fewer.liveHeapMb.toFixed(1)} / ${fewer.liveDocuments} / ${fewer.liveNodes}`)
    annotate('memory: per evicted live frame, heap MB', ((all.liveHeapMb - fewer.liveHeapMb) / evicted).toFixed(2))
    annotate('memory: per evicted live frame, documents', ((all.liveDocuments - fewer.liveDocuments) / evicted).toFixed(2))
    expect(evicted).toBeGreaterThan(0)
  })
})
