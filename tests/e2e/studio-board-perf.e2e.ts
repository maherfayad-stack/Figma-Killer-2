import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  BUDGET_ZOOM_MEAN_FRAME_MS,
  BUDGET_ZOOM_WORST_FRAME_MS,
  profileGesture,
  readBoardCounts,
} from './helpers/canvasPerf'
import { E2E_VITE_MODE } from '../../scripts/lib/e2eStack'

/**
 * Real-browser perf measurement for `perf-01` (WS-5.3 / WS-5.4).
 *
 * **This file owns the canvas budgets.** `bun run bench:studio-board`
 * (`scripts/bench/studioBoard.bench.ts`) does not measure anything of its own
 * any more — it spawns Playwright's Node runner on THIS spec and republishes
 * the `perf` annotations below, so a budget ratcheted here is the only place
 * it needs ratcheting. It used to drive a synthetic 50-frame board in-process
 * under Bun, which could never work: Playwright talks to Chromium over
 * `--remote-debugging-pipe`, and Bun on Windows does not wire the extra stdio
 * fds that transport needs, so `chromium.launch()` hung until its timeout
 * (verified: the identical launch returns in 72 ms under Node, hangs for 180 s
 * under Bun; `connectOverCDP` over a TCP port hangs in Bun's WebSocket client
 * too). The bench caught the hang, reported `skipped`, and passed — a perf
 * gate that structurally could not fail. See `scripts/bench/lib/browser.ts`
 * and the `perf-01` `STATE.md` entry.
 *
 * The Playwright **test runner** spawns Node, not Bun, so this file is where
 * canvas frame time is actually measurable.
 *
 * ## The corpus, and why it changed
 *
 * This spec used to measure `studio-workspace/maherfayad-stack-eSIM`, which is
 * **not tracked by git** — so on every CI run and every machine but the one it
 * was written on, it called `test.skip` and measured nothing (`verify-01`
 * finding 1). It now runs against `studio-workspace/__board-perf-fixture`, a
 * committed twelve-frame board whose own README explains its shape, and it
 * **fails rather than skips** when that board is missing: a perf gate that can
 * silently opt out is not a gate.
 *
 * Twelve frames is the floor, not a preference. `frameMountPool.ts` keeps
 * `max(8, onScreen + 4)` frames mounted, so a board of eight or fewer has every
 * frame mounted at all times and a zoom across a virtualization boundary mounts
 * nothing — which is exactly the trap `studio-feel.e2e.ts` falls into on the
 * three-frame `test4` (see `BUDGET_ZOOM_WORST_FRAME_MS`'s docblock).
 *
 * Read-only against the project: it pans, zooms and counts, and never writes.
 * The run's whole workspace is a throwaway copy in any case
 * (`tests/e2e/helpers/constants.ts`'s `WORKSPACE_ROOT`).
 *
 * The frame-timing instrumentation (`profileGesture`, `readBoardCounts`) AND
 * the zoom budgets live in `helpers/canvasPerf.ts`, so `studio-feel.e2e.ts`
 * measures a zoom the same way this spec does and ratchets against the same
 * number. Read `BUDGET_ZOOM_WORST_FRAME_MS` there before loosening it.
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

const PROJECT_FOLDER_NAME = '__board-perf-fixture'

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
 * `speed-04` (`STUDIO-SPEED-PLAN.md`) — click → selection ring, COLD (the
 * first click after the board opens, before a Tier-2 board frame's bridge
 * iframe has ever reported ready). The plan's own target is `<= 100ms`; this
 * fixture has no `node_modules`, so its Tier-2 dev server never reaches
 * `ready` inside a test run — that's a feature, not a gap: it deterministically
 * exercises the exact "just opened" window the whole board sits in for the
 * first several seconds of a REAL Tier-2 project too, where the fallback
 * (portal, `srcdoc`) frame is the only interactive surface. See
 * `BreakpointFrame.tsx`'s `overlayEnabled` doc for the mechanism this budget
 * guards: before it existed, the hidden bridge frame's OWN overlay
 * (`useBridgeSelectionChrome`) mounted unconditionally and rendered a second,
 * competing toolbar/inspector for the very same click.
 *
 * Calibrated (not the plan's 100ms) on THIS machine, under real contention
 * from other agents (`uptime` load average ~50 at calibration time — an
 * order of magnitude over core count): six runs, three per side, `git stash`
 * A/B on `LiveBoardFrame.tsx`/`BreakpointFrame.tsx`/
 * `BreakpointSelectionOverlay.tsx` alone (this spec unchanged both times):
 *
 *   before (dual overlay mount): 200.4ms, 165.3ms, 210.4ms — mean 192.0ms
 *   after  (this change):        141.3ms, 197.4ms, 184.7ms — mean 174.5ms
 *
 * A real, directionally consistent improvement, but the spread (141–210ms
 * across BOTH sides) is machine noise, not signal — this budget is set at
 * roughly 2x the observed "after" mean (the same convention
 * `BUDGET_PAN_WORST_FRAME_MS` above uses), not the plan's tighter number.
 * Re-calibrate on a quiet runner (CI) and tighten toward 100ms once a clean
 * number is available there — do not loosen it further to chase noise here.
 */
const BUDGET_CLICK_TO_RING_COLD_MS = E2E_VITE_MODE === 'preview' ? 150 : 350

/**
 * How long the board is left alone so `framePosterQueue` can drain all twelve
 * frames before the poster pan. Not a budget and not a guess — see the comment
 * at its one use for the arithmetic it comes from.
 */
const POSTER_QUEUE_DRAIN_MS = 4_000


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

async function openPerfBoard(page: Page, projectDir: string): Promise<Locator> {
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

test.describe('speed-04: click -> selection ring, cold', () => {
  test('the FIRST click after the board opens rings within budget — no duplicate bridge overlay competing for it', { tag: '@production-bundle' }, async ({
    page,
  }) => {
    page.on('console', (msg) => {
      if (msg.text().startsWith('SPEED04')) console.log('[browser]', msg.text())
    })
    const projectDir = await findProjectDir(page, PROJECT_FOLDER_NAME)
    expect(
      projectDir,
      `studio-workspace/${PROJECT_FOLDER_NAME} was not listed by /admin/api/studio/projects.`,
    ).not.toBeNull()

    const canvasRoot = await openPerfBoard(page, projectDir!)

    // Cold: a board frame that is ACTUALLY on screen, clicked the moment
    // it's interactive — no settle wait, no prior selection. This project
    // has no `node_modules`, so its Tier-2 bridge iframe never reports
    // `ready` inside a test run: the Tier-0 fallback (portal, `srcdoc`) is
    // the ONLY interactive surface, exactly the state a real Tier-2 board is
    // in for its first several seconds too — before this change, that
    // fallback's real overlay competed with the hidden bridge frame's OWN
    // overlay (`useBridgeSelectionChrome`) mounting unconditionally and
    // opening a real `postMessage` round trip into a still-loading document
    // for the very same selection.
    //
    // `.first()` in DOM order is NOT "on screen" — `Locator.toBeVisible()`
    // only checks CSS visibility, not whether the element's transformed
    // board position falls inside the current viewport, so DOM-order-first
    // can silently resolve to a frame parked off-canvas. Pick whichever
    // `srcdoc` iframe's bounding box actually contains the canvas root's own
    // center point instead — the same point `openPerfBoard`'s "center on
    // open" pass targets.
    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('canvas root has no bounding box')
    const centre = { x: rootBox.x + rootBox.width / 2, y: rootBox.y + rootBox.height / 2 }
    const fallbackIframes = page.locator('iframe[srcdoc][title^="Canvas frame"]')
    const fallbackIframeEl = await (async () => {
      const count = await fallbackIframes.count()
      for (let i = 0; i < count; i += 1) {
        const candidate = fallbackIframes.nth(i)
        const box = await candidate.boundingBox()
        if (
          box &&
          centre.x >= box.x &&
          centre.x <= box.x + box.width &&
          centre.y >= box.y &&
          centre.y <= box.y + box.height
        ) {
          return candidate
        }
      }
      throw new Error('no fallback iframe sits under the canvas root center')
    })()

    // `FrameLocator.evaluate` doesn't exist — a whole-document script needs
    // the real `Frame`, reached through the element handle's `contentFrame()`.
    const iframeHandle = await fallbackIframeEl.elementHandle()
    const frame = await iframeHandle?.contentFrame()
    if (!frame) throw new Error('the fallback iframe never attached a content frame')

    // A LEAF node, not the frame's own root/body — clicking the root is
    // "activate this frame", not "select this node" (`handleEmptyFrameClick`).
    // Every one of this fixture's twelve screens shares the same panel
    // heading text ("<Title> summary"), so match by the stable class instead
    // of a screen-specific string.
    const clickable = frame.locator('.panel__heading').first()
    await expect(clickable).toBeVisible({ timeout: 15_000 })

    // Timer lives INSIDE the iframe's own document — same clock as the click
    // and the ring write (WS-5.1: the ring renders inside this document, not
    // the parent), so the number has no cross-process IPC noise in it. Same
    // pattern as `studio-feel.e2e.ts`'s `startRefusalTiming`/`readRefusalTiming`.
    await frame.evaluate(() => {
      const state = { downAt: 0, ringAt: 0, observer: null as MutationObserver | null }
      // @ts-expect-error -- test-only channel, see readback below.
      window.__speed04ClickToRing = state
      const onPointerDown = () => {
        if (state.downAt !== 0) return
        state.downAt = performance.now()
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      state.observer = new MutationObserver(() => {
        if (state.ringAt !== 0) return
        if (document.querySelector('[data-canvas-selection-ring]')) state.ringAt = performance.now()
      })
      state.observer.observe(document.body, { subtree: true, childList: true })
    })

    await clickable.click()

    const ms = await frame.evaluate(() => {
      // @ts-expect-error -- see the installer above.
      const state = window.__speed04ClickToRing as {
        downAt: number
        ringAt: number
        observer: MutationObserver | null
      }
      state.observer?.disconnect()
      // @ts-expect-error -- see the installer above.
      delete window.__speed04ClickToRing
      if (state.downAt === 0) throw new Error('no pointerdown was observed inside the fallback frame')
      if (state.ringAt === 0) throw new Error('no selection ring ever appeared inside the fallback frame')
      return state.ringAt - state.downAt
    })

    annotate('speed-04 click -> ring (cold)', `${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(BUDGET_CLICK_TO_RING_COLD_MS)
  })
})

test.describe('perf-01: studio board pan/zoom and iframe virtualization', () => {
  test('virtualization bounds live iframes, and pan/zoom neither drops frames nor re-renders the frame tree', async ({
    page,
  }) => {
    const projectDir = await findProjectDir(page, PROJECT_FOLDER_NAME)
    // Deliberately NOT `test.skip`. The corpus is committed to this repository
    // now, so "it is not on disk" means the fixture was deleted or the server
    // is reading a different workspace root — both of which must fail loudly.
    // The previous skip is why this file measured nothing for seven weeks.
    expect(
      projectDir,
      `studio-workspace/${PROJECT_FOLDER_NAME} was not listed by /admin/api/studio/projects. ` +
        'That fixture is tracked by git and is the whole corpus of this gate — restore it, or ' +
        'check that the e2e stack is pointed at a workspace root that contains it ' +
        '(STUDIO_WORKSPACE_DIR, set by scripts/e2e-dev.ts).',
    ).not.toBeNull()

    const canvasRoot = await openPerfBoard(page, projectDir!)
    // Posters capture on a settle timer (`useFramePosterCapture.ts`), and the
    // board's initial mount churn has to finish before "at rest" means
    // anything. One settle window covers both.
    await page.waitForTimeout(2500)

    // ── WS-5.3 — virtualization at a working (zoomed-in) view ──────────────
    const atWorkingZoom = await readBoardCounts(page)
    annotate('board frames', String(atWorkingZoom.boardFrames))
    annotate('live iframes @ working zoom', String(atWorkingZoom.liveIframes))
    annotate('mounted frames @ working zoom', String(atWorkingZoom.mountedFrames))
    annotate('posters rendered', String(atWorkingZoom.posters))
    annotate('plain placeholders', String(atWorkingZoom.placeholders))
    annotate('DOM nodes', String(atWorkingZoom.domNodes))

    expect(atWorkingZoom.boardFrames).toBeGreaterThan(1)
    // The load-bearing assertion: an offscreen frame must NOT hold a live
    // iframe. Pre-WS-5.3 this number equalled `boardFrames`. Counted per
    // FRAME (`readBoardCounts`' doc): a Tier-2 frame mounts a hidden bridge
    // iframe beside its fallback, so raw iframes over-count mounted frames.
    expect(atWorkingZoom.mountedFrames).toBeLessThan(atWorkingZoom.boardFrames)
    // Every frame is either mounted or showing a placeholder/poster — no frame
    // may be silently blank.
    expect(atWorkingZoom.mountedFrames + atWorkingZoom.posters + atWorkingZoom.placeholders).toBe(
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
    const liveBeforeZoom = (await readBoardCounts(page)).mountedFrames
    const zoom = await profileGesture(page, async () => {
      await page.keyboard.down('Control')
      for (let i = 0; i < 12; i += 1) {
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(150)
      }
      await page.keyboard.up('Control')
    })
    // A frame's node tree lands one commit after its injectors (S1's staged
    // mount, `IframeFrameSurface`), so the live set finishes filling shortly
    // after the gesture stops. (This used to credit a `useStaggeredFrameMounts`
    // that `perf-01` reverted and never existed in the tree afterwards.)
    await page.waitForTimeout(800)
    const liveAfterZoom = (await readBoardCounts(page)).mountedFrames
    annotate('mounted frames across zoom', `${liveBeforeZoom} -> ${liveAfterZoom}`)
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
    // The frames that are NOT paying for a mount. Asserted here as well as in
    // `studio-feel.e2e.ts` on purpose: this is the board where the gesture
    // really does mount frames, so the mean is the honest "everything else
    // stayed smooth while it did" number.
    expect(zoom.meanFrameMs).toBeLessThan(BUDGET_ZOOM_MEAN_FRAME_MS)

    // ── WS-5.3 — the frozen poster ─────────────────────────────────────────
    // A frame the user has already looked at must NOT come back as an empty
    // box once it leaves the viewport.
    //
    // Since P2-I (PERF-5) a poster is rasterized only while a frame sits in
    // the pool OFF screen (`framePosterNeeded`) — never while the user is
    // looking at it — and `framePosterQueue` holds every capture until the
    // board has been quiet for 700 ms, then runs them serially. So the
    // gesture that earns a poster is the one a user makes: move away a little
    // (frames leave the screen but stay mounted), pause, then move far away
    // (they are evicted). A single fast pan evicts a frame before any quiet
    // period, and it shows the plain title placeholder — by design. This used
    // to be one burst pan, which could only ever read 0 posters after P2-I.
    const readMountReasons = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('[data-page-id][data-frame-mount]')].map((el) => [
            el.getAttribute('data-page-id') ?? '',
            el.getAttribute('data-frame-mount') ?? '',
          ]),
        ),
      )
    let pooledOffscreen: string[] = []
    for (let i = 0; i < 60 && pooledOffscreen.length < 2; i += 1) {
      await page.mouse.wheel(60, 40)
      await page.waitForTimeout(150)
      pooledOffscreen = Object.entries(await readMountReasons())
        .filter(([, reason]) => reason === 'pooled')
        .map(([id]) => id)
    }
    annotate('frames pooled off screen before the pause', pooledOffscreen.join(',') || '(none)')
    expect(
      pooledOffscreen.length,
      'a short pan never left a frame mounted off screen, so no frame could be rasterized into a poster',
    ).toBeGreaterThan(0)

    // The pause. `framePosterQueue` waits `QUIET_PERIOD_MS` (700 ms) after the
    // last input, then drains serially, one `html-to-image` rasterization per
    // macrotask (~85 ms on this corpus) plus a 32 ms gap.
    await page.waitForTimeout(POSTER_QUEUE_DRAIN_MS)

    // Now far away: the pool evicts least-recently-on-screen first, which is
    // exactly the frames that were pooled during the pause.
    for (let i = 0; i < 30; i += 1) await page.mouse.wheel(140, 100)
    // Past the debounced store commit (100ms) that flips `isOnScreen`, plus
    // a render.
    await page.waitForTimeout(1500)

    const afterPan = await readFrameStates(page)
    const departed = pooledOffscreen.filter((id) => afterPan[id] !== 'live')
    annotate('of those, evicted by the far pan', String(departed.length))
    annotate('their states', departed.map((id) => `${id}=${afterPan[id]}`).join(', ') || '(none departed)')
    // Unconditional, not `if (departed.length > 0)`: a run where nothing was
    // evicted means the pan stopped working, and a guard would turn exactly
    // that into a silent pass.
    expect(
      departed.length,
      'the far pan evicted none of the frames pooled during the pause, so the poster criterion was never exercised',
    ).toBeGreaterThan(0)
    const withPoster = departed.filter((id) => afterPan[id] === 'poster')
    annotate('of those, showing a frozen poster', `${withPoster.length}/${departed.length}`)
    // The WS-5.3 acceptance criterion: every frame that was looked at and then
    // rested off screen comes back as a picture.
    expect(withPoster.length).toBe(departed.length)

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
