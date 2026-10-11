import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { visibleCanvasIframe } from './helpers/canvasIframe'
import { largeBoardPageId, openLargeBoardAtWorkingZoom, SCALE_BOARD_SHAPE, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { removeFixtureProject, type FixtureProject } from './helpers/studioFixtureProject'
import type { ProbeResult } from './helpers/frameGeometryProbe.entry'

/**
 * SB-3 — the per-frame rect index against the browser's own hit test, in REAL
 * Chromium layout (happy-dom has none, so the unit tests cannot check this).
 *
 * `helpers/frameGeometryProbe.entry.ts` is bundled with `bun build` and injected
 * into a document. It runs the real `collectNodeGeometry` + `FrameGeometryIndex`
 * over a grid of points and compares each answer with `document.elementsFromPoint`
 * mapped through `closest('[data-node-id]')` (what the canvas asked the DOM
 * before). Two documents:
 *
 *  1. an adversarial page built for this spec (absolute overlap, z-index,
 *     `overflow: hidden`, `pointer-events: none`, `visibility: hidden`,
 *     `display: contents`, a rotated node) where every claimed rule is checked;
 *  2. the real 100-frame board corpus, in a live portal frame as Studio renders
 *     it, which also records the read and query costs.
 *
 * A mismatch on a hit the index did NOT flag `approximate` is a bug and fails
 * the test. What the index declines to model (negative z-index behind a parent,
 * `opacity`/`filter` stacking contexts, floats, `clip-path`) is not in the
 * adversarial page on purpose and is listed in `frameGeometryIndex.ts`.
 */

test.use({ viewport: { width: 1920, height: 1080 } })
test.describe.configure({ timeout: 300_000 })

const PROBE_BUNDLE = '.tmp/frame-geometry-probe.js'
/** Fraction of grid points whose topmost stamped node must equal the browser's, on the real corpus. */
const CORPUS_TOP_HIT_PARITY_MIN = 0.99
/** Median cost of one batched read of a 140-node frame, ms (measured 1.1-1.4 ms, 3 runs, preview). */
const MEASURE_ALL_MEDIAN_BUDGET_MS = 4
/** Mean cost of one index point query, microseconds (measured 1.3-1.6, against 17-18 for the browser). */
const INDEX_QUERY_BUDGET_US = 10

let bundle = ''
let fixture: FixtureProject

test.beforeAll(() => {
  mkdirSync('.tmp', { recursive: true })
  execFileSync('bun', ['build', 'tests/e2e/helpers/frameGeometryProbe.entry.ts', '--target=browser', '--format=iife', `--outfile=${PROBE_BUNDLE}`], { stdio: 'pipe' })
  bundle = readFileSync(PROBE_BUNDLE, 'utf8')
  fixture = writeLargeBoardCorpus(SCALE_BOARD_SHAPE)
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[sb-3] ${label}: ${value}`)
}

async function probe(target: Page | Frame, step: number): Promise<ProbeResult> {
  await target.evaluate(bundle)
  return target.evaluate((options) => (window as unknown as { __frameGeometryProbe: { run: (o: { step: number }) => unknown } }).__frameGeometryProbe.run(options) as never, { step }) as Promise<ProbeResult>
}

const ADVERSARIAL_PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; padding: 0; }
  body { width: 800px; height: 1000px; position: relative; font: 14px sans-serif; }
  .box { box-sizing: border-box; }
</style></head><body data-node-id="body">
  <header class="box" data-node-id="header" style="height: 60px; background: #ddd">
    <h1 data-node-id="title" style="margin: 0; height: 40px">Title</h1>
  </header>

  <main data-node-id="main" class="box" style="padding: 10px">
    <section data-node-id="card" class="box" style="height: 120px; background: #eee; padding: 10px">
      <p data-node-id="copy" style="margin: 0; height: 30px">Copy</p>
      <button data-node-id="cta" style="height: 30px; width: 100px">Go</button>
    </section>

    <!-- Overlapping positioned siblings: z-index, then document order. -->
    <div data-node-id="stack" class="box" style="position: relative; height: 200px">
      <div data-node-id="low" style="position: absolute; left: 0; top: 0; width: 200px; height: 150px; z-index: 1; background: #c00"></div>
      <div data-node-id="high" style="position: absolute; left: 100px; top: 50px; width: 200px; height: 150px; z-index: 3; background: #0c0"></div>
      <div data-node-id="auto" style="position: absolute; left: 150px; top: 20px; width: 200px; height: 150px; background: #00c"></div>
      <div data-node-id="later" style="position: absolute; left: 180px; top: 30px; width: 60px; height: 60px; z-index: 1; background: #cc0"></div>
    </div>

    <!-- A clipping container with an overflowing child: the overflow is not hittable. -->
    <div data-node-id="clip" class="box" style="height: 80px; width: 200px; overflow: hidden; background: #ccf">
      <div data-node-id="wide" style="height: 40px; width: 500px; background: #99f"></div>
    </div>

    <!-- pointer-events: none veil over a button: the click reaches the button; over empty parts it reaches the container. -->
    <div data-node-id="host" class="box" style="position: relative; height: 80px; width: 300px; background: #fcc">
      <div data-node-id="veil" style="position: absolute; inset: 0; pointer-events: none"></div>
      <button data-node-id="under" style="position: absolute; left: 10px; top: 10px; width: 80px; height: 40px">x</button>
    </div>

    <!-- visibility: hidden covers a node but is not hittable. -->
    <div data-node-id="vis" class="box" style="position: relative; height: 60px; width: 200px; background: #cfc">
      <div data-node-id="ghost" style="position: absolute; inset: 0; visibility: hidden"></div>
    </div>

    <!-- display: contents: no box of its own, so the browser hits the children. -->
    <div data-node-id="contents" style="display: contents">
      <span data-node-id="c1" style="display: inline-block; width: 90px; height: 30px; background: #fcf"></span>
      <span data-node-id="c2" style="display: inline-block; width: 90px; height: 30px; background: #cff"></span>
    </div>

    <!-- A rotated node: the index only has its bounds, so a miss at its corners must be flagged approximate. -->
    <div data-node-id="spin" style="width: 120px; height: 60px; margin: 40px 0 40px 100px; background: #f90; transform: rotate(30deg)">
      <i data-node-id="spinChild" style="display: block; width: 50px; height: 20px; background: #960"></i>
    </div>
  </main>
</body></html>`

test.describe('rect index vs the browser hit test', () => {
  test('adversarial page: every hit the index vouches for equals the browser', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 1000 })
    await page.setContent(ADVERSARIAL_PAGE)
    const result = await probe(page, 6)
    annotate('adversarial: nodes / points / native hits', `${result.nodeCount} / ${result.points} / ${result.nativeHits}`)
    annotate('adversarial: top-hit matches', `${result.topMatches}/${result.points}`)
    annotate('adversarial: chain matches', `${result.chainMatches}/${result.points}`)
    annotate('adversarial: mismatches flagged approximate', String(result.approximateMismatches))
    annotate('adversarial: mismatches in a rounded corner', String(result.roundedCornerMismatches))
    annotate('adversarial: hard mismatches', String(result.hardMismatchCount))
    writeFileSync('.tmp/frame-geometry-adversarial.json', JSON.stringify(result, null, 2))
    expect(result.nodeCount).toBeGreaterThan(20)
    expect(result.nativeHits).toBeGreaterThan(result.points / 2)
    expect(result.hardMismatches, JSON.stringify(result.hardMismatches)).toEqual([])
    // The rotated node is the ONLY reason the index may be wrong, and it must have said so.
    expect(result.approximateMismatches).toBeLessThan(result.points * 0.05)
  })

  test('the real 100-frame corpus, in a live portal frame: parity and cost', { tag: '@production-bundle' }, async ({ page }) => {
    const { content } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
    const result = await probe(content, 8)
    annotate('corpus: nodes / points / native hits', `${result.nodeCount} / ${result.points} / ${result.nativeHits}`)
    annotate('corpus: top-hit matches', `${result.topMatches}/${result.points}`)
    annotate('corpus: chain matches', `${result.chainMatches}/${result.points}`)
    annotate('corpus: mismatches in a rounded corner (a box is hit as its rectangle)', String(result.roundedCornerMismatches))
    annotate('corpus: hard mismatches', String(result.hardMismatchCount))
    annotate('corpus: measureAll median (140-node frame)', `${result.measureMsMedian.toFixed(2)}ms`)
    annotate('corpus: index build median', `${result.buildMsMedian.toFixed(3)}ms`)
    annotate('corpus: index point query', `${result.indexQueryUs.toFixed(1)}us (browser elementsFromPoint ${result.nativeQueryUs.toFixed(1)}us)`)
    writeFileSync('.tmp/frame-geometry-corpus.json', JSON.stringify(result, null, 2))
    expect(result.nodeCount).toBeGreaterThan(100)
    expect(result.topMatches / result.points).toBeGreaterThanOrEqual(CORPUS_TOP_HIT_PARITY_MIN)
    expect(result.hardMismatches, JSON.stringify(result.hardMismatches)).toEqual([])
    expect(result.measureMsMedian).toBeLessThanOrEqual(MEASURE_ALL_MEDIAN_BUDGET_MS)
    expect(result.indexQueryUs).toBeLessThanOrEqual(INDEX_QUERY_BUDGET_US)
  })

  test('right-click on a canvas node lists the layers under the pointer, answered from the index', { tag: '@production-bundle' }, async ({ page }) => {
    const { frameEl, content } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
    const iframeBox = await visibleCanvasIframe(frameEl).boundingBox()
    if (!iframeBox) throw new Error('the target iframe has no bounding box')
    const target = await content.evaluate(() => {
      const el = document.querySelector('.row__label')
      const rect = el?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })
    if (!target) throw new Error('no row label to right-click')
    const scale = iframeBox.width / (await content.evaluate(() => document.documentElement.clientWidth))
    await page.mouse.click(iframeBox.x + target.x * scale, iframeBox.y + target.y * scale, { button: 'right' })
    // "Select layer" only renders when MORE than one layer is under the pointer: a label inside a row inside a section.
    await expect(page.getByText('Select layer', { exact: true })).toBeVisible({ timeout: 5000 })
  })
})
