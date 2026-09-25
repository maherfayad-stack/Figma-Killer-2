import { expect, test, type Page } from '@playwright/test'
import { LARGE_BOARD_FRAME_COUNT, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { removeFixtureProject, type FixtureProject } from './helpers/studioFixtureProject'

/**
 * P6-B (PERF-7, speed-07) — how long a project takes to OPEN: from navigation
 * to the first board frame painting its page, and to every frame the board has.
 *
 * The corpus is the 40 × 300 board (`helpers/largeBoardCorpus.ts`), the size
 * the audit named. Two opens per run, on one server, each in a fresh browser
 * context:
 *
 * - **cold** — the corpus was just written, so the parse store is empty
 *   (`.studio/cache/` does not exist) and the server has never loaded it:
 *   every route is a real ts-morph parse.
 * - **warm** — the same project reopened: the server's load memo holds it,
 *   the everyday "open the project again" case speed-07 names.
 *
 * Measured in the page, against `performance.now()` (whose origin is the
 * navigation), by a rAF probe installed before any app script runs, plus the
 * product's own timeline marks (`studio:load:first-page`, `studio:load:open`,
 * `studio:load:complete` — `studioProjectLoad.ts`, `siteReloadApply.ts`,
 * `usePersistence.ts`). What counts as painted: a displayed canvas iframe
 * whose document holds a rendered node with a real box.
 *
 * Only the warm first frame is a budget. The cold numbers are reported: they
 * are dominated by the parse, which this machine's load swings by 2×. Every
 * number here runs under the Vite DEV server, so module loading (hundreds of
 * separate requests before the canvas code can run) is part of every one of
 * them; a production build pays a fraction of that.
 */

/**
 * Warm open → first frame painted, under the dev server. Calibrated on the
 * P6-B branch at about 2× its observed value (the convention
 * `studio-board-perf.e2e.ts`'s budgets follow); before P6-B the same
 * measurement was 4.7–4.9 s. The numbers are in `STATE.md`'s P6-B entry.
 */
const BUDGET_WARM_FIRST_FRAME_MS = 7_000

const CORPUS_TIMEOUT_MS = 120_000

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = writeLargeBoardCorpus()
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface OpenProbe {
  expectedFrames: number
  canvasRootMs: number | null
  firstFrameShellMs: number | null
  firstFramePaintedMs: number | null
  /** How many canvas iframes were displayed when the first one painted. */
  mountedAtFirstPaint: number | null
  allFramesShownMs: number | null
  allMountedPaintedMs: number | null
  loadStartMs: number | null
  loadFirstByteMs: number | null
  loadEndMs: number | null
  firstPageLineMs: number | null
  storeOpenMs: number | null
  storeCompleteMs: number | null
  done: boolean
  /** Every `/admin/api/` call the open made: path, start and end. */
  api: string[]
  longTasks: string[]
}

declare global {
  interface Window {
    __studioOpenProbe?: OpenProbe
  }
}

/** Installs the probe and points the editor at the corpus, before any app script runs. */
async function installOpenProbe(page: Page, fixtureDir: string, expectedFrames: number): Promise<void> {
  await page.addInitScript(
    ({ dir, frames }: { dir: string; frames: number }) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
      window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: false }))
      const probe: OpenProbe = {
        expectedFrames: frames,
        canvasRootMs: null,
        firstFrameShellMs: null,
        firstFramePaintedMs: null,
        mountedAtFirstPaint: null,
        allFramesShownMs: null,
        allMountedPaintedMs: null,
        loadStartMs: null,
        loadFirstByteMs: null,
        loadEndMs: null,
        firstPageLineMs: null,
        storeOpenMs: null,
        storeCompleteMs: null,
        done: false,
        api: [],
        longTasks: [],
      }
      window.__studioOpenProbe = probe
      // Vite dev serves every module as its own resource; the default buffer
      // (250 entries) is full before the first API call.
      performance.setResourceTimingBufferSize(20_000)
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.longTasks.push(`${Math.round(entry.startTime)}+${Math.round(entry.duration)}`)
      }).observe({ type: 'longtask', buffered: true })
      const mark = (name: string) => performance.getEntriesByName(name, 'mark').at(-1)?.startTime ?? null
      const painted = (iframe: HTMLIFrameElement): boolean => {
        const node = iframe.contentDocument?.querySelector('[data-node-id]')
        if (!node) return false
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const finish = () => {
        // The load that counted: the last one that got an answer (React's dev
        // double-mount aborts the first).
        const loads = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter((entry) => entry.name.includes('/admin/api/studio/load') && entry.responseStart > 0)
        const load = loads[loads.length - 1]
        probe.loadStartMs = load?.startTime ?? null
        probe.loadFirstByteMs = load?.responseStart ?? null
        probe.loadEndMs = load?.responseEnd ?? null
        probe.firstPageLineMs = mark('studio:load:first-page')
        probe.storeOpenMs = mark('studio:load:open')
        probe.storeCompleteMs = mark('studio:load:complete')
        for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
          const at = entry.name.indexOf('/admin/api/')
          if (at >= 0) probe.api.push(`${entry.name.slice(at + 11).split('?')[0]} ${Math.round(entry.startTime)}-${Math.round(entry.responseEnd)}`)
        }
        probe.done = true
      }
      const tick = () => {
        const now = performance.now()
        if (probe.canvasRootMs === null && document.querySelector('[data-testid="canvas-root"]')) probe.canvasRootMs = now
        if (probe.firstFrameShellMs === null && document.querySelector('[data-testid="board-frame-body"]')) probe.firstFrameShellMs = now
        const iframes = [...document.querySelectorAll<HTMLIFrameElement>('iframe[title^="Canvas frame"]')]
          .filter((iframe) => iframe.offsetParent !== null)
        const paintedCount = iframes.filter(painted).length
        if (probe.firstFramePaintedMs === null && paintedCount > 0) {
          probe.firstFramePaintedMs = now
          probe.mountedAtFirstPaint = iframes.length
        }
        // A frame is SHOWN once its page is in: `data-page-id`, and not a
        // pending placeholder (`PendingBoardFrame`).
        const shown = document.querySelectorAll('[data-page-id]:not([data-page-pending])').length
        if (probe.allFramesShownMs === null && shown >= frames) probe.allFramesShownMs = now
        if (probe.allFramesShownMs !== null && probe.allMountedPaintedMs === null && iframes.length > 0 && paintedCount === iframes.length) {
          probe.allMountedPaintedMs = now
        }
        if (probe.allMountedPaintedMs !== null) finish()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { dir: fixtureDir, frames: expectedFrames },
  )
}

async function measureOpen(page: Page, label: string): Promise<OpenProbe> {
  await installOpenProbe(page, fixture.dir, LARGE_BOARD_FRAME_COUNT)
  await page.goto('/admin/site?studio')
  await expect
    .poll(() => page.evaluate(() => window.__studioOpenProbe?.done ?? false), {
      message: `${label}: the board never showed and painted every frame`,
      timeout: CORPUS_TIMEOUT_MS,
      intervals: [100],
    })
    .toBe(true)
  const probe = await page.evaluate(() => window.__studioOpenProbe!)
  const ms = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value)}`)
  const summary =
    `${label} (ms from navigation): /load ${ms(probe.loadStartMs)}→first byte ${ms(probe.loadFirstByteMs)}→end ${ms(probe.loadEndMs)}; ` +
    `first page line ${ms(probe.firstPageLineMs)}; store open ${ms(probe.storeOpenMs)}, complete ${ms(probe.storeCompleteMs)}; ` +
    `canvas root ${ms(probe.canvasRootMs)}; first frame shell ${ms(probe.firstFrameShellMs)}, ` +
    `FIRST FRAME PAINTED ${ms(probe.firstFramePaintedMs)} (${probe.mountedAtFirstPaint ?? 'n/a'} iframes up); ` +
    `all ${LARGE_BOARD_FRAME_COUNT} frames shown ${ms(probe.allFramesShownMs)}, mounted frames painted ${ms(probe.allMountedPaintedMs)}`
  test.info().annotations.push({ type: 'perf', description: summary })
  console.log(`[p6-b] ${summary}`)
  console.log(`[p6-b] ${label} api: ${probe.api.join(', ')}`)
  console.log(`[p6-b] ${label} long tasks: ${probe.longTasks.join(' ')}`)
  return probe
}

test.describe('P6-B project open on the 40 x 300 corpus', () => {
  test.setTimeout(300_000)

  test('cold then warm open: the first frame paints within budget when warm', async ({ browser }) => {
    const storageState = test.info().project.use.storageState
    const viewport = { width: 1920, height: 1080 }

    const coldContext = await browser.newContext({ storageState, viewport })
    const cold = await measureOpen(await coldContext.newPage(), 'cold')
    await coldContext.close()

    const warmContext = await browser.newContext({ storageState, viewport })
    const warm = await measureOpen(await warmContext.newPage(), 'warm')
    await warmContext.close()

    expect(cold.firstFramePaintedMs, 'cold open: no frame ever painted').not.toBeNull()
    expect(warm.firstFramePaintedMs, 'warm open: time to the first painted frame').toBeLessThan(BUDGET_WARM_FIRST_FRAME_MS)
  })
})
