import { expect, test, type CDPSession, type Frame, type Locator, type Page } from '@playwright/test'
import { largeBoardPageId, openLargeBoardAtWorkingZoom, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { installReactRenderCounter, readRenderCounts, resetRenderCounts, topRenders } from './helpers/reactRenderCounter'
import {
  SELECTION_RING,
  clickInFrame,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * The edit and load budgets on the LARGE board — ROADMAP P6-C, audit
 * `01-perf.md` §3 items 4, 8, 9, 10 and 11, on the 40-frame × ~300-element
 * corpus (`helpers/largeBoardCorpus.ts`) that `canvas-feel-budgets.e2e.ts`
 * measures the pointer budgets on:
 *
 *   - **keystroke -> paint** (item 4), from the inspector's Text field and
 *     from inline editing on the canvas;
 *   - **re-renders after a structural write** (item 8, PERF-6): a ⌘D, counted
 *     in `NodeRenderer` renders by `helpers/reactRenderCounter.ts`;
 *   - **no long task after a click that follows an edit** (item 10, PERF-5);
 *   - **memory** (item 11): heap and detached documents after 20 pan cycles
 *     and 50 edits;
 *   - **first frame interactive, warm** (item 9, WS-5.5).
 *
 * The board opens with autosave off, so a text edit stays in memory; a ⌘D is
 * a structural write and always lands in the file.
 */

/** PLACEHOLDER budgets — calibrated from this spec's own runs (P6-C PR). */
const BUDGET_INSPECTOR_KEYSTROKE_TO_PAINT_MEDIAN_MS = 1000
const BUDGET_INLINE_KEYSTROKE_TO_PAINT_MEDIAN_MS = 1000
const BUDGET_DUPLICATE_NODE_RENDERS = 100_000
const BUDGET_POST_EDIT_CLICK_LONG_TASK_MS = 10_000
const BUDGET_HEAP_GROWTH_MB = 10_000
const BUDGET_DETACHED_DOCUMENTS = 1000
const BUDGET_FIRST_FRAME_INTERACTIVE_WARM_MS = 100_000

const KEYSTROKE_SAMPLES = 12
const TARGET_PAGE_ID = largeBoardPageId(0)

test.use({ viewport: { width: 1920, height: 1080 } })

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = writeLargeBoardCorpus()
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[p6-c] ${label}: ${value}`)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}

function spread(values: readonly number[]): string {
  return `median ${median(values).toFixed(1)}ms, min ${Math.min(...values).toFixed(1)}ms, max ${Math.max(...values).toFixed(1)}ms`
}

function open(page: Page): Promise<{ canvasRoot: Locator; frameEl: Locator; content: Frame }> {
  return openLargeBoardAtWorkingZoom(page, fixture, TARGET_PAGE_ID)
}

/** The visible inspector field whose value is `text` — the element's Text field. */
async function inspectorFieldHolding(page: Page, text: string): Promise<Locator> {
  const fields = page.locator('input:visible, textarea:visible')
  for (let i = 0; i < (await fields.count()); i += 1) {
    if ((await fields.nth(i).inputValue().catch(() => '')) === text) return fields.nth(i)
  }
  throw new Error(`no inspector field holds the text "${text}"`)
}

test.describe('P6-C edit and load budgets on the 40 x 300 corpus', () => {
  test.setTimeout(240_000)

  test('keystroke -> paint: the inspector Text field updates the canvas within budget', async ({ page }) => {
    const { content } = await open(page)
    const heading = content.locator('.block__heading').nth(1)
    await clickInFrame(page, heading)
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    const nodeId = await heading.getAttribute('data-node-id')
    const field = await inspectorFieldHolding(page, (await heading.textContent())?.trim() ?? '')
    await field.click()
    await page.keyboard.press('End')

    // keydown in the editor document -> the frame's text node changed -> the
    // next animation frame. The observer is created from the EDITOR window
    // and watches the iframe's (same-origin) node, so every timestamp is on
    // one clock.
    const samples: number[] = []
    for (let i = 0; i < KEYSTROKE_SAMPLES; i += 1) {
      await page.evaluate((id) => {
        const iframe = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[title^="Canvas frame"]')).find((f) =>
          f.contentDocument?.querySelector(`[data-node-id="${id}"]`),
        )
        const target = iframe?.contentDocument?.querySelector(`[data-node-id="${id}"]`)
        if (!target) throw new Error(`node ${id} is in no mounted frame`)
        const state = { downAt: 0, textAt: 0, paintAt: 0, observer: null as MutationObserver | null, before: target.textContent }
        ;(window as unknown as { __p6cKey: typeof state }).__p6cKey = state
        document.addEventListener('keydown', () => { if (state.downAt === 0) state.downAt = performance.now() }, { capture: true, once: true })
        state.observer = new MutationObserver(() => {
          if (state.textAt !== 0 || target.textContent === state.before) return
          state.textAt = performance.now()
          requestAnimationFrame(() => { state.paintAt = performance.now() })
        })
        state.observer.observe(target, { subtree: true, childList: true, characterData: true })
      }, nodeId)
      await page.keyboard.press('x')
      const ms = await page.evaluate(async () => {
        const state = (window as unknown as { __p6cKey: { downAt: number; paintAt: number; observer: MutationObserver } }).__p6cKey
        for (let wait = 0; wait < 200 && state.paintAt === 0; wait += 1) await new Promise((r) => setTimeout(r, 10))
        state.observer.disconnect()
        return state.downAt > 0 && state.paintAt > 0 ? state.paintAt - state.downAt : -1
      })
      expect(ms, `keystroke ${i}: the canvas never showed it within 2 s`).toBeGreaterThan(0)
      samples.push(ms)
      await page.waitForTimeout(120)
    }
    annotate('inspector keystroke -> canvas paint', `${spread(samples)} (${samples.map((n) => n.toFixed(0)).join(', ')})`)
    expect(median(samples)).toBeLessThan(BUDGET_INSPECTOR_KEYSTROKE_TO_PAINT_MEDIAN_MS)
  })

  test('keystroke -> paint: inline text editing on the canvas stays within budget', async ({ page }) => {
    const { content } = await open(page)
    const heading = content.locator('.block__heading').nth(1)
    const box = await heading.boundingBox()
    if (!box) throw new Error('the heading has no bounding box')
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
    await expect(content.locator('[contenteditable]')).toHaveCount(1, { timeout: 15_000 })
    await page.keyboard.press('End')

    // All inside the frame's own document: the keystroke is dispatched there
    // and the edited text node is there.
    const samples: number[] = []
    for (let i = 0; i < KEYSTROKE_SAMPLES; i += 1) {
      await content.evaluate(() => {
        const state = { downAt: 0, paintAt: 0 }
        ;(window as unknown as { __p6cInline: typeof state }).__p6cInline = state
        document.addEventListener('keydown', () => { if (state.downAt === 0) state.downAt = performance.now() }, { capture: true, once: true })
        document.addEventListener('input', () => requestAnimationFrame(() => { if (state.paintAt === 0) state.paintAt = performance.now() }), { capture: true, once: true })
      })
      await page.keyboard.press('x')
      const ms = await content.evaluate(async () => {
        const state = (window as unknown as { __p6cInline: { downAt: number; paintAt: number } }).__p6cInline
        for (let wait = 0; wait < 200 && state.paintAt === 0; wait += 1) await new Promise((r) => setTimeout(r, 10))
        return state.downAt > 0 && state.paintAt > 0 ? state.paintAt - state.downAt : -1
      })
      expect(ms, `inline keystroke ${i}: no input event painted within 2 s`).toBeGreaterThan(0)
      samples.push(ms)
      await page.waitForTimeout(120)
    }
    annotate('inline keystroke -> paint', `${spread(samples)} (${samples.map((n) => n.toFixed(0)).join(', ')})`)
    expect(median(samples)).toBeLessThan(BUDGET_INLINE_KEYSTROKE_TO_PAINT_MEDIAN_MS)
  })

  test('a structural write (⌘D) re-renders only what changed', async ({ page }) => {
    await installReactRenderCounter(page)
    const { canvasRoot, content } = await open(page)
    const headings = content.locator('.block__heading')
    const before = await headings.count()
    await clickInFrame(page, headings.nth(1))
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    await page.waitForTimeout(600)
    const mountedNodes = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[title^="Canvas frame"]')).reduce(
        (sum, f) => sum + (f.contentDocument?.querySelectorAll('[data-node-id]').length ?? 0),
        0,
      ),
    )
    await canvasRoot.focus()
    await resetRenderCounts(page)
    const startedAt = Date.now()
    await page.keyboard.press('Control+d')
    await expect(headings).toHaveCount(before + 1, { timeout: 30_000 })
    const shownMs = Date.now() - startedAt
    // The write lands, the board re-reads the page it wrote, and the result is
    // reconciled into the store (`patchPages`) — the part PERF-6 is about.
    await page.waitForTimeout(4000)
    const counts = await readRenderCounts(page)
    const nodeRenders = counts.renders.NodeRenderer ?? 0
    const nodeMounts = counts.mounts.NodeRenderer ?? 0
    annotate('⌘D: mounted canvas nodes', String(mountedNodes))
    annotate('⌘D: duplicate on screen after', `${shownMs}ms`)
    annotate('⌘D: NodeRenderer renders / mounts', `${nodeRenders} / ${nodeMounts}`)
    annotate('⌘D: commits', String(counts.commits))
    annotate('⌘D: top renders', topRenders(counts))
    expect(nodeRenders + nodeMounts).toBeLessThan(BUDGET_DUPLICATE_NODE_RENDERS)
  })

  test('a click after an edit and a pause is not followed by a long task', async ({ page }) => {
    await page.addInitScript(() => {
      if (window.top !== window) return
      const entries: Array<{ start: number; duration: number }> = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) entries.push({ start: entry.startTime, duration: entry.duration })
      }).observe({ type: 'longtask', buffered: true })
      ;(window as unknown as { __p6cLongTasks: typeof entries }).__p6cLongTasks = entries
    })
    const { content } = await open(page)
    const heading = content.locator('.block__heading').nth(1)
    await clickInFrame(page, heading)
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    const field = await inspectorFieldHolding(page, (await heading.textContent())?.trim() ?? '')
    await field.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edited')
    await page.keyboard.press('Tab')
    await expect(heading).toContainText('edited', { timeout: 10_000 })

    // The pause the poster queue used to wait out before rasterizing the frame
    // under the user (PERF-5), then the click.
    await page.waitForTimeout(700)
    const target = content.locator('.block__heading').nth(3)
    const box = await target.boundingBox()
    if (!box) throw new Error('the click target has no bounding box')
    const clickAt = await page.evaluate(() => performance.now())
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(1000)
    const tasks = await page.evaluate(
      (since) =>
        (window as unknown as { __p6cLongTasks: Array<{ start: number; duration: number }> }).__p6cLongTasks.filter(
          (t) => t.start >= since && t.start <= since + 1000,
        ),
      clickAt,
    )
    const worst = tasks.reduce((max, t) => Math.max(max, t.duration), 0)
    annotate('post-edit click: long tasks in the next 1 s', tasks.map((t) => `+${(t.start - clickAt).toFixed(0)}ms ${t.duration.toFixed(0)}ms`).join(', ') || '(none)')
    annotate('post-edit click: worst long task', `${worst.toFixed(0)}ms`)
    expect(worst).toBeLessThan(BUDGET_POST_EDIT_CLICK_LONG_TASK_MS)
  })

  test('memory: 20 pan cycles and 50 edits leave no detached documents and a bounded heap', async ({ page }) => {
    const { canvasRoot, content } = await open(page)
    const cdp: CDPSession = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const measure = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      await page.waitForTimeout(300)
      await cdp.send('HeapProfiler.collectGarbage')
      const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }
      const read = (name: string) => metrics.find((m) => m.name === name)?.value ?? Number.NaN
      return { heapMb: read('JSHeapUsedSize') / 1_048_576, documents: read('Documents'), frames: read('Frames'), nodes: read('Nodes') }
    }
    const start = await measure()

    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('canvas root has no bounding box')
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    for (let cycle = 0; cycle < 20; cycle += 1) {
      // Far enough that the frames on screen leave the pool, then back.
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 500)
      await page.waitForTimeout(400)
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -500)
      await page.waitForTimeout(400)
    }
    await page.waitForTimeout(2500)

    const heading = content.locator('.block__heading').nth(1)
    await clickInFrame(page, heading)
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    const field = await inspectorFieldHolding(page, (await heading.textContent())?.trim() ?? '')
    await field.click()
    await page.keyboard.press('End')
    for (let i = 0; i < 50; i += 1) {
      await page.keyboard.press(i % 2 === 0 ? 'y' : 'Backspace')
      await page.waitForTimeout(40)
    }
    await page.keyboard.press('Tab')
    await page.waitForTimeout(2500)
    const end = await measure()
    const detached = end.documents - end.frames
    annotate('memory: heap MB (start -> end)', `${start.heapMb.toFixed(1)} -> ${end.heapMb.toFixed(1)}`)
    annotate('memory: documents / frames (start)', `${start.documents} / ${start.frames}`)
    annotate('memory: documents / frames (end)', `${end.documents} / ${end.frames}`)
    annotate('memory: DOM nodes (start -> end)', `${start.nodes} -> ${end.nodes}`)
    annotate('memory: detached documents', String(detached))
    expect(detached).toBeLessThanOrEqual(BUDGET_DETACHED_DOCUMENTS)
    expect(end.heapMb - start.heapMb).toBeLessThan(BUDGET_HEAP_GROWTH_MB)
  })

  test('first frame interactive, warm: a reopened 40-page board has a clickable frame within budget', async ({ page }) => {
    // First open warms the server's load memo and parse cache, and the
    // browser's module cache — "warm" in WS-5.5's sense.
    await open(page)
    await page.addInitScript(() => {
      if (window.top !== window) return
      const state = { interactiveAt: 0, loadDoneAt: 0 }
      ;(window as unknown as { __p6cFirstFrame: typeof state }).__p6cFirstFrame = state
      const check = () => {
        if (state.interactiveAt !== 0) return
        const ready = document.querySelector('iframe[title^="Canvas frame"][data-studio-canvas-content-ready="true"]') as HTMLIFrameElement | null
        if (ready?.contentDocument?.querySelector('[data-node-id]')) state.interactiveAt = performance.now()
      }
      new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-studio-canvas-content-ready'] })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (entry.name.includes('/admin/api/studio/load')) state.loadDoneAt = (entry as PerformanceResourceTiming).responseEnd
      }).observe({ type: 'resource', buffered: true })
    })
    await page.reload()
    await expect(visibleCanvasIframe(page).first()).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __p6cFirstFrame: { interactiveAt: number } }).__p6cFirstFrame.interactiveAt), { timeout: 60_000 })
      .toBeGreaterThan(0)
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      const state = (window as unknown as { __p6cFirstFrame: { interactiveAt: number; loadDoneAt: number } }).__p6cFirstFrame
      return { interactiveAt: state.interactiveAt, loadDoneAt: state.loadDoneAt, domContentLoaded: nav.domContentLoadedEventEnd }
    })
    annotate('first frame interactive (warm)', `${timing.interactiveAt.toFixed(0)}ms`)
    annotate('  of which: DOMContentLoaded', `${timing.domContentLoaded.toFixed(0)}ms`)
    annotate('  of which: /load response end', `${timing.loadDoneAt.toFixed(0)}ms`)
    expect(timing.interactiveAt).toBeLessThan(BUDGET_FIRST_FRAME_INTERACTIVE_WARM_MS)
  })
})
