import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Frame, type Locator, type Page } from '@playwright/test'
import { profileGesture, readBoardCounts } from './helpers/canvasPerf'
import { profileCpu, readDomCounters, traceGesture } from './helpers/cdpTrace'
import { visibleCanvasIframe } from './helpers/canvasIframe'
import { LARGE_BOARD_SHAPE, largeBoardPageId, openLargeBoardAtWorkingZoom, SCALE_BOARD_SHAPE, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { removeFixtureProject, type FixtureProject } from './helpers/studioFixtureProject'

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
})
