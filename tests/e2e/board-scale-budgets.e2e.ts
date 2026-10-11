import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Frame, type Locator, type Page } from '@playwright/test'
import { profileGesture, readBoardCounts } from './helpers/canvasPerf'
import { profileCpu, readDomCounters, traceGesture, traceMainThreadTasks } from './helpers/cdpTrace'
import { visibleCanvasIframe } from './helpers/canvasIframe'
import { LARGE_BOARD_SHAPE, largeBoardPageId, openLargeBoardAtWorkingZoom, SCALE_BOARD_SHAPE, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { frameForPage, removeFixtureProject, selectInFrame, type FixtureProject } from './helpers/studioFixtureProject'

/**
 * Board-scale budgets — SB-0 of the board-speed plan
 * (`docs/audits/2026-10-10-real-mouse-audit/plan-board-speed.md`), on a
 * GENERATED 100-frame x ~140-element board (`SCALE_BOARD_SHAPE`).
 *
 * The DONE-WHEN numbers of the plan are the budgets below. The ones the
 * current code misses are `test.fail`: the test passes only while the number
 * is still over the target, so the day a bundle fixes it Playwright reports
 * "expected to fail, but passed" and the author deletes the `test.fail` — the
 * budget then becomes an ordinary gate. The measured number is in each
 * annotation and in the comment above each case.
 *
 * Two cases are hard gates from day one: the zoom-cycle document/listener
 * leak (SB-0 found and fixed it) and the trace harness itself (it must
 * attribute a click, or the next agent has nothing to read).
 *
 * Run: `E2E_VITE_MODE=preview bun run test:e2e tests/e2e/board-scale-budgets.e2e.ts`
 * (the production bundle is the product; a dev-build number is a ratchet).
 * Attribution dumps land in `.tmp/board-speed/`.
 */

/** Plan §1 DONE WHEN. */
/**
 * Plan §1 says p95 <= 16 ms, but a 60 Hz display delivers a frame every 16.7 ms
 * at best, so a p95 INTERVAL of 16 is unreachable by construction (the mean of
 * every scripted run is 16.6-16.7). The budget is one vsync plus a hair, and no
 * frame over 20 ms.
 */
const TARGET_FRAME_P95_MS = 17
const TARGET_FRAMES_OVER_20MS = 0
const TARGET_CLICK_TO_RING_P95_MS = 16
const LIVE_CAP = 6
const TARGET_MAX_IFRAMES = LIVE_CAP + 2
const ZOOM_CYCLES = 20
/** Documents may wobble by a frame or two while a mount is in flight; a leak is a slope. */
const LEAK_DOC_TOLERANCE = 2
const CLICK_SAMPLES = 8
const HOVER_SAMPLES = 12
/** SB-3: provisional, set from the first measured runs and ratcheted by SB-4 (parent-side chrome) toward the plan's 16 ms. */
const HOVER_TO_RING_P95_BUDGET_MS = 25
/** SB-2: the longest main-thread task a poster refresh may cause. */
const TARGET_POSTER_REFRESH_MAIN_MS = 15
/** SB-2: a poster frame becoming a live, readable document. */
const TARGET_POSTER_TO_LIVE_MS = 250
const POSTER_CAPTURE_MEASURE = 'studio:poster-capture'

test.use({ viewport: { width: 1920, height: 1080 } })
test.describe.configure({ timeout: 300_000 })

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = writeLargeBoardCorpus(SCALE_BOARD_SHAPE)
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[sb-0] ${label}: ${value}`)
}

function dump(name: string, value: unknown): void {
  mkdirSync('.tmp/board-speed', { recursive: true })
  writeFileSync(`.tmp/board-speed/${name}.json`, JSON.stringify(value, null, 2))
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}

function open(page: Page): Promise<{ canvasRoot: Locator; frameEl: Locator; content: Frame }> {
  return openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
}

/** Wheel zoom around the canvas centre: `steps` x `deltaY` with Ctrl held. */
async function wheelZoom(page: Page, canvasRoot: Locator, steps: number, deltaY: number): Promise<void> {
  const box = await canvasRoot.boundingBox()
  if (!box) throw new Error('the canvas root has no bounding box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(40)
  }
  await page.keyboard.up('Control')
}

/** One full zoom cycle: out, then back in, then the settle window the mount queue needs. */
async function zoomCycle(page: Page, canvasRoot: Locator): Promise<void> {
  await wheelZoom(page, canvasRoot, 12, 120)
  await wheelZoom(page, canvasRoot, 12, -120)
  await page.waitForTimeout(1500)
}

interface ClickTarget {
  id: string
  x: number
  y: number
}

/** Hittable click targets (heading/body text) in the target frame, in page coordinates. */
async function clickTargets(page: Page, frameEl: Locator, content: Frame): Promise<ClickTarget[]> {
  const iframeBox = await visibleCanvasIframe(frameEl).boundingBox()
  if (!iframeBox) throw new Error('the target iframe has no bounding box')
  const probe = await content.evaluate(() => ({
    width: document.documentElement.clientWidth,
    targets: Array.from(document.querySelectorAll('.block__heading, .block__body, .row__label'))
      .map((el) => ({ id: el.getAttribute('data-node-id'), rect: el.getBoundingClientRect() }))
      .filter((t) => t.id !== null && t.rect.width > 0)
      .map((t) => ({ id: t.id!, x: t.rect.left + t.rect.width / 2, y: t.rect.top + t.rect.height / 2 })),
  }))
  const scale = iframeBox.width / probe.width
  const targets = probe.targets.map((t) => ({ id: t.id, x: iframeBox.x + t.x * scale, y: iframeBox.y + t.y * scale }))
  const hittable = await page.evaluate(
    (points) => points.map((p) => document.elementFromPoint(p.x, p.y)?.tagName === 'IFRAME'),
    targets,
  )
  return targets.filter((_, index) => hittable[index])
}

/** Ctrl-click one target and return pointerdown -> first animation frame after its ring exists, ms. */
async function clickToRing(page: Page, content: Frame, target: ClickTarget): Promise<number> {
  await content.evaluate((id) => {
    const state = { downAt: 0, ringAt: 0, paintAt: 0, observer: null as MutationObserver | null }
    ;(window as unknown as { __sb0Click: typeof state }).__sb0Click = state
    document.addEventListener('pointerdown', () => { if (state.downAt === 0) state.downAt = performance.now() }, { capture: true, once: true })
    const check = () => {
      if (state.ringAt !== 0) return
      const ring = Array.from(document.querySelectorAll('[data-canvas-selection-ring="true"]')).find(
        (el) => el.getAttribute('data-canvas-overlay-node-id') === id && (el as HTMLElement).style.display !== 'none',
      )
      if (!ring) return
      state.ringAt = performance.now()
      requestAnimationFrame(() => { state.paintAt = performance.now() })
    }
    state.observer = new MutationObserver(check)
    state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-canvas-overlay-node-id'] })
  }, target.id)
  await page.keyboard.down('ControlOrMeta')
  await page.mouse.click(target.x, target.y)
  await page.keyboard.up('ControlOrMeta')
  return content.evaluate(async () => {
    const state = (window as unknown as { __sb0Click: { downAt: number; paintAt: number; observer: MutationObserver | null } }).__sb0Click
    for (let wait = 0; wait < 100 && state.paintAt === 0; wait += 1) await new Promise((r) => setTimeout(r, 10))
    state.observer?.disconnect()
    return state.downAt === 0 || state.paintAt === 0 ? -1 : state.paintAt - state.downAt
  })
}

/**
 * Move the pointer onto one target and return pointermove -> first animation frame after the hover ring
 * names a different node than it did before the move, ms. A hover resolves to the layer at the selection
 * depth (the whole block around a heading), so the caller alternates between targets in different blocks:
 * a move inside the hovered block changes nothing to measure.
 */
async function hoverToRing(page: Page, content: Frame, target: ClickTarget): Promise<number> {
  await content.evaluate(() => {
    const ring = () => document.querySelector<HTMLElement>('[data-canvas-hover-ring]')
    const before = ring()?.getAttribute('data-canvas-overlay-node-id') ?? null
    const state = { before, moveAt: 0, ringAt: 0, paintAt: 0, observer: null as MutationObserver | null }
    ;(window as unknown as { __sb3Hover: typeof state }).__sb3Hover = state
    document.addEventListener('pointermove', () => { if (state.moveAt === 0) state.moveAt = performance.now() }, { capture: true, once: true })
    const check = () => {
      if (state.ringAt !== 0) return
      const el = ring()
      const id = el?.getAttribute('data-canvas-overlay-node-id') ?? null
      if (!el || el.style.display === 'none' || id === null || id === state.before) return
      state.ringAt = performance.now()
      requestAnimationFrame(() => { state.paintAt = performance.now() })
    }
    state.observer = new MutationObserver(check)
    state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-canvas-overlay-node-id'] })
  })
  await page.mouse.move(target.x, target.y, { steps: 2 })
  return content.evaluate(async () => {
    const state = (window as unknown as { __sb3Hover: { moveAt: number; paintAt: number; observer: MutationObserver | null } }).__sb3Hover
    for (let wait = 0; wait < 100 && state.paintAt === 0; wait += 1) await new Promise((r) => setTimeout(r, 10))
    state.observer?.disconnect()
    return state.moveAt === 0 || state.paintAt === 0 ? -1 : state.paintAt - state.moveAt
  })
}

/** One target per vertical quarter of the visible targets (the corpus screen is four stacked blocks), in an order that never repeats a block back to back. */
function hoverSequence(targets: ClickTarget[], length: number): ClickTarget[] {
  const sorted = [...targets].sort((a, b) => a.y - b.y)
  const quarter = Math.floor(sorted.length / 4)
  const perBlock = [0, 1, 2, 3].map((block) => sorted[block * quarter + Math.floor(quarter / 2)]!)
  const order = [0, 2, 1, 3]
  return Array.from({ length }, (_, i) => perBlock[order[i % 4]!]!)
}

test.describe('board-scale budgets on the 100 x 140 corpus', () => {
  for (const shape of [SCALE_BOARD_SHAPE, LARGE_BOARD_SHAPE]) {
    test(`attribution (${shape.frameCount} frames x ${shape.sectionsPerScreen} sections): where a click task goes`, async ({ page }) => {
      const own = shape === SCALE_BOARD_SHAPE ? fixture : writeLargeBoardCorpus(shape)
      try {
        const { frameEl, content } = await openLargeBoardAtWorkingZoom(page, own, largeBoardPageId(0))
        const targets = await clickTargets(page, frameEl, content)
        expect(targets.length, 'too few click targets on screen').toBeGreaterThanOrEqual(CLICK_SAMPLES)
        // Warm-up click, untraced: the first selection arms lazy observers.
        await clickToRing(page, content, targets[0]!)
        await page.waitForTimeout(600)

        const reports = []
        for (const target of targets.slice(1, 1 + 4)) {
          const report = await traceGesture(page, async () => {
            await page.keyboard.down('ControlOrMeta')
            await page.mouse.click(target.x, target.y)
            await page.keyboard.up('ControlOrMeta')
            await page.waitForTimeout(500)
          })
          reports.push(report)
          await page.waitForTimeout(400)
        }
        const cpu = await profileCpu(page, async () => {
          for (const target of targets.slice(5, 5 + 3)) {
            await page.keyboard.down('ControlOrMeta')
            await page.mouse.click(target.x, target.y)
            await page.keyboard.up('ControlOrMeta')
            await page.waitForTimeout(400)
          }
        })
        dump(`click-attribution-${shape.frameCount}x${shape.sectionsPerScreen}`, { counts: await readBoardCounts(page), reports, cpu })
        const tag = `${shape.frameCount}f`
        for (const [i, r] of reports.entries()) {
          annotate(`[${tag}] click ${i}: longest task`, `${r.longestTaskMs.toFixed(1)}ms`)
          annotate(
            `[${tag}] click ${i}: top kinds`,
            r.kinds
              .slice(0, 6)
              .map((k) => `${k.name} x${k.count} ${k.totalMs.toFixed(1)}ms (${k.frames} frames)`)
              .join(' | '),
          )
          annotate(
            `[${tag}] click ${i}: style/layout`,
            `${r.layoutByFrame.length} frames touched; ${r.layoutByFrame
              .slice(0, 3)
              .map((f) => `${f.frame.slice(0, 6)} style ${f.styleMs.toFixed(1)}/layout ${f.layoutMs.toFixed(1)}`)
              .join(', ')}`,
          )
        }
        annotate(`[${tag}] cpu by file (3 clicks)`, cpu.byFile.slice(0, 6).map((f) => `${f.file} ${f.selfMs.toFixed(1)}ms`).join(' | '))
        annotate(`[${tag}] cpu hotspots (3 clicks)`, cpu.hotspots.slice(0, 10).map((h) => `${h.where} ${h.selfMs.toFixed(1)}ms`).join(' | '))
        // The harness must have seen the click; the SIZE of the task is the finding, not a gate here.
        expect(reports.every((r) => r.traceEvents > 0 && r.longestTaskMs > 0)).toBe(true)
      } finally {
        if (own !== fixture) removeFixtureProject(own)
      }
    })
  }

  test('click -> ring p95 on a live frame', { tag: '@production-bundle' }, async ({ page }) => {
    // Measured 2026-10-10 (preview, this box): see the `click -> ring` annotation; the plan's target is 16 ms.
    test.fail(true, 'p95 40.0ms measured 2026-10-10 (preview); target 16 ms (plan §7). SB-4 draws the ring from a parent-side index')
    const { frameEl, content } = await open(page)
    const targets = await clickTargets(page, frameEl, content)
    expect(targets.length).toBeGreaterThanOrEqual(CLICK_SAMPLES + 1)
    await clickToRing(page, content, targets[0]!)
    await page.waitForTimeout(500)
    const samples: number[] = []
    for (const target of targets.slice(1, 1 + CLICK_SAMPLES)) {
      const ms = await clickToRing(page, content, target)
      expect(ms, `no ring for ${target.id} within 1 s`).toBeGreaterThan(0)
      samples.push(ms)
      await page.waitForTimeout(250)
    }
    annotate('click -> ring samples', samples.map((n) => n.toFixed(1)).join(', '))
    annotate('click -> ring p95', `${p95(samples).toFixed(1)}ms`)
    expect(p95(samples)).toBeLessThanOrEqual(TARGET_CLICK_TO_RING_P95_MS)
  })

  test('hover -> ring p95 on a live frame', { tag: '@production-bundle' }, async ({ page }) => {
    const { frameEl, content } = await open(page)
    const targets = await clickTargets(page, frameEl, content)
    expect(targets.length).toBeGreaterThanOrEqual(HOVER_SAMPLES + 1)
    await hoverToRing(page, content, hoverSequence(targets, 4)[3]!)
    await page.waitForTimeout(300)
    const samples: number[] = []
    for (const target of hoverSequence(targets, HOVER_SAMPLES)) {
      const ms = await hoverToRing(page, content, target)
      expect(ms, `no hover ring for ${target.id} within 1 s`).toBeGreaterThan(0)
      samples.push(ms)
      await page.waitForTimeout(150)
    }
    annotate('hover -> ring samples', samples.map((n) => n.toFixed(1)).join(', '))
    annotate('hover -> ring p95', `${p95(samples).toFixed(1)}ms`)
    expect(p95(samples)).toBeLessThanOrEqual(HOVER_TO_RING_P95_BUDGET_MS)
  })

  test('pan: p95 frame <= one vsync, none over 20 ms, over a scripted 1 s pan', { tag: '@production-bundle' }, async ({ page }) => {
    test.fail(true, 'p95 17.9ms / worst 23.7ms measured 2026-10-10 (preview); target p95 <= 17 ms and 0 frames over 20 ms. SB-5/SB-6 cap live documents and composite posters')
    const { canvasRoot } = await open(page)
    const box = await canvasRoot.boundingBox()
    if (!box) throw new Error('the canvas root has no bounding box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const profile = await profileGesture(page, async () => {
      for (let i = 0; i < 25; i += 1) {
        await page.mouse.wheel(60, 30)
        await page.waitForTimeout(40)
      }
    })
    annotate('pan p95 / worst / mean', `${profile.p95FrameMs.toFixed(1)} / ${profile.worstFrameMs.toFixed(1)} / ${profile.meanFrameMs.toFixed(1)}ms over ${profile.frames} frames`)
    annotate('pan frames > 20ms', String(profile.framesOver20ms))
    expect(profile.p95FrameMs).toBeLessThanOrEqual(TARGET_FRAME_P95_MS)
    expect(profile.framesOver20ms).toBeLessThanOrEqual(TARGET_FRAMES_OVER_20MS)
  })

  test('zoom 1 -> 0.1 -> 1: p95 frame <= one vsync, none over 20 ms', { tag: '@production-bundle' }, async ({ page }) => {
    test.fail(true, 'p95 21.7ms / worst 23.8ms measured 2026-10-10 (preview); target p95 <= 17 ms and 0 frames over 20 ms. Promotion deferred to settle (SB-5)')
    const { canvasRoot } = await open(page)
    const profile = await profileGesture(page, async () => {
      await wheelZoom(page, canvasRoot, 12, 120)
      await wheelZoom(page, canvasRoot, 12, -120)
    })
    annotate('zoom p95 / worst / mean', `${profile.p95FrameMs.toFixed(1)} / ${profile.worstFrameMs.toFixed(1)} / ${profile.meanFrameMs.toFixed(1)}ms over ${profile.frames} frames`)
    annotate('zoom frames > 20ms', String(profile.framesOver20ms))
    expect(profile.p95FrameMs).toBeLessThanOrEqual(TARGET_FRAME_P95_MS)
    expect(profile.framesOver20ms).toBeLessThanOrEqual(TARGET_FRAMES_OVER_20MS)
  })

  test('mounted iframes at rest <= live cap + 2', { tag: '@production-bundle' }, async ({ page }) => {
    // Measured 8 on 2026-10-10 (preview, 1920x1080, working zoom): exactly the pool floor, so this is a hard gate that
    // keeps the floor from growing. Plan §7's "20" was the 12-frame board at a different zoom.
    await open(page)
    await page.waitForTimeout(3000)
    const counts = await readBoardCounts(page)
    annotate('iframes / mounted frames / board frames / posters', `${counts.liveIframes} / ${counts.mountedFrames} / ${counts.boardFrames} / ${counts.posters}`)
    annotate('DOM nodes (parent document)', String(counts.domNodes))
    expect(counts.liveIframes).toBeLessThanOrEqual(TARGET_MAX_IFRAMES)
  })

  test(`documents and listeners are flat over ${ZOOM_CYCLES} zoom cycles`, { tag: '@production-bundle' }, async ({ page }) => {
    const { canvasRoot } = await open(page)
    // Cycle 1 mounts the working set for the first time; the leak is the slope after it.
    await zoomCycle(page, canvasRoot)
    const baseline = await readDomCounters(page)
    const baselineIframes = (await readBoardCounts(page)).liveIframes
    const series = [baseline]
    for (let cycle = 2; cycle <= ZOOM_CYCLES; cycle += 1) {
      await zoomCycle(page, canvasRoot)
      if (cycle % 5 === 0) series.push(await readDomCounters(page))
    }
    const last = series[series.length - 1]!
    const lastIframes = (await readBoardCounts(page)).liveIframes
    dump('zoom-cycle-counters', { baseline, series, baselineIframes, lastIframes })
    annotate('documents per 5 cycles', series.map((s) => s.documents).join(' -> '))
    annotate('listeners per 5 cycles', series.map((s) => s.jsEventListeners).join(' -> '))
    annotate('nodes per 5 cycles', series.map((s) => s.nodes).join(' -> '))
    annotate('iframes cycle 1 -> 20', `${baselineIframes} -> ${lastIframes}`)
    expect(last.documents - baseline.documents, 'documents grew across zoom cycles').toBeLessThanOrEqual(LEAK_DOC_TOLERANCE)
    expect(last.jsEventListeners - baseline.jsEventListeners, 'JS listeners grew across zoom cycles').toBeLessThanOrEqual(
      Math.max(50, baseline.jsEventListeners * 0.05),
    )
  })

  test('poster refresh: one edited frame is re-photographed with a main-thread task <= 15 ms', { tag: '@production-bundle' }, async ({ page }) => {
    const { content } = await open(page)
    const heading = content.locator('.block__heading').nth(1)
    await selectInFrame(page, heading)
    const original = (await heading.textContent())?.trim() ?? ''
    const fields = page.locator('input:visible, textarea:visible')
    let textField: Locator | null = null
    for (let i = 0; i < (await fields.count()); i += 1) {
      if ((await fields.nth(i).inputValue().catch(() => '')) === original) {
        textField = fields.nth(i)
        break
      }
    }
    if (!textField) throw new Error(`no inspector field holds the heading's text ("${original}")`)
    await textField.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' edited')
    await page.keyboard.press('Tab')
    await expect(heading).toContainText('edited', { timeout: 10_000 })
    // Let the edit's own render, autosave and settle passes finish: what is left under the trace is the poster queue.
    await page.waitForTimeout(250)
    const startedAt = await page.evaluate(() => performance.now())
    const tasks = await traceMainThreadTasks(page, () => page.waitForTimeout(2500))
    const captures = await page.evaluate(
      ({ since, name }) =>
        performance
          .getEntriesByName(name)
          .filter((entry) => entry.startTime >= since)
          .map((entry) => ({ pageId: (entry as PerformanceMeasure).detail?.pageId as string, ms: entry.duration })),
      { since: startedAt, name: POSTER_CAPTURE_MEASURE },
    )
    dump('poster-refresh', { tasks: tasks.tasksMs.slice(0, 10), captures })
    annotate('poster refresh: captures in window', captures.map((c) => `${c.pageId} ${c.ms.toFixed(0)}ms wall`).join(', ') || '(none)')
    annotate('poster refresh: longest main-thread tasks (ms)', tasks.tasksMs.slice(0, 6).map((n) => n.toFixed(1)).join(', '))
    expect(captures.length, 'the edited frame was never re-photographed').toBeGreaterThan(0)
    expect(tasks.longestMs).toBeLessThanOrEqual(TARGET_POSTER_REFRESH_MAIN_MS)
  })

  test('poster -> live: a frame that was a picture becomes a readable document in <= 250 ms', { tag: '@production-bundle' }, async ({ page }) => {
    const { canvasRoot, frameEl, content } = await open(page)
    const firstId = largeBoardPageId(0)
    mkdirSync('.tmp/board-speed', { recursive: true })
    await frameEl.screenshot({ path: '.tmp/board-speed/poster-sample-live.png' })
    // Where the live frame's last piece of content ends, as a fraction of its document height. The frame is taller than
    // the 800 px its body is pinned to, so a poster that clips at the pin comes out blank below that fraction.
    const live = await content.evaluate(() => {
      let bottom = 0
      for (const el of document.querySelectorAll('.row__label')) bottom = Math.max(bottom, el.getBoundingClientRect().bottom)
      return { docHeight: document.documentElement.scrollHeight, contentBottom: bottom, bodyHeight: document.body.offsetHeight }
    })
    expect(live.docHeight, 'the corpus frame must be taller than its pinned body, or this test proves nothing').toBeGreaterThan(live.bodyHeight + 100)
    // Frame 0 has been live: wait for its picture, then send the viewport far away so the pool lets it go.
    await expect
      .poll(() => page.evaluate(({ name, id }) => performance.getEntriesByName(name).some((e) => (e as PerformanceMeasure).detail?.pageId === id), { name: POSTER_CAPTURE_MEASURE, id: firstId }), {
        timeout: 20_000,
      })
      .toBe(true)
    await frameForPage(page, canvasRoot, largeBoardPageId(80))
    await page.waitForTimeout(3000)
    const posterLocator = page.locator(`[data-page-id="${firstId}"] [data-testid="board-frame-poster"]`)
    await expect(posterLocator, 'frame 0 left the screen and showed no picture').toBeAttached()
    // Read the picture back (an element screenshot of an off-screen, transformed <img> comes out black): it must hold
    // real content, not a transparent or blank bitmap.
    const picture = await posterLocator.evaluate(async (img) => {
      const el = img as HTMLImageElement
      await el.decode()
      const canvas = document.createElement('canvas')
      canvas.width = el.naturalWidth
      canvas.height = el.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(el, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let opaque = 0
      let inked = 0
      let lastInkedRow = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) opaque += 1
        if (data[i + 3] > 0 && (data[i]! < 235 || data[i + 1]! < 235 || data[i + 2]! < 235)) {
          inked += 1
          lastInkedRow = Math.max(lastInkedRow, Math.floor(i / 4 / canvas.width))
        }
      }
      return { width: canvas.width, height: canvas.height, opaque, inked, lastInkedRow, png: canvas.toDataURL('image/png') }
    })
    writeFileSync('.tmp/board-speed/poster-sample-poster.png', Buffer.from(picture.png.split(',')[1]!, 'base64'))
    annotate('poster bitmap', `${picture.width}x${picture.height}, opaque ${picture.opaque}, inked ${picture.inked}`)
    expect(picture.opaque, 'the poster is fully transparent').toBeGreaterThan(picture.width * picture.height * 0.9)
    // Fidelity against the live frame: the picture reaches as far down as the content does.
    const expectedLastRow = Math.round((live.contentBottom / live.docHeight) * picture.height)
    annotate('poster fidelity: last inked row / live content bottom', `${picture.lastInkedRow} / ${expectedLastRow} of ${picture.height}`)
    expect(picture.lastInkedRow, 'the poster is blank below where the live frame still has content (clipped at the pinned body height?)').toBeGreaterThanOrEqual(expectedLastRow - 0.03 * picture.height)
    expect(picture.inked, 'the poster is blank').toBeGreaterThan(picture.width * picture.height * 0.02)
    type Probe = { iframeAt: number; contentAt: number }
    await page.evaluate((id) => {
      const state: Probe = { iframeAt: 0, contentAt: 0 }
      ;(window as unknown as { __sb2: Probe }).__sb2 = state
      const tick = () => {
        const body = document.querySelector(`[data-page-id="${id}"] [data-testid="board-frame-body"]`)
        const iframe = body?.querySelector('iframe[title^="Canvas frame"]') as HTMLIFrameElement | null | undefined
        if (iframe && state.iframeAt === 0) state.iframeAt = performance.now()
        if (iframe && state.contentAt === 0 && iframe.contentDocument?.querySelector('.row__label')) state.contentAt = performance.now()
        if (state.contentAt === 0) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, firstId)
    await frameForPage(page, canvasRoot, firstId)
    await page.waitForTimeout(500)
    const probe = await page.evaluate(() => (window as unknown as { __sb2: Probe }).__sb2)
    const ms = probe.contentAt - probe.iframeAt
    annotate('poster -> live (iframe attached -> first node present)', `${ms.toFixed(0)}ms`)
    expect(probe.contentAt, 'the frame never reached a live document').toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(TARGET_POSTER_TO_LIVE_MS)
  })
})
