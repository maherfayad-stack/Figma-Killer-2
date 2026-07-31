import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for WS-5.1 (`canvas-05`): "the selection ring / props
 * panel lands far from the element" — `STATE.md`'s `standing-03`, the user's
 * #1 dogfooding complaint. Diagnosed as a coordinate-conversion bug, not lag:
 * the OLD design positioned selection chrome in the PARENT document from
 * `elementRect × zoom + iframeOffset + panOffset`, recomputed every RAF tick
 * — any staleness in any term showed up as displacement, MULTIPLIED by zoom.
 * The user's own screenshot was at 58% zoom, which is why this spec targets
 * that value specifically rather than an arbitrary non-1 zoom.
 *
 * The fix (`CanvasSelectionOverlayInjector`, `BreakpointSelectionOverlay.tsx`)
 * renders the ring INSIDE the iframe document — same coordinate space as the
 * element, zero conversion — so this is a real layout-engine question
 * (`standing-02`'s amendment: happy-dom has no layout engine and cannot see
 * this class of bug at all; a passing unit test here would prove nothing).
 *
 * Two things asserted, both at 58% zoom with a deliberate, non-zero pan
 * offset (the frame is NOT centered in the viewport):
 *   1. The selection ring's on-screen rect coincides with the selected
 *      element's on-screen rect, within a couple of pixels.
 *   2. `InPlaceInspector` anchors adjacent to the element (a small, bounded
 *      gap below it), not detached at the viewport edge.
 */

const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'
const TARGET_PAGE_ID = 'esim-manual-entry-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
const TARGET_ZOOM_PCT = 58

interface StudioProjectSummary {
  dir: string
  name: string
}

/** Same lookup pattern as `frame-fit-height.e2e.ts`'s `findEsimJourneyProjectDir`. */
async function findProjectDir(page: Page, folderName: string): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === folderName)
  return match?.dir ?? null
}

/** Same pan mechanism as `frame-fit-height.e2e.ts`'s `panIntoView`. */
async function panIntoView(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  tolerancePx = 40,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) throw new Error('panIntoView: target has no bounding box')

    const rootCenterX = rootBox.x + rootBox.width / 2
    const rootCenterY = rootBox.y + rootBox.height / 2
    const targetCenterX = targetBox.x + targetBox.width / 2
    const targetCenterY = targetBox.y + targetBox.height / 2
    const dx = targetCenterX - rootCenterX
    const dy = targetCenterY - rootCenterY

    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target frame never reached the viewport center after 8 pan attempts')
}

/** Plain (non-ctrl) wheel pan by a fixed screen-px delta — no target, just moves the board. */
async function panBy(page: Page, canvasRoot: Locator, dx: number, dy: number): Promise<void> {
  const rootBox = await canvasRoot.boundingBox()
  if (!rootBox) throw new Error('panBy: the canvas root has no bounding box')
  await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
  await page.mouse.wheel(dx, dy)
  await page.waitForTimeout(200)
}

/** The zoom percentage `ZoomControls` currently displays (its debounced, committed value). */
async function readZoomPercent(page: Page): Promise<number> {
  const text = await page.getByTestId('toolbar-zoom-controls').locator('button', { hasText: '%' }).textContent()
  const match = text?.match(/(\d+)%/)
  if (!match) throw new Error(`readZoomPercent: could not parse a percentage from "${text}"`)
  return Number(match[1])
}

/**
 * Reaches `targetPct` via a REAL ctrl+wheel zoom gesture (`useCanvas.ts`'s
 * `handleWheel`, `math.ts`'s `zoomFromWheelDelta`: `factor = 0.9985 **
 * deltaY`), anchored at the canvas root's center so the frame doesn't drift
 * off-screen mid-zoom. Computes the analytic delta needed from the CURRENT
 * displayed zoom, then verifies against the debounced (~100ms) committed
 * value and nudges again if still outside `tolerancePct` — `ZoomControls`
 * only displays the store's committed `zoom`, never the ref-driven live
 * value, so every read needs the settle wait.
 */
async function zoomToPercent(
  page: Page,
  canvasRoot: Locator,
  targetPct: number,
  tolerancePct = 1,
): Promise<void> {
  const rootBox = await canvasRoot.boundingBox()
  if (!rootBox) throw new Error('zoomToPercent: the canvas root has no bounding box')
  const anchorX = rootBox.x + rootBox.width / 2
  const anchorY = rootBox.y + rootBox.height / 2

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentPct = await readZoomPercent(page)
    if (Math.abs(currentPct - targetPct) <= tolerancePct) return

    const factor = targetPct / currentPct
    const deltaY = Math.log(factor) / Math.log(0.9985)

    await page.mouse.move(anchorX, anchorY)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, deltaY)
    await page.keyboard.up('Control')
    // Store commit is debounced ~100ms after the last wheel event
    // (useCanvas.ts's scheduleStoreCommit) — ZoomControls reads the
    // committed value, not the ref-driven live transform.
    await page.waitForTimeout(220)
  }
  throw new Error(
    `zoomToPercent: could not reach ${targetPct}% (stuck at ${await readZoomPercent(page)}%) after 8 attempts`,
  )
}

test.describe('canvas-05 / WS-5.1: selection ring and inspector must not drift at zoom ≠ 1 with pan', () => {
  test('at 58% zoom with a non-zero pan offset, the ring lands on the element and the inspector anchors beside it', async ({
    page,
  }) => {
    const projectDir = await findProjectDir(page, PROJECT_FOLDER_NAME)
    if (!projectDir) {
      test.skip(true, `studio-workspace/${PROJECT_FOLDER_NAME} is not present on disk for this run`)
      return
    }

    await page.addInitScript((dir: string) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
    }, projectDir)

    await page.goto('/admin/site?studio')
    const canvasRoot = page.getByTestId('canvas-root')
    await expect(canvasRoot).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('board-frames-layer')).toBeAttached()

    const targetFrame = page.locator(`[data-page-id="${TARGET_PAGE_ID}"]`)
    await expect(targetFrame, `expected exactly one board frame for page id "${TARGET_PAGE_ID}"`).toHaveCount(1)

    // Let the canvas's own "center on open" pass settle before driving
    // pan/zoom ourselves (same reasoning as frame-fit-height.e2e.ts).
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    await panIntoView(page, canvasRoot, targetFrame)

    const iframeEl = targetFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(iframeEl, 'the manual-entry frame never mounted a live iframe').toBeVisible({ timeout: 15_000 })

    const contentFrame = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    // ManualEntryScreen.jsx: <Button variant="primary" label={t.common.confirm} .../>
    // from @alm-design/design-system — an alm.* module, so InPlaceInspector
    // (studio-only, single-select, alm.* gate) renders real content for it.
    const confirmButton = contentFrame.getByRole('button', { name: 'Confirm', exact: true })
    await expect(confirmButton, 'the Confirm button never rendered inside the frame').toBeVisible({
      timeout: 15_000,
    })

    // ── The reproduction: 58% zoom (the user's own screenshot), THEN the
    // Confirm button centered, THEN a deliberate extra pan so it is NOT
    // centered in the viewport — both terms of the old `elementRect × zoom +
    // iframeOffset + panOffset` bug have to be live and non-trivial for this
    // to be a real repro. The manual-entry sheet is tall (a bottom sheet), so
    // panning the whole FRAME into view does not guarantee the Confirm
    // button itself is on screen — center on the button directly. ──
    await zoomToPercent(page, canvasRoot, TARGET_ZOOM_PCT)
    expect(await readZoomPercent(page), 'failed to reach the target zoom before panning').toBeGreaterThanOrEqual(
      TARGET_ZOOM_PCT - 1,
    )
    await panIntoView(page, canvasRoot, confirmButton, 40)
    // Small, deliberate offset — enough to be a genuine non-zero pan (not
    // exactly viewport-centered, matching the user's real screenshot) while
    // staying well inside a normal viewport from a centered start.
    // Positive dy here pans the button UP (away from the canvas root's
    // bottom edge) — selecting it opens the docked Properties panel, which
    // can shrink the canvas root's own visible height, so a button already
    // close to the bottom before that shift can end up just past it after.
    // A little headroom keeps the repro about zoom/pan drift, not about
    // exactly matching the panel's height change.
    await panBy(page, canvasRoot, 40, 40)

    // Re-confirm the button is still visible AND actually within the
    // viewport bounds post pan/zoom — `locator.click()`'s auto-scroll can't
    // help here (the canvas pans externally, it has no native scroll
    // container), so a mis-calibrated offset would hang waiting for
    // "scroll into view" instead of failing with a clear message.
    await expect(confirmButton).toBeVisible()
    const preClickButtonBox = await confirmButton.boundingBox()
    expect(preClickButtonBox, 'Confirm button lost its bounding box after zoom/pan').not.toBeNull()
    const viewportForClick = page.viewportSize()
    expect(viewportForClick, 'no viewport size reported').not.toBeNull()
    const inViewport =
      preClickButtonBox!.x >= 0 &&
      preClickButtonBox!.y >= 0 &&
      preClickButtonBox!.x + preClickButtonBox!.width <= viewportForClick!.width &&
      preClickButtonBox!.y + preClickButtonBox!.height <= viewportForClick!.height
    expect(
      inViewport,
      `Confirm button ended up outside the viewport after pan (box=${JSON.stringify(preClickButtonBox)}, ` +
        `viewport=${JSON.stringify(viewportForClick)}) — the deliberate pan offset needs recalibrating, ` +
        'not a bug in the fix under test.',
    ).toBe(true)
    // Also inside the CANVAS ROOT's own box, not just the page viewport —
    // `positionInspector`/`positionToolbar` hide anything outside the canvas
    // root specifically (`isFullyOutOfView`), which can be smaller than the
    // full browser viewport (docked panels, top chrome).
    const canvasRootBoxForClick = await canvasRoot.boundingBox()
    expect(canvasRootBoxForClick, 'canvas root lost its bounding box after pan').not.toBeNull()
    const insideCanvasRoot =
      preClickButtonBox!.x >= canvasRootBoxForClick!.x &&
      preClickButtonBox!.y >= canvasRootBoxForClick!.y &&
      preClickButtonBox!.x + preClickButtonBox!.width <= canvasRootBoxForClick!.x + canvasRootBoxForClick!.width &&
      preClickButtonBox!.y + preClickButtonBox!.height <= canvasRootBoxForClick!.y + canvasRootBoxForClick!.height
    expect(
      insideCanvasRoot,
      `Confirm button ended up outside the CANVAS ROOT's own box after pan (button=${JSON.stringify(preClickButtonBox)}, ` +
        `canvasRoot=${JSON.stringify(canvasRootBoxForClick)}) — the deliberate pan offset needs recalibrating, ` +
        'not a bug in the fix under test.',
    ).toBe(true)

    // Select it via real mouse coordinates (not locator.click()'s
    // scroll-into-view actionability, which assumes a native scroll
    // container the canvas doesn't have).
    await page.mouse.click(
      preClickButtonBox!.x + preClickButtonBox!.width / 2,
      preClickButtonBox!.y + preClickButtonBox!.height / 2,
    )

    // Selection ring: portaled INSIDE the iframe now (WS-5.1), so it's
    // queried through contentFrame, not the parent document.
    const ring = contentFrame.locator('[data-canvas-selection-ring="true"]')
    await expect(ring, 'no selection ring appeared inside the iframe after selecting the button').toBeVisible({
      timeout: 5_000,
    })

    // Selecting an alm.* node opens the docked Properties panel, which can
    // shrink the canvas root's own visible height (fewer px available beside
    // the panel). A button positioned near the bottom of the PRE-selection
    // canvas root can end up past the bottom of the SMALLER post-selection
    // one — a real, separate layout fact, not the drift `standing-03`
    // describes. Re-pan (a genuine pan COMMIT — one of the two triggers
    // `anchorDirtyRef` gates on) against the now-current canvas root once the
    // panel has settled, so the rest of this test is only exercising the
    // fix's own geometry, not an incidental panel-open layout shift.
    await page.waitForTimeout(200)
    await panIntoView(page, canvasRoot, confirmButton, 40)

    // The in-place inspector — parent document, anchored via the
    // `--selection-anchor-*` channel (see BreakpointSelectionOverlay.tsx).
    // EVERY board frame mounts its own wrapper (studio board frames share one
    // synthetic breakpoint id, so `showInspector` can't distinguish them —
    // see BreakpointSelectionOverlay.tsx's own comment on `showInspector`);
    // only the ONE whose iframe actually contains the selected node ever gets
    // a real `positionInspector` call (which sets `left`/`top` inline) — the
    // rest stay hidden or sit untouched at their unpositioned CSS default, so
    // `[style*="left"]` — not `:visible`, which several of those defaults can
    // also satisfy — is what actually picks out the real one.
    await expect(
      page.locator('[data-canvas-in-place-inspector="true"][style*="left"]'),
      'InPlaceInspector wrapper never mounted/positioned for the selected alm.button node',
    ).toBeVisible({ timeout: 10_000 })
    const inspector = page.locator('[data-canvas-in-place-inspector="true"][style*="left"]')

    const [ringBox, buttonBox, inspectorBox] = await Promise.all([
      ring.boundingBox(),
      confirmButton.boundingBox(),
      inspector.boundingBox(),
    ])
    expect(ringBox, 'selection ring has no bounding box').not.toBeNull()
    expect(buttonBox, 'Confirm button has no bounding box').not.toBeNull()
    expect(inspectorBox, 'InPlaceInspector has no bounding box').not.toBeNull()

    // ── Assertion 1: the ring lands ON the element, not near it ──
    // A couple of pixels of tolerance for sub-pixel rounding at a
    // fractional (58%) zoom — NOT the tens/hundreds of px `standing-03`
    // reported. Do not widen this tolerance to make a real drift pass.
    const RING_TOLERANCE_PX = 3
    const ringDrift = {
      x: Math.abs(ringBox!.x - buttonBox!.x),
      y: Math.abs(ringBox!.y - buttonBox!.y),
      width: Math.abs(ringBox!.width - buttonBox!.width),
      height: Math.abs(ringBox!.height - buttonBox!.height),
    }
    const ringDriftMessage =
      `selection ring drifted from the Confirm button at ${TARGET_ZOOM_PCT}% zoom with pan — ` +
      `ring=${JSON.stringify(ringBox)} button=${JSON.stringify(buttonBox)} drift=${JSON.stringify(ringDrift)}. ` +
      'This is exactly the standing-03 defect (WS-5.1 was supposed to fix it) — do not widen ' +
      'RING_TOLERANCE_PX to pass.'
    expect(ringDrift.x, ringDriftMessage).toBeLessThanOrEqual(RING_TOLERANCE_PX)
    expect(ringDrift.y, ringDriftMessage).toBeLessThanOrEqual(RING_TOLERANCE_PX)
    expect(ringDrift.width, ringDriftMessage).toBeLessThanOrEqual(RING_TOLERANCE_PX)
    expect(ringDrift.height, ringDriftMessage).toBeLessThanOrEqual(RING_TOLERANCE_PX)

    // ── Assertion 2: the inspector anchors ADJACENT to the element, not
    // detached at the viewport edge (the user's literal complaint: "the
    // props are at the edge of the screen away from me"). `positionInspector`
    // places it just below the element with a 12px gap; allow generous slack
    // for the zoom-scaled gap and the canvas-edge clamp, while still failing
    // hard on a "hundreds of px away" / viewport-edge-pinned regression. ──
    const viewport = page.viewportSize()
    expect(viewport, 'no viewport size reported').not.toBeNull()
    const gapBelowButton = inspectorBox!.y - (buttonBox!.y + buttonBox!.height)
    const horizontalOffset = Math.abs(inspectorBox!.x - buttonBox!.x)
    const anchorMessage =
      `InPlaceInspector anchored far from the Confirm button — inspector=${JSON.stringify(inspectorBox)} ` +
      `button=${JSON.stringify(buttonBox)} gapBelowButton=${gapBelowButton.toFixed(1)} ` +
      `horizontalOffset=${horizontalOffset.toFixed(1)}. This is the user's literal complaint ("props are ` +
      'at the edge of the screen away from me") — do not widen these bounds to pass.'
    expect(gapBelowButton, anchorMessage).toBeGreaterThanOrEqual(-4)
    expect(gapBelowButton, anchorMessage).toBeLessThanOrEqual(60)
    expect(horizontalOffset, anchorMessage).toBeLessThanOrEqual(200)
    // Not pinned to the viewport's own edges (the pre-fix failure mode: the
    // inspector clamped to (near) the canvas root's far corner regardless of
    // where the element actually was).
    expect(
      inspectorBox!.x,
      'inspector sits pinned against the LEFT viewport edge, not near the element',
    ).toBeGreaterThan(8)
    expect(
      inspectorBox!.x + inspectorBox!.width,
      'inspector sits pinned against the RIGHT viewport edge, not near the element',
    ).toBeLessThan(viewport!.width - 8)
  })
})
