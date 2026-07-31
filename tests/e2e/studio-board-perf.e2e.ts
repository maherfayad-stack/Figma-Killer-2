import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser perf measurement for `perf-01` (WS-5.3 / WS-5.4).
 *
 * `scripts/bench/studioBoard.bench.ts` is the synthetic 50-frame gate, but it
 * **cannot run on this platform**: Playwright drives Chromium over
 * `--remote-debugging-pipe`, and Bun on Windows does not wire the extra
 * stdio fds that transport needs, so `chromium.launch()` hangs until its
 * timeout (verified: the identical launch returns in 72 ms under Node,
 * hangs for 180 s under Bun; `connectOverCDP` over a TCP port hangs in
 * Bun's WebSocket client too). The bench then took its own "skip
 * gracefully" branch and reported success — a perf gate that structurally
 * could not fail. See `scripts/bench/lib/browser.ts` and the `perf-01`
 * `STATE.md` entry.
 *
 * The Playwright **test runner** spawns Node, not Bun, so this file is the
 * one place in the repo that can actually measure canvas frame time. It runs
 * against the REAL corpus (`studio-workspace/maherfayad-stack-eSIM`, 15
 * pages / ~803 nodes) and read-only — it pans, zooms and counts, and never
 * writes to the project.
 *
 * What each assertion is actually evidence of:
 *
 * - **WS-5.3 (virtualization)** — `liveIframeCount` at a working zoom is
 *   strictly below the board's frame count. Pre-virtualization every frame
 *   mounted an iframe as soon as the document hit the store
 *   (`CanvasTransformLayer.tsx`'s own comment: "All frames mount as soon as
 *   the page document is in the store"), so the board's frame count IS the
 *   honest "before" number for this metric.
 * - **WS-5.4 (no React re-render on pan/zoom)** — a `MutationObserver` over
 *   the frames layer during a scripted gesture. If pan re-rendered the frame
 *   tree, the observer would see attribute/child mutations INSIDE the layer.
 *   The only DOM write a correct implementation makes is `style` on the
 *   transform layer itself (`useCanvas.ts`'s rAF-batched
 *   `applyTransformToDOM`), which is counted separately and expected to be
 *   non-zero — proving the gesture really did move the canvas rather than
 *   silently no-op.
 */

const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'

/**
 * Budgets, every one of them derived from a real run of this spec against
 * the real corpus (numbers in `perf-01`'s `STATE.md` entry), set at roughly
 * 2x the observed value: loose enough not to flake on machine noise, tight
 * enough that a re-render storm or virtualization breaking outright fails.
 */

/** Observed 18.2 / 18.6 / 18.9 / 19.8 ms across four runs — i.e. a solid 60fps. */
const BUDGET_PAN_WORST_FRAME_MS = 40
/** Observed 0 in every run. A handful would be unrelated chrome; a re-render storm is hundreds. */
const BUDGET_PAN_LAYER_MUTATIONS = 10

/**
 * **This one records a known defect, and is a ratchet rather than a target.**
 *
 * A zoom-out that crosses virtualization boundaries mounts live iframes, and
 * a single board-frame mount on this corpus costs ~100-140 ms of synchronous
 * work (iframe + `srcDoc` + injector chain + node tree). Measured worst frame
 * for a 6 → 15 mount sweep: **290 ms**. Two fixes were tried and neither
 * helped — see the `perf-01` `STATE.md` entry for both, and for why the real
 * fix is making an individual mount cheaper, not rescheduling the batch.
 *
 * So this number is deliberately NOT 40 ms. It is set where it is so the
 * defect cannot silently get worse while the honest fix is outstanding.
 */
const BUDGET_ZOOM_WORST_FRAME_MS = 600

interface StudioProjectSummary {
  dir: string
  name: string
}

/** Same lookup pattern as `board-frame-bulk-selection.e2e.ts`'s `findProjectDir`. */
async function findProjectDir(page: Page, folderName: string): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === folderName)
  return match?.dir ?? null
}

async function openEsimBoard(page: Page, projectDir: string): Promise<Locator> {
  await page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
  }, projectDir)
  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached()
  // Wait for the canvas's own "center on open" pass to settle before
  // driving pan/zoom ourselves (same reasoning as frame-fit-height.e2e.ts).
  await expect(page.locator('iframe[title^="Canvas frame"]').first()).toBeVisible({
    timeout: 30_000,
  })
  return canvasRoot
}

type FrameState = 'live' | 'poster' | 'placeholder' | 'empty'

/**
 * Per-frame render state, keyed by page id. `poster` vs `placeholder` is the
 * whole WS-5.3 poster question: an offscreen frame the user has ALREADY
 * looked at must come back as a frozen picture, not an empty box.
 */
async function readFrameStates(page: Page): Promise<Record<string, FrameState>> {
  return page.evaluate(() => {
    const states: Record<string, FrameState> = {}
    for (const frame of document.querySelectorAll('[data-page-id]')) {
      const id = frame.getAttribute('data-page-id')
      if (!id) continue
      if (frame.querySelector('iframe[title^="Canvas frame"]')) states[id] = 'live'
      else if (frame.querySelector('[data-testid="board-frame-poster"]')) states[id] = 'poster'
      else if (frame.querySelector('[data-testid="board-frame-placeholder"]')) states[id] = 'placeholder'
      else states[id] = 'empty'
    }
    return states
  })
}

/** Live (mounted) canvas iframes, board frames on the board, and rendered posters. */
async function readBoardCounts(page: Page): Promise<{
  liveIframes: number
  boardFrames: number
  posters: number
  placeholders: number
  domNodes: number
}> {
  return page.evaluate(() => ({
    liveIframes: document.querySelectorAll('iframe[title^="Canvas frame"]').length,
    boardFrames: document.querySelectorAll('[data-testid="board-frame-body"]').length,
    posters: document.querySelectorAll('[data-testid="board-frame-poster"]').length,
    placeholders: document.querySelectorAll('[data-testid="board-frame-placeholder"]').length,
    domNodes: document.getElementsByTagName('*').length,
  }))
}

interface GestureProfile {
  frames: number
  worstFrameMs: number
  meanFrameMs: number
  framesOver20ms: number
  /** Mutations observed INSIDE the frames layer — the React re-render signal. */
  layerMutations: number
  /** `style` writes on the transform layer — the intended rAF transform commits. */
  transformWrites: number
}

/**
 * Samples `requestAnimationFrame` intervals and DOM mutations while
 * `gesture` runs. Both observers are installed in the page, the gesture is
 * driven from the test side with real `page.mouse` input, then the sample is
 * read back and torn down.
 */
async function profileGesture(page: Page, gesture: () => Promise<void>): Promise<GestureProfile> {
  await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="board-frames-layer"]')
    const transformLayer = document.querySelector('[data-testid="canvas-transform-layer"]')
    const state = {
      intervals: [] as number[],
      layerMutations: 0,
      transformWrites: 0,
      rafHandle: 0,
      last: performance.now(),
      layerObserver: null as MutationObserver | null,
      transformObserver: null as MutationObserver | null,
    }
    window.__studioPerfSample = state

    const tick = () => {
      const now = performance.now()
      state.intervals.push(now - state.last)
      state.last = now
      state.rafHandle = requestAnimationFrame(tick)
    }
    state.rafHandle = requestAnimationFrame(tick)

    if (layer) {
      state.layerObserver = new MutationObserver((records) => {
        state.layerMutations += records.length
      })
      state.layerObserver.observe(layer, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: false,
      })
    }
    if (transformLayer) {
      state.transformObserver = new MutationObserver((records) => {
        state.transformWrites += records.length
      })
      // Attributes on the transform layer ITSELF only (no subtree) — this is
      // the `style.transform` write `useCanvas.ts` makes once per rAF.
      state.transformObserver.observe(transformLayer, {
        subtree: false,
        childList: false,
        attributes: true,
        attributeFilter: ['style'],
      })
    }
  })

  await gesture()

  return page.evaluate(() => {
    const state = window.__studioPerfSample
    if (!state) throw new Error('perf sample was never installed')
    cancelAnimationFrame(state.rafHandle)
    state.layerObserver?.disconnect()
    state.transformObserver?.disconnect()
    delete window.__studioPerfSample

    // Drop the first interval: it spans the gap between installing the
    // sampler and the gesture's first input, which is idle time, not a
    // rendered frame.
    const intervals = state.intervals.slice(1)
    const total = intervals.reduce((sum, n) => sum + n, 0)
    return {
      frames: intervals.length,
      worstFrameMs: intervals.length > 0 ? Math.max(...intervals) : 0,
      meanFrameMs: intervals.length > 0 ? total / intervals.length : 0,
      framesOver20ms: intervals.filter((n) => n > 20).length,
      layerMutations: state.layerMutations,
      transformWrites: state.transformWrites,
    }
  })
}

/** Ctrl+wheel zoom-out until a board frame renders narrower than `maxWidthPx`. */
async function zoomOutUntilNarrow(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  maxWidthPx: number,
): Promise<void> {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const box = await target.boundingBox()
    if (box && box.width <= maxWidthPx) return
    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('zoomOutUntilNarrow: the canvas root has no bounding box')
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 220)
    await page.keyboard.up('Control')
    await page.waitForTimeout(90)
  }
}

/**
 * Records a measurement on the test AND prints it. The annotation is what a
 * CI report keeps; the printed line is what makes a local run useful — these
 * numbers are the whole point of this spec, and a passing assertion alone
 * does not tell you whether the board got faster or slower.
 */
function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[perf-01] ${label}: ${value}`)
}

test.describe('perf-01: studio board pan/zoom and iframe virtualization', () => {
  test('virtualization bounds live iframes, and pan/zoom neither drops frames nor re-renders the frame tree', async ({
    page,
  }) => {
    const projectDir = await findProjectDir(page, PROJECT_FOLDER_NAME)
    if (!projectDir) {
      test.skip(true, `studio-workspace/${PROJECT_FOLDER_NAME} is not present on disk for this run`)
      return
    }

    const canvasRoot = await openEsimBoard(page, projectDir)
    // Posters capture on a settle timer (`useFramePosterCapture.ts`), and the
    // board's initial mount churn has to finish before "at rest" means
    // anything. One settle window covers both.
    await page.waitForTimeout(2500)

    // ── WS-5.3 — virtualization at a working (zoomed-in) view ──────────────
    const atWorkingZoom = await readBoardCounts(page)
    annotate('board frames', String(atWorkingZoom.boardFrames))
    annotate('live iframes @ working zoom', String(atWorkingZoom.liveIframes))
    annotate('posters rendered', String(atWorkingZoom.posters))
    annotate('plain placeholders', String(atWorkingZoom.placeholders))
    annotate('DOM nodes', String(atWorkingZoom.domNodes))

    expect(atWorkingZoom.boardFrames).toBeGreaterThan(1)
    // The load-bearing assertion: an offscreen frame must NOT hold a live
    // iframe. Pre-WS-5.3 this number equalled `boardFrames`.
    expect(atWorkingZoom.liveIframes).toBeLessThan(atWorkingZoom.boardFrames)
    // Every frame is either live or showing a placeholder/poster — no frame
    // may be silently blank.
    expect(atWorkingZoom.liveIframes + atWorkingZoom.posters + atWorkingZoom.placeholders).toBe(
      atWorkingZoom.boardFrames,
    )

    // ── WS-5.4 — scripted 1 s pan ──────────────────────────────────────────
    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('canvas root has no bounding box')
    const centre = { x: rootBox.x + rootBox.width / 2, y: rootBox.y + rootBox.height / 2 }
    await page.mouse.move(centre.x, centre.y)

    const pan = await profileGesture(page, async () => {
      for (let i = 0; i < 20; i += 1) {
        await page.mouse.wheel(30, 20)
        await page.waitForTimeout(50)
      }
    })
    annotate('pan worst frame', `${pan.worstFrameMs.toFixed(1)}ms`)
    annotate('pan mean frame', `${pan.meanFrameMs.toFixed(1)}ms`)
    annotate('pan frames >20ms', `${pan.framesOver20ms}/${pan.frames}`)
    annotate('pan frames-layer mutations', String(pan.layerMutations))
    annotate('pan transform-layer style writes', String(pan.transformWrites))

    // The gesture must actually have moved the canvas — otherwise every
    // other number here is measuring an idle page.
    expect(pan.transformWrites).toBeGreaterThan(0)
    expect(pan.frames).toBeGreaterThan(10)
    expect(pan.worstFrameMs).toBeLessThan(BUDGET_PAN_WORST_FRAME_MS)
    // The WS-5.4 claim itself: panning does not re-render the frame tree.
    expect(pan.layerMutations).toBeLessThan(BUDGET_PAN_LAYER_MUTATIONS)

    // ── WS-5.4 — scripted zoom ─────────────────────────────────────────────
    // Deliberately MONOTONIC zoom-out, not an in/out wobble: zooming out
    // pulls more frames inside the viewport margin, so this gesture is
    // guaranteed to cross virtualization boundaries and mount live iframes
    // WHILE the gesture is still running. That is the expensive case — an
    // in/out wobble can net zero mounts and measure nothing (observed:
    // `6 -> 6`, a run that proved only that an idle gesture is cheap).
    //
    // The 150ms step is deliberately SLOWER than `useCanvas.ts`'s 100ms
    // store-commit debounce, which forces a commit (and therefore a
    // virtualization pass) between wheel ticks rather than leaving it to
    // scheduling luck. A trackpad with inertia does exactly this.
    const liveBeforeZoom = (await readBoardCounts(page)).liveIframes
    const zoom = await profileGesture(page, async () => {
      await page.keyboard.down('Control')
      for (let i = 0; i < 12; i += 1) {
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(150)
      }
      await page.keyboard.up('Control')
    })
    // Frames are admitted a few per animation frame (`useStaggeredFrameMounts`),
    // so the live set finishes filling shortly after the gesture stops.
    await page.waitForTimeout(800)
    const liveAfterZoom = (await readBoardCounts(page)).liveIframes
    annotate('live iframes across zoom', `${liveBeforeZoom} -> ${liveAfterZoom}`)
    // If this gesture did not actually mount anything, the frame times below
    // are measuring an idle canvas and prove nothing about the mount path.
    expect(liveAfterZoom).toBeGreaterThan(liveBeforeZoom)
    annotate('zoom worst frame', `${zoom.worstFrameMs.toFixed(1)}ms`)
    annotate('zoom mean frame', `${zoom.meanFrameMs.toFixed(1)}ms`)
    annotate('zoom frames >20ms', `${zoom.framesOver20ms}/${zoom.frames}`)
    annotate('zoom frames-layer mutations', String(zoom.layerMutations))

    expect(zoom.transformWrites).toBeGreaterThan(0)
    // Ratchet on a known defect — see BUDGET_ZOOM_WORST_FRAME_MS's docblock.
    expect(zoom.worstFrameMs).toBeLessThan(BUDGET_ZOOM_WORST_FRAME_MS)

    // ── WS-5.3 — the frozen poster ─────────────────────────────────────────
    // A frame the user has already looked at must NOT come back as an empty
    // box once it leaves the viewport. Pan hard until at least one
    // previously-live frame goes offscreen, then look at what it renders.
    const liveBefore = Object.entries(await readFrameStates(page))
      .filter(([, state]) => state === 'live')
      .map(([id]) => id)
    annotate('frames live before poster pan', liveBefore.join(','))

    for (let i = 0; i < 30; i += 1) await page.mouse.wheel(140, 100)
    // Past the debounced store commit (100ms) that flips `isOnScreen`, plus
    // a render.
    await page.waitForTimeout(1500)

    const afterPan = await readFrameStates(page)
    const departed = liveBefore.filter((id) => afterPan[id] !== 'live')
    annotate('previously-live frames now offscreen', String(departed.length))
    annotate(
      'their states',
      departed.map((id) => `${id}=${afterPan[id]}`).join(', ') || '(none departed)',
    )

    if (departed.length > 0) {
      const withPoster = departed.filter((id) => afterPan[id] === 'poster')
      annotate('of those, showing a frozen poster', `${withPoster.length}/${departed.length}`)
      // The WS-5.3 acceptance criterion.
      expect(withPoster.length).toBeGreaterThan(0)
    }

    // ── The "before" state, measured rather than assumed ───────────────────
    // Reset the view (Ctrl+0 → `useCanvas.ts`'s `resetCanvasView`) so the
    // board is back under the viewport — the pan above left it far away —
    // then zoom out until every frame sits inside the viewport + margin and
    // virtualization mounts them ALL. That state IS the pre-WS-5.3 board
    // ("all frames mount as soon as the page document is in the store"), so
    // measuring the same scripted pan there is a real A/B rather than an
    // assumption about what the old code would have cost.
    await page.keyboard.press('Control+0')
    await page.waitForTimeout(600)
    const firstFrame = page.locator('[data-testid="board-frame-body"]').first()
    await zoomOutUntilNarrow(page, canvasRoot, firstFrame, 110)
    await page.waitForTimeout(2000)

    const zoomedOut = await readBoardCounts(page)
    annotate('live iframes @ full-board zoom', String(zoomedOut.liveIframes))
    annotate('DOM nodes @ full-board zoom', String(zoomedOut.domNodes))

    await page.mouse.move(centre.x, centre.y)
    const panAllMounted = await profileGesture(page, async () => {
      for (let i = 0; i < 20; i += 1) {
        await page.mouse.wheel(30, 20)
        await page.waitForTimeout(50)
      }
    })
    annotate(
      `pan worst frame @ ${zoomedOut.liveIframes} live iframes`,
      `${panAllMounted.worstFrameMs.toFixed(1)}ms`,
    )
    annotate(
      `pan mean frame @ ${zoomedOut.liveIframes} live iframes`,
      `${panAllMounted.meanFrameMs.toFixed(1)}ms`,
    )
    annotate(
      `pan frames >20ms @ ${zoomedOut.liveIframes} live iframes`,
      `${panAllMounted.framesOver20ms}/${panAllMounted.frames}`,
    )
    annotate('pan frames-layer mutations @ all mounted', String(panAllMounted.layerMutations))
  })
})

declare global {
  interface Window {
    __studioPerfSample?: {
      intervals: number[]
      layerMutations: number
      transformWrites: number
      rafHandle: number
      last: number
      layerObserver: MutationObserver | null
      transformObserver: MutationObserver | null
    }
  }
}
