import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for the "frame fit height" line of work
 * (`canvas-02` → `test-01` → `canvas-04`):
 * `src/admin/pages/site/canvas/resolveFrameFitHeight.ts`'s
 * `collectScrollDeficits` used to only count a deficit when computed
 * `overflow-y` was `auto`/`scroll`, while `CanvasScrollUnrollInjector`
 * force-sets `overflow-y: visible !important` on every element in design
 * mode — so the detector was permanently blind to exactly the regions it
 * needed to see. `canvas-02` "fixed" this by broadening the gate to
 * "everything except `hidden`/`clip` counts"; `test-01`'s real-browser pass
 * showed that made things strictly worse (a blank frame), so it was
 * reverted. `canvas-04` fixed it properly: `CanvasScrollUnrollInjector` now
 * records each element's PRE-unroll `overflow-y`
 * (`SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR`, `canvasScrollUnroll.ts`) before
 * its own blanket rule overwrites it, and `collectScrollDeficits` reads that
 * back — keeping the narrow `auto`/`scroll` gate while seeing past the
 * injector's own override. `test-01` also found a SECOND, independent
 * defect: `BoardFramesLayer`'s `.frameBody` device box was always a FIXED
 * size that nothing fed the fitted content height back into, so however
 * correctly the iframe grew internally, the VISIBLE board frame stayed
 * clipped. `canvas-04` fixed that too: a frame that has never been manually
 * resized now grows `.frameBody` to wrap its content instead
 * (`data-frame-auto-height`, `BoardFramesLayer.module.css`).
 *
 * Every existing unit test for the `collectScrollDeficits` fix stubs
 * `scrollHeight`/`clientHeight` via `Object.defineProperty`, because
 * happy-dom has no layout engine and cannot confirm the fix's central,
 * load-bearing assumption: that a REAL browser reports `scrollHeight >
 * clientHeight` for an `overflow: visible` box with an explicit height whose
 * content is taller. Test 1 below settles that in isolation — no app, no
 * login, a ~15-line page. Test 2 verifies the end-to-end regression this was
 * written for: `studio-workspace/esim-journey`, page
 * `esim-manual-entry-screen`, a bottom-sheet whose Confirm button used to be
 * clipped by the frame's own visible bounds. See `STATE.md`'s `canvas-02`,
 * `test-01`, and `canvas-04` entries for the full history.
 */

test.describe('collectScrollDeficits: the overflow:visible assumption is real in a browser', () => {
  test("an explicit-height, overflow:visible box reports scrollHeight > clientHeight when its content is taller (the fix's core assumption)", async ({
    page,
  }) => {
    await page.setContent(`
      <div id="outer" style="position:relative;width:200px;height:100px;overflow:visible;margin:0;padding:0;border:0;">
        <div id="inner" style="height:300px;margin:0;padding:0;border:0;"></div>
      </div>
    `)

    const outer = page.locator('#outer')
    const metrics = await outer.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }))

    // Sanity: the box must actually compute to `visible`, or this proves
    // nothing about the gate `collectScrollDeficits` widened.
    expect(metrics.overflowY).toBe('visible')

    expect(
      metrics.scrollHeight,
      [
        "collectScrollDeficits's fix (resolveFrameFitHeight.ts) rests entirely",
        'on this: an explicit-height (100px), overflow:visible box with a',
        '300px-tall child still reports scrollHeight > clientHeight in a real',
        `layout engine. Got scrollHeight=${metrics.scrollHeight}px,`,
        `clientHeight=${metrics.clientHeight}px. If this fails, the fix does`,
        'nothing in a real browser and the underlying bug is still live — do',
        'not weaken this assertion to pass, report the failure.',
      ].join(' '),
    ).toBeGreaterThan(metrics.clientHeight)

    // No padding/border on either box, so the deficit is exactly the
    // overflowing amount: 300 - 100 = 200px.
    expect(metrics.scrollHeight - metrics.clientHeight).toBe(200)
  })
})

const MANUAL_ENTRY_PAGE_ID = 'esim-manual-entry-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

interface StudioProjectSummary {
  dir: string
  name: string
}

/**
 * Finds the on-disk `esim-journey` project via the same endpoint the
 * Overview launcher uses (`GET /admin/api/studio/projects`), so the test
 * points Studio at the exact directory `DashboardPage.openProject` would —
 * `dir` is an absolute path (`server/handlers/studioProjects.ts`'s
 * `listStudioProjects`), matched by its trailing folder name so this works
 * regardless of `/` vs `\` path separators on Windows.
 */
async function findEsimJourneyProjectDir(page: Page): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === 'esim-journey')
  return match?.dir ?? null
}

/**
 * Pans the studio board (native wheel = pan, `useCanvas.ts`'s `handleWheel`)
 * until `target`'s screen-space center sits within `tolerancePx` of the
 * canvas viewport's own center.
 *
 * Every board frame's outer `.frame` div stays mounted at its true screen
 * position at all times — `BoardFramesLayer`'s virtualization only swaps the
 * iframe BODY for a placeholder when offscreen, never the positioned wrapper
 * (see that file's module doc) — so `target.boundingBox()` is trustworthy
 * even before the frame's iframe has mounted.
 *
 * The wheel handler maps `deltaX`/`deltaY` onto screen-space pan 1:1
 * (`canvasPanInput.ts`'s `panDeltaFromWheel` just negates the sign; the pan
 * offset is added to screen coordinates AFTER the zoom scale is applied —
 * see `math.ts`'s `canvasToScreen`), so the exact on-screen distance to the
 * target's center is also the exact wheel delta that closes it.
 */
async function panIntoView(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  tolerancePx = 40,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) {
      throw new Error(
        `panIntoView: target frame [data-page-id="${MANUAL_ENTRY_PAGE_ID}"] has no bounding box`,
      )
    }

    const rootCenterX = rootBox.x + rootBox.width / 2
    const rootCenterY = rootBox.y + rootBox.height / 2
    const targetCenterX = targetBox.x + targetBox.width / 2
    const targetCenterY = targetBox.y + targetBox.height / 2
    const dx = targetCenterX - rootCenterX
    const dy = targetCenterY - rootCenterY

    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    // Let the transform CSS var + virtualization re-check settle before the
    // next measurement — a bounding-box read immediately after the wheel
    // event can still see the pre-pan layout.
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target frame never reached the viewport center after 8 pan attempts')
}

/**
 * Waits for `useIframeFrameAutoHeight`'s rAF settle loop
 * (`useIframeFrameAutoHeight.ts`) to stop growing the iframe's own
 * `clientHeight`, so a measurement taken right after isn't mid-pass.
 */
async function waitForStableClientHeight(locator: Locator): Promise<number> {
  let lastHeight = -1
  let stableReads = 0
  await expect
    .poll(
      async () => {
        const height = await locator.evaluate((el) => el.clientHeight)
        if (height === lastHeight && height > 0) {
          stableReads += 1
        } else {
          stableReads = 0
          lastHeight = height
        }
        return stableReads
      },
      {
        timeout: 15_000,
        intervals: [200],
        message:
          "the design frame's height (useIframeFrameAutoHeight's rAF settle " +
          'loop) never stabilized — the frame-fit-height pass may be stuck ' +
          'growing (MAX_FRAME_FIT_PASSES) or never settling',
      },
    )
    .toBeGreaterThanOrEqual(3)
  return lastHeight
}

/**
 * `BoardFramesLayer`'s `.frameBody` (`data-testid="board-frame-body"`) — the
 * board frame's own visible "device box". This is a SEPARATE mechanism from
 * `resolveFrameFitHeight`/`useIframeFrameAutoHeight`, which only grow the
 * `<iframe>` element's OWN CSS height — so the iframe element's own
 * `boundingBox()`/`clientHeight` is NOT what visually bounds a board frame;
 * `.frameBody` is.
 *
 * `canvas-04` gave `.frameBody` two behaviours, chosen by whether the frame
 * has ever been manually resized (`board.frames[].height` set —
 * `BoardFramesLayer.tsx`'s `hasManualHeight`, reflected here as
 * `data-frame-auto-height`):
 *   - never resized (the default `esim-manual-entry-screen` sits in): grows
 *     to wrap its content (`height: auto`) instead of clipping it — there is
 *     no scroll boundary to find here BY DESIGN, so a caller must not expect
 *     one.
 *   - manually resized: the ORIGINAL fixed-size, `overflow: auto` device box
 *     — content taller than the configured size scrolls inside, deliberately
 *     (`BoardFramesLayer.module.css`'s base `.frameBody` rule).
 *
 * Found via the stable `data-testid`, not the CSS module's hashed class name
 * and not a walk-for-`overflow-y` (which used to be the only way to locate
 * it, before `canvas-04` added the testid — that walk is exactly what broke
 * for the auto-height case, since there is no longer an `overflow:auto`
 * ancestor to find there).
 */
async function findFrameBody(targetFrame: Locator): Promise<Locator> {
  return targetFrame.getByTestId('board-frame-body')
}

test.describe('canvas-02 regression: esim-manual-entry-screen is not clipped (real browser)', () => {
  test('the manual-entry bottom sheet renders whole, with no internal scrollbar', async ({ page }) => {
    const projectDir = await findEsimJourneyProjectDir(page)
    if (!projectDir) {
      test.skip(true, 'studio-workspace/esim-journey is not present on disk for this run')
      return
    }

    // `isStudioMode()`/`getStudioWorkspaceDir()` (studioMode.ts,
    // studioWorkspaceDir.ts) both read localStorage at mount time, so it has
    // to be present before the app's first script runs — addInitScript, not
    // a post-navigation page.evaluate.
    await page.addInitScript((dir: string) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
    }, projectDir)

    await page.goto('/admin/site?studio')
    await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
    // `board-frames-layer` is a zero-size positioning container (every child
    // is `position: absolute`), so `toBeVisible()` (which requires a
    // non-empty bounding box) never passes for it — `toBeAttached()` is the
    // correct check here.
    await expect(page.getByTestId('board-frames-layer')).toBeAttached()

    const targetFrame = page.locator(`[data-page-id="${MANUAL_ENTRY_PAGE_ID}"]`)
    await expect(
      targetFrame,
      `expected exactly one board frame for page id "${MANUAL_ENTRY_PAGE_ID}" — check ` +
        'studio-workspace/esim-journey/.studio/boards.json still curates it onto a board',
    ).toHaveCount(1)

    // Let the canvas's own "center on open" pass (CanvasRoot.tsx's
    // `resolveCanvasFocusTarget` effect) finish before panning ourselves —
    // otherwise our wheel pan and its retry loop (up to ~3.2s) fight over
    // panX/panY. Any live frame appearing is proof that pass has succeeded
    // at least once, which is all it ever does.
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({
      timeout: 20_000,
    })

    const canvasRoot = page.getByTestId('canvas-root')
    await panIntoView(page, canvasRoot, targetFrame)

    const iframeEl = targetFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(
      iframeEl,
      'the esim-manual-entry-screen frame never mounted a live iframe after being panned into view',
    ).toBeVisible({ timeout: 15_000 })

    const contentFrame = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    const panel = contentFrame.locator('.manual-entry-sheet__panel')
    await expect(
      panel,
      "ManualEntryScreen.jsx's .manual-entry-sheet__panel never rendered inside the frame",
    ).toBeVisible({ timeout: 15_000 })

    const confirmButton = contentFrame.getByRole('button', { name: 'Confirm', exact: true })
    await expect(confirmButton, 'the Confirm button (t.common.confirm) never rendered').toBeVisible()

    await waitForStableClientHeight(iframeEl)

    // The board frame's own visible "device box" — NOT the raw `<iframe>`
    // element (see `findFrameBody`'s doc: the iframe's own CSS height is
    // unclamped and answers a different question than what a user actually
    // sees). This IS the boundary a real user's eyes are bound by.
    const frameBody = await findFrameBody(targetFrame)
    await expect(frameBody, "BoardFramesLayer's .frameBody never rendered for this frame").toBeVisible()

    // canvas-04: `esim-manual-entry-screen`'s `boards.json` entry carries no
    // height override (verified: `studio-workspace/esim-journey/.studio/
    // boards.json` has no `height` key for this frame), so `.frameBody`
    // should be in AUTO mode — grows to wrap its content instead of clipping
    // it inside a fixed device box. If a future edit to the corpus manually
    // resizes this specific frame, this assertion is the honest signal that
    // this test's fixed-vs-auto assumption needs revisiting, not something to
    // delete.
    const autoHeightMode = await frameBody.getAttribute('data-frame-auto-height')
    expect(
      autoHeightMode,
      "esim-manual-entry-screen's board frame was expected to be in auto-height " +
        "mode (never manually resized in boards.json) — got " +
        `data-frame-auto-height=${JSON.stringify(autoHeightMode)}. If this frame ` +
        'was deliberately given a manual size, this test needs a manual-size ' +
        'branch (BoardFramesLayer.module.css\'s base `.frameBody` rule: fixed ' +
        'size, scrolls internally by design) instead of this auto-height assertion.',
    ).toBe('true')

    const [buttonBox, panelBox, frameBodyBox] = await Promise.all([
      confirmButton.boundingBox(),
      panel.boundingBox(),
      frameBody.boundingBox(),
    ])
    expect(buttonBox, 'the Confirm button has no bounding box').not.toBeNull()
    expect(panelBox, 'the sheet panel has no bounding box').not.toBeNull()
    expect(frameBodyBox, '.frameBody has no bounding box').not.toBeNull()
    const buttonBottom = buttonBox!.y + buttonBox!.height
    const frameBodyBottom = frameBodyBox!.y + frameBodyBox!.height

    // THE REGRESSION THIS CATCHES — a real, previously-open defect: before
    // `canvas-04`, `.frameBody` was ALWAYS a fixed-size box (`--frame-h`,
    // `FRAME_HEIGHT`=800px by default) that nothing fed the fitted content
    // height back into — so however correctly `resolveFrameFitHeight` grew
    // the iframe's OWN height internally, the VISIBLE board frame stayed
    // clipped at 800px regardless. `canvas-04` fixed this by letting a never-
    // manually-resized `.frameBody` grow to wrap its (already-correctly-
    // fitted) iframe instead of clipping it — so the Confirm button's bottom
    // edge must now sit within `.frameBody`'s own (grown) bounds.
    expect(
      buttonBottom,
      [
        `the teal Confirm button's bottom edge (screen y=${buttonBottom.toFixed(1)})`,
        `must sit within the frame's own visible device-box bounds (bottom`,
        `y=${frameBodyBottom.toFixed(1)}, BoardFramesLayer's .frameBody).`,
        'Do not weaken this assertion to pass; the fix needs a follow-up.',
      ].join(' '),
    ).toBeLessThanOrEqual(frameBodyBottom + 2)

    // Complementary structural check, same finding: in auto-height mode,
    // `.frameBody` grew to wrap its content — it should not ALSO need an
    // internal scrollbar to reach the sheet (that would mean it raised its
    // floor without actually wrapping the content, a narrower bug than the
    // pre-canvas-04 one but still a dead end: an internal scrollbar here is
    // unreachable by mouse wheel, since the canvas's own wheel handler always
    // calls preventDefault for pan/zoom — useCanvas.ts).
    const frameBodyScrollState = await frameBody.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(
      frameBodyScrollState.scrollHeight,
      '.frameBody is in auto-height mode but still needs an internal scrollbar ' +
        `(scrollHeight=${frameBodyScrollState.scrollHeight}, ` +
        `clientHeight=${frameBodyScrollState.clientHeight}) to reach the sheet — ` +
        'it should have grown to wrap its content, not merely raised its floor.',
    ).toBeLessThanOrEqual(frameBodyScrollState.clientHeight + 2)

    // No INNER (iframe-document) scrollbar — this part of the pipeline is
    // independent of the regression above and does still work:
    // CanvasScrollUnrollInjector should leave no active auto/scroll region
    // under body.
    const activeScrollers = await contentFrame.locator('body *').evaluateAll((elements) =>
      elements
        .filter((el) => {
          const style = getComputedStyle(el)
          return (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 1
          )
        })
        .map((el) => el.tagName + (el.className ? `.${String(el.className).replace(/\s+/g, '.')}` : '')),
    )
    expect(
      activeScrollers,
      'CanvasScrollUnrollInjector should unroll every scroll region to ' +
        'overflow:visible in design mode — an active auto/scroll region ' +
        'listed here would give the frame its own internal scrollbar.',
    ).toEqual([])
  })
})
