import { expect, test, type Frame, type Locator, type Page } from '@playwright/test'
import { profileGesture, readBoardCounts } from './helpers/canvasPerf'
import { largeBoardPageId, openLargeBoardAtWorkingZoom, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import {
  SELECTION_RING,
  clickInFrame,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { visibleCanvasIframe } from './helpers/canvasIframe'
import { E2E_VITE_MODE } from '../../scripts/lib/e2eStack'

/**
 * The feel budgets on a LARGE board — ROADMAP P2-A, audit `01-perf.md` §3
 * items 5, 6 and 7, on the 40-frame × ~300-element corpus of item 2
 * (`helpers/largeBoardCorpus.ts`).
 *
 * Six tests, all against the same board at the same zoom:
 *
 *   - **hover sweep** — a pointer crossing 50 elements in a frame, with nine
 *     frames mounted. Every crossing used to be a store write that swept every
 *     mounted node's selectors (PERF-1, fixed in P2-I) and to re-run the
 *     frame's two full-document layout passes because the hover ring mounted
 *     inside the observed `<body>` (PERF-2, fixed in P2-A).
 *   - **Layers-panel hover sweep** — the same, from the Layers panel, whose
 *     hover carries no frame id and so used to arm chrome in EVERY mounted
 *     frame (PERF-13 × PERF-2).
 *   - **pan with a selection** — the selection toolbar must stay on the ring
 *     WHILE the board moves, not freeze and jump ~100 ms after (PERF-3).
 *   - **warm click -> ring** — WS-5.6's "selection -> ring paint" (P2-I).
 *   - **post-edit pause** — the frame being edited is never rasterized into a
 *     poster under the user (PERF-5, P2-I).
 *   - **idle** — a board with a selection that nobody touches must let the
 *     main thread sleep: zero `requestAnimationFrame` calls from the app
 *     (PERF-4's ruler loops were two permanent 60 Hz loops).
 *
 * Every budget below was calibrated on this spec's own runs; the before/after
 * numbers are in the P2-A and P2-I PRs. Nothing here writes a file: the board
 * opens with autosave off, so the post-edit case's edit stays in memory.
 */

/**
 * **Hover sweeps: no animation frame over this.** The roadmap's target is
 * 20 ms (one missed vsync at most). Measured on this Windows box, dev build:
 *
 * | | before P2-A | after P2-A | after P2-I |
 * |---|---|---|---|
 * | canvas hover, worst frame | 148–198 ms | 124–183 ms | 20.9–30.3 ms |
 * | canvas hover, frames > 20 ms | ~49/195 | 48–49/~196 | 3–19/~137 |
 * | Layers hover, worst frame | 185.7 ms | 111–150 ms | 20.4–25.6 ms |
 *
 * P2-A took the chrome's tree mutations out of a hover (asserted exactly
 * below, as a count). P2-I took hover out of the editor store
 * (`canvasHover.ts`), so a crossing no longer sweeps ~40k per-node selectors.
 * Set at ~1.5× the worst P2-I run: a regression of PERF-1's size (a store
 * write per crossing) fails by a factor of four.
 */
const BUDGET_HOVER_SWEEP_WORST_FRAME_MS = 45

/** **Layers-panel hover sweep** — same reasoning; ~1.5× the worst P2-I run. */
const BUDGET_LAYERS_HOVER_WORST_FRAME_MS = 40

/**
 * **Pan with a selection: the toolbar's worst distance from where the ring
 * says it should be, mid-gesture, in px.** Before P2-A the toolbar froze for
 * the whole gesture and this read the full pan distance (hundreds of px).
 * After, the toolbar is re-projected from a board-space anchor on every
 * transform write, so it moves in the same task as the frame. 2 px absorbs
 * sub-pixel rounding between the iframe's scaled rect and the toolbar's
 * integer `left`/`top`.
 */
const BUDGET_PAN_TOOLBAR_DRIFT_PX = 2

/**
 * **Idle: `requestAnimationFrame` calls per second, summed over the editor
 * document and every canvas frame document.** The audit's target is zero, and
 * after P2-A it is: nothing in the editor polls.
 */
const BUDGET_IDLE_RAF_PER_SECOND = 0

/**
 * **Warm click -> selection ring painted, mean over the samples.** WS-5.6's
 * target is 32 ms in a production build.
 *
 * Dev build: trunk 292–440 ms before P2-I (every click re-rendered all ~2,800
 * mounted `NodeRenderer`s through an unstable `CanvasSelectionContext`), 78–85
 * ms after it on a quiet box; 144–152 ms on this loaded box at the start of
 * P6-C, 74.9 ms (61–88) after it. 120 is ~1.4× the worst P2-I mean.
 *
 * Production bundle (`E2E_VITE_MODE=preview`, the `@production-bundle` pass):
 * 61.6 ms (55–67) at the start of P6-C, **47.1 ms (41–55)** after it. P6-C's
 * cuts, in order of size: a canvas click made two store writes that changed
 * nothing, each sweeping every mounted node's selectors
 * (`skipUnchangedSets`); `CanvasRoot` was silently skipped by the React
 * Compiler, so all nine mounted frames re-rendered their selection chrome on
 * every click; the Assets panel re-rendered 46 cards per click.
 *
 * **WS-5.6's 32 ms is NOT met.** 75 is a ratchet at ~1.35× the worst
 * production run, not the target. What remains in a click, from the
 * production profile: the one real store write's selector sweep over ~2,800
 * `NodeRenderer`s (~8 ms), the inspector's re-render for the new node (~45
 * buttons and tooltips — `Button` and `Tooltip` are among the ~170 files the
 * compiler skips, P6-C's "Found, not fixed"), the owning frame's uncompiled
 * `BreakpointSelectionOverlay`, and style/layout of the frame.
 */
const WARM_CLICK_SAMPLES = 8
const BUDGET_WARM_CLICK_TO_RING_MEAN_MS = E2E_VITE_MODE === 'preview' ? 75 : 120

/**
 * **Post-edit pause** — how long the board is watched after an edit commits:
 * the poster queue's 700 ms quiet period plus one ~1 s rasterization of a
 * 310-element frame (measured: 880–1,160 ms each). Before P2-I the edited
 * frame was rasterized ~600 ms into this window (worst frame 1,139.7 ms).
 */
const POST_EDIT_PAUSE_MS = 2500
/** `useFramePosterCapture.ts`'s User Timing measure name. */
const POSTER_CAPTURE_MEASURE = 'studio:poster-capture'

/** The frame every case works in: the first one, which `Ctrl+0` brings on screen. */
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
  console.log(`[p2-a] ${label}: ${value}`)
}

/** Open the corpus at the working zoom — see `openLargeBoardAtWorkingZoom`. */
function openAtWorkingZoom(page: Page): Promise<{ canvasRoot: Locator; frameEl: Locator; content: Frame }> {
  return openLargeBoardAtWorkingZoom(page, fixture, TARGET_PAGE_ID)
}

test.describe('P2-A feel budgets on the 40 x 300 corpus', () => {
  test.setTimeout(240_000)

  test('hover sweep: crossing 50 elements drops no animation frame past the budget', async ({ page }) => {
    const { frameEl } = await openAtWorkingZoom(page)
    const counts = await readBoardCounts(page)
    annotate('hover sweep: live iframes', String(counts.liveIframes))
    annotate('hover sweep: board frames', String(counts.boardFrames))

    const iframeBox = await visibleCanvasIframe(frameEl).boundingBox()
    if (!iframeBox) throw new Error('the target iframe has no bounding box')
    const content = await (await visibleCanvasIframe(frameEl).elementHandle())!.contentFrame()
    // Element centres in the iframe's own coordinates, mapped to the page
    // through the iframe's rendered box (the canvas zoom is a CSS scale).
    const points = await content!.evaluate(() => {
      const scaleProbe = document.documentElement.clientWidth
      const targets = Array.from(document.querySelectorAll('.row__label, .row__value, .block__heading'))
        .slice(0, 60)
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))
      return { scaleProbe, targets }
    })
    const scale = iframeBox.width / points.scaleProbe
    const pagePoints = points.targets
      .map((p) => ({ x: iframeBox.x + p.x * scale, y: iframeBox.y + p.y * scale }))
      .filter((p) => p.y < 1080 - 10)
    expect(pagePoints.length, 'fewer than 50 hover targets are on screen').toBeGreaterThanOrEqual(50)

    // Warm-up: the first hover ring, the first selector evaluation.
    for (const point of pagePoints.slice(0, 5)) {
      await page.mouse.move(point.x, point.y)
      await page.waitForTimeout(30)
    }

    // Diagnostic, not a budget: tree mutations INSIDE the hovered frame that
    // are not the editor's own chrome. Each one reaches the frame's
    // auto-height observer, which re-derives the fit with a full-document
    // forced layout — so a non-zero count names a cost this sweep is paying.
    await content!.evaluate(() => {
      const chromeRoot = 'studio-canvas-selection-overlay-root'
      const inChrome = (node: Node | null) => {
        const element = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)
        return element?.closest(`#${chromeRoot}`) != null
      }
      const state = { contentChildList: 0, chromeChildList: 0, observer: null as MutationObserver | null }
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type !== 'childList') continue
          const touched = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
          if (inChrome(record.target) || (touched.length > 0 && touched.every(inChrome))) state.chromeChildList += 1
          else state.contentChildList += 1
        }
      })
      state.observer.observe(document.body, { childList: true, subtree: true })
      ;(window as unknown as { __p2aHoverMutations: typeof state }).__p2aHoverMutations = state
    })
    const sweep = await profileGesture(page, async () => {
      for (const point of pagePoints.slice(0, 50)) {
        await page.mouse.move(point.x, point.y)
        await page.waitForTimeout(25)
      }
    })
    const mutations = await content!.evaluate(() => {
      const state = (window as unknown as { __p2aHoverMutations: { contentChildList: number; chromeChildList: number; observer: MutationObserver } })
        .__p2aHoverMutations
      state.observer.disconnect()
      return { content: state.contentChildList, chrome: state.chromeChildList }
    })
    annotate('hover sweep: frame tree mutations (content / chrome)', `${mutations.content} / ${mutations.chrome}`)
    // PERF-2: the hover ring stays mounted, so hover never mutates the frame's tree.
    expect(mutations.chrome).toBe(0)
    annotate('hover sweep: worst frame', `${sweep.worstFrameMs.toFixed(1)}ms`)
    annotate('hover sweep: mean frame', `${sweep.meanFrameMs.toFixed(1)}ms`)
    annotate('hover sweep: frames >20ms', `${sweep.framesOver20ms}/${sweep.frames}`)
    expect(sweep.frames).toBeGreaterThan(20)
    expect(sweep.worstFrameMs).toBeLessThan(BUDGET_HOVER_SWEEP_WORST_FRAME_MS)
  })

  test('Layers-panel hover sweep: a row hover arms chrome in the owning frame only', async ({ page }) => {
    const { content } = await openAtWorkingZoom(page)
    // Selecting a node on the canvas expands its page's layer tree, which is
    // what puts rows on screen to hover.
    await clickInFrame(page, content.locator('.block__heading').nth(1))
    const rows = page.locator('[data-testid^="dom-tree-item-"]')
    await expect(rows.nth(8)).toBeVisible({ timeout: 15_000 })
    const boxes: Array<{ x: number; y: number; width: number; height: number }> = []
    for (let i = 0; i < Math.min(await rows.count(), 24); i += 1) {
      const box = await rows.nth(i).boundingBox()
      if (box && box.height > 0 && box.y > 0 && box.y < 1080 - 10) boxes.push(box)
    }
    expect(boxes.length, 'fewer than 8 layer rows are on screen').toBeGreaterThanOrEqual(8)

    // Diagnostic: tree mutations in EVERY mounted frame, split into page
    // content and the editor's own chrome. A Layers hover carries no frame, so
    // before PERF-13 it armed rings in every mounted frame — and before PERF-2
    // each of those mounts re-ran that frame's two full-document layout passes.
    const frames = page.frames().filter((frame) => frame !== page.mainFrame())
    await Promise.all(
      frames.map((frame) =>
        frame
          .evaluate(() => {
            const inChrome = (node: Node | null) => {
              const element = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null)
              return element?.closest('#studio-canvas-selection-overlay-root') != null
            }
            const state = { chrome: 0, observer: null as MutationObserver | null }
            state.observer = new MutationObserver((records) => {
              for (const record of records) {
                const touched = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
                if (record.type === 'childList' && (inChrome(record.target) || (touched.length > 0 && touched.every(inChrome)))) state.chrome += 1
              }
            })
            if (document.body) state.observer.observe(document.body, { childList: true, subtree: true })
            ;(window as unknown as { __p2aLayerHover: typeof state }).__p2aLayerHover = state
          })
          .catch(() => undefined),
      ),
    )

    const sweep = await profileGesture(page, async () => {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const box of boxes) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.waitForTimeout(40)
        }
      }
    })
    const chromeMutations = (
      await Promise.all(
        frames.map((frame) =>
          frame
            .evaluate(() => {
              const state = (window as unknown as { __p2aLayerHover?: { chrome: number; observer: MutationObserver } }).__p2aLayerHover
              state?.observer.disconnect()
              return state?.chrome ?? 0
            })
            .catch(() => 0),
        ),
      )
    ).reduce((sum, n) => sum + n, 0)
    annotate('layers hover: rows swept', String(boxes.length * 2))
    annotate('layers hover: chrome tree mutations across all frames', String(chromeMutations))
    annotate('layers hover: worst frame', `${sweep.worstFrameMs.toFixed(1)}ms`)
    annotate('layers hover: mean frame', `${sweep.meanFrameMs.toFixed(1)}ms`)
    annotate('layers hover: frames >20ms', `${sweep.framesOver20ms}/${sweep.frames}`)
    expect(chromeMutations).toBe(0)
    expect(sweep.worstFrameMs).toBeLessThan(BUDGET_LAYERS_HOVER_WORST_FRAME_MS)
  })

  test('pan with a selection: the toolbar stays on the ring mid-gesture', async ({ page }) => {
    const { canvasRoot, content } = await openAtWorkingZoom(page)
    const target = content.locator('.block__heading').nth(1)
    await clickInFrame(page, target)
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    const toolbar = page.locator('[data-canvas-selection-toolbar="true"]')
    await expect(toolbar).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(600)

    // Sample, every animation frame, where the toolbar is relative to where
    // the ring is — both in page coordinates. The ring lives inside the
    // iframe, so its page rect is the iframe's rendered box plus the ring's
    // in-frame rect times the canvas zoom.
    await page.evaluate(() => {
      const iframe = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[title^="Canvas frame"]')).find(
        (f) => f.contentDocument?.querySelector('[data-canvas-selection-ring="true"]'),
      )
      if (!iframe) throw new Error('no canvas iframe holds a selection ring')
      const state = { samples: [] as Array<{ dx: number; dy: number }>, handle: 0 }
      const tick = () => {
        const bar = document.querySelector('[data-canvas-selection-toolbar="true"]')
        const ring = iframe.contentDocument?.querySelector('[data-canvas-selection-ring="true"]')
        if (bar && ring && iframe.offsetWidth > 0) {
          const frameRect = iframe.getBoundingClientRect()
          const scale = frameRect.width / iframe.offsetWidth
          const ringRect = ring.getBoundingClientRect()
          const barRect = bar.getBoundingClientRect()
          if (barRect.width > 0) {
            state.samples.push({
              dx: barRect.left - (frameRect.left + ringRect.left * scale),
              dy: barRect.top - (frameRect.top + ringRect.top * scale),
            })
          }
        }
        state.handle = requestAnimationFrame(tick)
      }
      state.handle = requestAnimationFrame(tick)
      ;(window as unknown as { __p2aToolbarDrift: typeof state }).__p2aToolbarDrift = state
    })

    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('canvas root has no bounding box')
    await page.mouse.move(rootBox.x + 40, rootBox.y + rootBox.height - 40)
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.wheel(24, 16)
      await page.waitForTimeout(40)
    }

    const samples = await page.evaluate(() => {
      const state = (window as unknown as { __p2aToolbarDrift: { samples: Array<{ dx: number; dy: number }>; handle: number } })
        .__p2aToolbarDrift
      cancelAnimationFrame(state.handle)
      return state.samples
    })
    expect(samples.length, 'the sampler saw no frame with both the toolbar and the ring').toBeGreaterThan(10)
    const [first] = samples
    const drift = Math.max(...samples.map((s) => Math.max(Math.abs(s.dx - first!.dx), Math.abs(s.dy - first!.dy))))
    annotate('pan with selection: samples', String(samples.length))
    annotate('pan with selection: worst toolbar drift', `${drift.toFixed(1)}px`)
    expect(drift).toBeLessThanOrEqual(BUDGET_PAN_TOOLBAR_DRIFT_PX)
  })

  test('warm click -> selection ring: the ring is on screen within budget', { tag: '@production-bundle' }, async ({ page }) => {
    // WS-5.6's "selection -> ring paint", never built until P2-I (PERF-14):
    // pointerdown in the frame to the first animation frame after the ring
    // for THAT node exists, on the same clock (the frame's own document).
    // Warm: one selection first, so this is the steady state, not the
    // lazily-armed observers of the first one (`studio-board-perf`'s cold
    // click measures that).
    const { frameEl, content } = await openAtWorkingZoom(page)
    const warmUp = content.locator('.block__heading').nth(1)
    const warmUpId = await warmUp.getAttribute('data-node-id')
    await clickInFrame(page, warmUp)
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    await page.waitForTimeout(500)

    // Targets that are actually under the viewport, in page coordinates (the
    // canvas zoom is a CSS scale on the iframe) — same mapping as the hover sweep.
    const iframeBox = await visibleCanvasIframe(frameEl).boundingBox()
    if (!iframeBox) throw new Error('the target iframe has no bounding box')
    // Never the warm-up node: clicking the selection again paints no new ring.
    const probe = await content.evaluate((skip) => ({
      width: document.documentElement.clientWidth,
      targets: Array.from(document.querySelectorAll('.block__heading, .block__body'))
        .map((el) => ({ id: el.getAttribute('data-node-id'), rect: el.getBoundingClientRect() }))
        .filter((t) => t.id !== null && t.id !== skip && t.rect.width > 0)
        .map((t) => ({ id: t.id!, x: t.rect.left + t.rect.width / 2, y: t.rect.top + t.rect.height / 2 })),
    }), warmUpId)
    const scale = iframeBox.width / probe.width
    const targets = probe.targets
      .map((t) => ({ id: t.id, x: iframeBox.x + t.x * scale, y: iframeBox.y + t.y * scale }))
    // Only points where the frame itself is the top-most element — never under
    // a ruler, the floating toolbar or a panel.
    const hittable = await page.evaluate(
      (points) => points.map((p) => document.elementFromPoint(p.x, p.y)?.tagName === 'IFRAME'),
      targets,
    )
    const clickable = targets.filter((_, index) => hittable[index]).slice(0, WARM_CLICK_SAMPLES)
    expect(clickable.length, 'too few click targets on screen').toBe(WARM_CLICK_SAMPLES)

    const samples: number[] = []
    for (const [i, target] of clickable.entries()) {
      const nodeId = target.id
      await content.evaluate((id) => {
        const state = { downAt: 0, ringAt: 0, paintAt: 0, observer: null as MutationObserver | null }
        ;(window as unknown as { __p2iClick: typeof state }).__p2iClick = state
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
      }, nodeId)
      await page.mouse.click(target.x, target.y)
      const ms = await content.evaluate(async () => {
        const state = (window as unknown as { __p2iClick: { downAt: number; paintAt: number; observer: MutationObserver | null } }).__p2iClick
        for (let wait = 0; wait < 100 && state.paintAt === 0; wait += 1) await new Promise((r) => setTimeout(r, 10))
        state.observer?.disconnect()
        if (state.downAt === 0 || state.paintAt === 0) return -1
        return state.paintAt - state.downAt
      })
      expect(ms, `click ${i}: no ring for ${nodeId} painted within 1 s`).toBeGreaterThan(0)
      samples.push(ms)
      await page.waitForTimeout(250)
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    annotate('warm click -> ring paint: samples', samples.map((n) => n.toFixed(1)).join(', '))
    annotate('warm click -> ring paint: mean / worst', `${mean.toFixed(1)}ms / ${Math.max(...samples).toFixed(1)}ms`)
    expect(mean).toBeLessThan(BUDGET_WARM_CLICK_TO_RING_MEAN_MS)
  })

  test('post-edit pause: the frame being edited is not rasterized under the user', async ({ page }) => {
    // PERF-5 (P2-I) — an edit makes a new `Page`, and the poster effect used
    // to treat that as "no poster yet": 700 ms after the last keystroke the
    // queue rasterized the ON-SCREEN frame being edited (`html-to-image`,
    // 85–350 ms of main thread), right where the next click lands. Posters
    // now refresh only once a frame leaves the screen.
    const { content } = await openAtWorkingZoom(page)
    const heading = content.locator('.block__heading').nth(1)
    await clickInFrame(page, heading)
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    // Edit it the way a user most often does: the inspector's Text field.
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

    // The pause itself: past the queue's 700 ms quiet period plus a capture.
    // Every capture records a `studio:poster-capture` User Timing measure
    // (`useFramePosterCapture.ts`), so this counts the captures directly
    // rather than inferring them from frame times — an unrelated capture of
    // a pooled OFF-screen frame may legitimately run in the same window.
    const editedAt = await page.evaluate(() => performance.now())
    const pause = await profileGesture(page, async () => {
      await page.waitForTimeout(POST_EDIT_PAUSE_MS)
    })
    const captures = await page.evaluate(
      ({ since, name }) =>
        performance
          .getEntriesByName(name)
          .filter((entry) => entry.startTime >= since)
          .map((entry) => ({ pageId: (entry as PerformanceMeasure).detail?.pageId as string, ms: entry.duration })),
      { since: editedAt, name: POSTER_CAPTURE_MEASURE },
    )
    annotate('post-edit pause: worst frame', `${pause.worstFrameMs.toFixed(1)}ms`)
    annotate('post-edit pause: poster captures', captures.map((c) => `${c.pageId} ${c.ms.toFixed(0)}ms`).join(', ') || '(none)')
    expect(
      captures.filter((c) => c.pageId === TARGET_PAGE_ID),
      'the frame being edited was rasterized while the user was looking at it',
    ).toEqual([])
  })

  test('idle with a selection: the editor schedules no animation frames', async ({ page }) => {
    // Count every `requestAnimationFrame` call in every document the page
    // opens — the editor and each `srcdoc` canvas frame (init scripts run in
    // all of them) — keyed by the calling function, so a failure names the
    // loop instead of just counting it.
    await page.addInitScript(() => {
      const original = window.requestAnimationFrame.bind(window)
      const byCaller = new Map<string, number>()
      let total = 0
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        total += 1
        const caller = (new Error().stack ?? '').split('\n')[2]?.trim() ?? '?'
        byCaller.set(caller, (byCaller.get(caller) ?? 0) + 1)
        return original(callback)
      }
      ;(window as unknown as { __p2aRaf: () => { total: number; byCaller: Array<[string, number]> } }).__p2aRaf = () => ({
        total,
        byCaller: [...byCaller.entries()],
      })
    })
    const { content } = await openAtWorkingZoom(page)
    await clickInFrame(page, content.locator('.block__heading').nth(1))
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    // Let the click's own settle passes and the poster queue finish.
    await page.waitForTimeout(3000)

    const read = async () => {
      const perFrame = await Promise.all(
        page.frames().map((frame) =>
          frame
            .evaluate(() => {
              const probe = (window as unknown as { __p2aRaf?: () => { total: number; byCaller: Array<[string, number]> } }).__p2aRaf
              return probe ? probe() : null
            })
            .catch(() => null),
        ),
      )
      const byCaller = new Map<string, number>()
      let total = 0
      for (const entry of perFrame) {
        if (!entry) continue
        total += entry.total
        for (const [caller, n] of entry.byCaller) byCaller.set(caller, (byCaller.get(caller) ?? 0) + n)
      }
      return { total, byCaller }
    }
    const IDLE_MS = 2000
    const before = await read()
    await page.waitForTimeout(IDLE_MS)
    const after = await read()
    const perSecond = ((after.total - before.total) * 1000) / IDLE_MS
    const deltas = [...after.byCaller.entries()]
      .map(([caller, n]) => [caller, n - (before.byCaller.get(caller) ?? 0)] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    annotate('idle: rAF calls per second', perSecond.toFixed(1))
    annotate('idle: top callers', deltas.map(([caller, n]) => `${n}x ${caller}`).join(' | ') || '(none)')
    expect(perSecond).toBeLessThanOrEqual(BUDGET_IDLE_RAF_PER_SECOND)
  })
})
