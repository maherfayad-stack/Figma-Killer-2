/**
 * perf-01 diagnostic — NOT a permanent spec. Measures the WS-5.6 numbers
 * (mounted iframe count, pan frame timing, selection-ring paint, first
 * interactive frame) against BOTH a synthetic 50-frame board and the real
 * maherfayad-stack-eSIM corpus, via the proven `npx playwright test`
 * harness — `scripts/bench/studioBoard.bench.ts`'s own raw
 * `playwright-core` launch hangs in this sandbox (Bun + Windows +
 * `--remote-debugging-pipe`, unrelated to the bench's own logic; see
 * STATE.md's `perf-01` entry). Run manually, read the console output, then
 * delete this file — it exists to calibrate budgets, not to gate CI.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const FRAME_COUNT = 50
const NODES_PER_FRAME = 400

function generateSyntheticProject(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
  const pagesDir = path.join(dir, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  for (let i = 1; i <= FRAME_COUNT; i++) {
    const items = Array.from({ length: NODES_PER_FRAME }, (_, j) => `      <div>Item ${j + 1}</div>`).join('\n')
    const source = [
      `export default function Page${String(i).padStart(2, '0')}() {`,
      '  return (',
      '    <div className="page">',
      items,
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(pagesDir, `Page${String(i).padStart(2, '0')}.tsx`), source, 'utf8')
  }
}

async function measureFramesDuring(
  page: Page,
  action: () => Promise<void>,
): Promise<{ frames: number; worstFrameMs: number; meanFrameMs: number; droppedOver20ms: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __perfFrames?: { times: number[]; running: boolean; last: number } }
    w.__perfFrames = { times: [], running: true, last: performance.now() }
    function tick(now: number): void {
      const accum = w.__perfFrames
      if (!accum || !accum.running) return
      accum.times.push(now - accum.last)
      accum.last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await action()
  await page.waitForTimeout(100)
  return page.evaluate(() => {
    const w = window as unknown as { __perfFrames?: { times: number[]; running: boolean } }
    if (!w.__perfFrames) return { frames: 0, worstFrameMs: 0, meanFrameMs: 0, droppedOver20ms: 0 }
    w.__perfFrames.running = false
    const t = w.__perfFrames.times
    const worst = t.reduce((m, v) => (v > m ? v : m), 0)
    const mean = t.length ? t.reduce((s, v) => s + v, 0) / t.length : 0
    return { frames: t.length, worstFrameMs: worst, meanFrameMs: mean, droppedOver20ms: t.filter((v) => v > 20).length }
  })
}

async function openStudioBoard(page: Page, dir: string): Promise<number> {
  await page.addInitScript((d: string) => {
    window.localStorage.setItem('studio:studio:dir', d)
    window.localStorage.setItem('studio:studio', '1')
  }, dir)
  const t0 = performance.now()
  await page.goto('/admin/site?studio')
  await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 30_000 })
  return t0
}

/**
 * Zoom out (sign-safe — no wheel-pan direction guessing) until the frame's
 * iframe is technically visible, then zoom back IN a bit if it's too small
 * to click precisely. "Visible" alone isn't enough: at a very low zoom the
 * iframe can be a handful of CSS pixels wide, which is enough to satisfy
 * Playwright's visibility check but not enough to reliably click a specific
 * leaf node inside it — that showed up as a >5s "ring never appeared"
 * result under this bench's own calibration run.
 */
async function bringFrameOnScreen(page: Page, pageId: string): Promise<void> {
  const iframeSel = `[data-page-id="${pageId}"] [data-testid="board-frame-body"] iframe`
  let zoomOutSteps = 0
  for (let i = 0; i < 20; i++) {
    if (await page.locator(iframeSel).first().isVisible().catch(() => false)) break
    await page.keyboard.press('-')
    zoomOutSteps++
    await page.waitForTimeout(100)
  }
  const box0 = await page.locator(iframeSel).first().boundingBox().catch(() => null)
  if (!box0) throw new Error(`frame ${pageId} never came on screen`)

  const MIN_USABLE_WIDTH_PX = 200
  let width = box0.width
  let zoomedIn = 0
  while (width < MIN_USABLE_WIDTH_PX && zoomedIn < zoomOutSteps) {
    await page.keyboard.press('+')
    zoomedIn++
    await page.waitForTimeout(100)
    const box = await page.locator(iframeSel).first().boundingBox().catch(() => null)
    if (!box) {
      // Zoomed back past visibility — back off one step and stop.
      await page.keyboard.press('-')
      await page.waitForTimeout(100)
      break
    }
    width = box.width
  }
}

async function measureBoard(page: Page, dir: string, firstFramePageId: string, label: string): Promise<void> {
  const t0 = await openStudioBoard(page, dir)
  await bringFrameOnScreen(page, firstFramePageId)
  const firstInteractiveMs = performance.now() - t0
  await page.waitForTimeout(1500)

  const mountedIframes = await page.evaluate(() => document.querySelectorAll('iframe').length)

  const contentFrame = page.frameLocator(`[data-page-id="${firstFramePageId}"] [data-testid="board-frame-body"] iframe`)
  // Scan for the first EARLY node (in DOM order) with a real, on-screen-sized
  // box — not `.last()` (a long page's last node can be far below the
  // viewport even once the frame itself is "visible") and not blindly
  // `.nth(2)` either (a real app's early nodes can be `display:contents`
  // wrappers or zero-size decorative elements — both showed up as false
  // "ring never painted" results while calibrating this diagnostic).
  const candidates = contentFrame.locator('[data-node-id]')
  const candidateCount = Math.min(30, await candidates.count())
  let target: Locator | null = null
  let box: { x: number; y: number; width: number; height: number } | null = null
  for (let i = 0; i < candidateCount; i++) {
    const candidate = candidates.nth(i)
    const candidateBox = await candidate.boundingBox().catch(() => null)
    if (candidateBox && candidateBox.width >= 10 && candidateBox.height >= 10) {
      target = candidate
      box = candidateBox
      break
    }
  }
  if (!target || !box) throw new Error('no clickable [data-node-id] candidate found')

  const selStart = performance.now()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const ring = contentFrame.locator('[data-canvas-selection-ring="true"]')
  await ring.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  const ringPaintMs = performance.now() - selStart

  const panel = page.getByTestId('properties-panel')
  await panel.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  const panelRerenderMs = performance.now() - selStart

  const canvasRoot = page.getByTestId('canvas-root')
  const canvasBox = await canvasRoot.boundingBox()
  if (!canvasBox) throw new Error('no canvas root box')
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
  const pan = await measureFramesDuring(page, async () => {
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(30, 20)
      await page.waitForTimeout(50)
    }
  })

  console.log(`\n=== ${label} ===`)
  console.log(`first interactive frame: ${firstInteractiveMs.toFixed(1)}ms`)
  console.log(`mounted iframes at rest: ${mountedIframes}`)
  console.log(`selection -> ring paint: ${ringPaintMs.toFixed(1)}ms`)
  console.log(`store change -> panel re-render: ${panelRerenderMs.toFixed(1)}ms`)
  console.log(`pan: frames=${pan.frames} worst=${pan.worstFrameMs.toFixed(1)}ms mean=${pan.meanFrameMs.toFixed(1)}ms droppedOver20ms=${pan.droppedOver20ms}`)
}

test.describe.configure({ mode: 'serial' })

test('synthetic 50-frame / 20000-node board', async ({ page }) => {
  test.setTimeout(120_000)
  const dir = path.resolve('.tmp/benchmarks/studio-board-synth')
  generateSyntheticProject(dir)
  await measureBoard(page, dir, 'page01', 'SYNTHETIC 50-frame board')
})

test('real corpus — maherfayad-stack-eSIM', async ({ page }) => {
  test.setTimeout(120_000)
  const res = await page.request.get('/admin/api/studio/projects')
  const body = (await res.json()) as { projects?: Array<{ dir: string }> }
  const match = body.projects?.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === 'maherfayad-stack-eSIM')
  if (!match) {
    console.log('maherfayad-stack-eSIM not found among /admin/api/studio/projects — skipping')
    return
  }
  // First page id: read the load response directly (curated board seeds ALL
  // pages, id order is discovery order — journey-screens' first page file).
  const loadUrl = `/admin/api/studio/load?dir=${encodeURIComponent(match.dir)}`
  const loadRes = await page.request.get(loadUrl)
  const loadBody = (await loadRes.json()) as { pages: Array<{ id: string }> }
  const firstPageId = loadBody.pages[0]?.id
  if (!firstPageId) throw new Error('no pages found for maherfayad-stack-eSIM')
  await measureBoard(page, match.dir, firstPageId, `REAL CORPUS maherfayad-stack-eSIM (${loadBody.pages.length} pages)`)
})
