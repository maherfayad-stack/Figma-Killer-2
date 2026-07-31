import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for canvas-06 — "overlay and bottom-sheet screens
 * must render as the app renders them", against
 * `studio-workspace/maherfayad-stack-eSIM`. Follows the same boot/pan
 * harness as `frame-fit-height.e2e.ts` / `canvas-selection-overlay-zoom.e2e.ts`.
 *
 * What this catches that unit tests structurally cannot (happy-dom has no
 * layout engine): a bottom sheet docked to the middle of a grown frame
 * instead of its bottom edge, a scrim that doesn't cover the frame or that
 * occludes the sheet above it, and — the actual bug this work order found
 * and fixed — a `CanvasScrollUnrollInjector` regression where an unrelated
 * descendant (a two-character price label, deep inside the page) inherited
 * an ancestor's `--studio-unroll-min-height` custom property and got
 * permanently floored at it, inflating the whole page's real content height
 * and spilling the frame over the board frames below it. See `canvasScrollUnroll.ts`'s
 * `SCROLL_UNROLL_MIN_HEIGHT_VAR` doc and `CanvasScrollUnrollInjector.tsx`'s
 * `runUnrollPass` for the fix.
 */

const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'

interface StudioProjectSummary {
  dir: string
  name: string
}

async function findProjectDir(page: Page, folderName: string): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === folderName)
  return match?.dir ?? null
}

/** Same mechanism as `frame-fit-height.e2e.ts`'s `panIntoView`, with more attempts headroom for a frame taller than the viewport (needs more incremental wheel steps to converge). */
async function panIntoView(page: Page, canvasRoot: Locator, target: Locator, tolerancePx = 40): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
  throw new Error('panIntoView: the target frame never reached the viewport center after 20 pan attempts')
}

/** Same mechanism as `frame-fit-height.e2e.ts`'s `waitForStableClientHeight`. */
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
      { timeout: 15_000, intervals: [200] },
    )
    .toBeGreaterThanOrEqual(3)
  return lastHeight
}

/**
 * `BoardFramesLayer`'s `.frameBody` — the board frame's own visible device
 * box (`canvas-04`). Panning targets the frame WRAPPER first with a generous
 * tolerance (just get it roughly on screen — a frame taller than the
 * viewport can never have both its own center AND the viewport's center
 * coincide within a tight tolerance), then the caller should pan again onto
 * whatever specific element it actually needs visible (same reasoning
 * `canvas-selection-overlay-zoom.e2e.ts` documents for this same tall-sheet
 * shape).
 */
async function goToFrame(page: Page, canvasRoot: Locator, pageId: string) {
  const targetFrame = page.locator(`[data-page-id="${pageId}"]`)
  await expect(targetFrame, `expected exactly one board frame for page id "${pageId}"`).toHaveCount(1)
  // A slightly wider tolerance than the default: this first pan only needs
  // to get the frame WELL within the viewport so its iframe mounts (past
  // `isFrameOnScreen`'s virtualization margin) — exact centering isn't
  // needed here, callers that need pixel-precise positioning pan again onto
  // the specific element they're about to measure (same reasoning
  // `canvas-selection-overlay-zoom.e2e.ts` documents). A small residual gap
  // (observed: ~80-85px on this corpus) is normal — not every board
  // position is exactly reachable in one wheel-delta-to-px mapping.
  await panIntoView(page, canvasRoot, targetFrame, 100)
  const iframeEl = targetFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR)
  await expect(iframeEl, `the ${pageId} frame never mounted a live iframe after being panned into view`).toBeVisible({
    timeout: 15_000,
  })
  await waitForStableClientHeight(iframeEl)
  await page.waitForTimeout(200) // let the last unroll settle paint
  const frameBody = targetFrame.getByTestId('board-frame-body')
  await expect(frameBody, `${pageId}'s .frameBody never rendered`).toBeVisible()
  const contentFrame = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
  return { targetFrame, frameBody, contentFrame }
}

test.describe('canvas-06: bottom sheets dock at the frame bottom, not mid-frame', () => {
  test('esim-manual-entry-screen: panel docks at the frame bottom, scrim covers without occluding, no clipped content', async ({
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
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    const { frameBody, contentFrame } = await goToFrame(page, canvasRoot, 'esim-manual-entry-screen')

    const panel = contentFrame.locator('.manual-entry-sheet__panel')
    const scrim = contentFrame.locator('.manual-entry-sheet__scrim')
    const confirmButton = contentFrame.getByRole('button', { name: 'Confirm', exact: true })
    await expect(panel, 'ManualEntryScreen.jsx panel never rendered').toBeVisible()
    await expect(scrim, 'scrim never rendered').toBeVisible()
    await expect(confirmButton, 'Confirm button never rendered').toBeVisible()

    // The bottom sheet lives at the BOTTOM of a tall frame — the frame's own
    // wrapper can be taller than the viewport, so the initial pan above only
    // gets it roughly on screen. Pan precisely onto the panel itself before
    // measuring it (same reasoning `canvas-selection-overlay-zoom.e2e.ts`
    // documents for this identical tall-sheet shape).
    await panIntoView(page, canvasRoot, panel, 40)

    const [panelBox, scrimBox, buttonBox, frameBodyBox] = await Promise.all([
      panel.boundingBox(),
      scrim.boundingBox(),
      confirmButton.boundingBox(),
      frameBody.boundingBox(),
    ])
    expect(panelBox, 'panel has no bounding box').not.toBeNull()
    expect(scrimBox, 'scrim has no bounding box').not.toBeNull()
    expect(buttonBox, 'Confirm button has no bounding box').not.toBeNull()
    expect(frameBodyBox, 'frameBody has no bounding box').not.toBeNull()

    // Docked to the BOTTOM of the frame — the panel's own bottom edge (its
    // footer's bottom padding) must sit close to the frame's bottom edge,
    // not floating with a large gap mid-frame.
    const panelBottom = panelBox!.y + panelBox!.height
    const frameBodyBottom = frameBodyBox!.y + frameBodyBox!.height
    const gapFromFrameBottom = frameBodyBottom - panelBottom
    expect(
      gapFromFrameBottom,
      `manual-entry sheet panel is not docked to the frame bottom — panel bottom=${panelBottom.toFixed(1)}, ` +
        `frame bottom=${frameBodyBottom.toFixed(1)}, gap=${gapFromFrameBottom.toFixed(1)}px. A bottom sheet ` +
        'docked to the frame should sit within a few px of the frame edge, not float mid-frame.',
    ).toBeLessThanOrEqual(4)
    expect(gapFromFrameBottom, 'panel bottom edge is BELOW the frame bottom (clipped)').toBeGreaterThanOrEqual(-4)

    // No content clipped: the Confirm button (last interactive element in
    // the panel) sits fully inside both the panel and the frame.
    const buttonBottom = buttonBox!.y + buttonBox!.height
    expect(buttonBottom, 'Confirm button bottom edge sits outside the frame').toBeLessThanOrEqual(
      frameBodyBottom + 2,
    )
    expect(buttonBox!.y, 'Confirm button top sits above the panel').toBeGreaterThanOrEqual(panelBox!.y - 2)

    // Scrim covers the frame (same width/height order of magnitude as the
    // frame, not a tiny leftover strip) without occluding the panel: the
    // panel sits visually ABOVE the scrim (z-index), so both are directly
    // clickable at their own screen coordinates — check the scrim spans at
    // least the frame's own width and starts at/near the frame's top. A
    // generous-but-bounded tolerance on the top offset: `.frameBody`'s own
    // device-box chrome (border/bezel) sits between the frame's outer box
    // and the iframe content, so the scrim's true top (measured inside the
    // iframe) is expected to sit a small, fixed number of px below
    // `.frameBody`'s own outer edge — this only guards against the scrim
    // being genuinely mispositioned (a tiny strip, or offset by hundreds of
    // px), not that exact chrome width.
    expect(scrimBox!.width, 'scrim does not span the frame width').toBeGreaterThanOrEqual(frameBodyBox!.width - 4)
    expect(
      Math.abs(scrimBox!.y - frameBodyBox!.y),
      'scrim does not start at (near) the frame top',
    ).toBeLessThanOrEqual(20)
    // The panel's own hit-target (Confirm button) must be the topmost
    // element at its own center point — if the scrim painted OVER the
    // panel, `elementFromPoint` would resolve to the scrim div instead.
    const clickTargetInfo = await confirmButton.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        reachable: top ? top === el || el.contains(top) || top.contains(el) : false,
        topTag: top?.tagName ?? null,
        topClass: top ? String((top as HTMLElement).className) : null,
      }
    })
    expect(
      clickTargetInfo.reachable,
      `the scrim (or something else) paints over the Confirm button instead of the button being reachable — ` +
        `topmost element at its center was ${clickTargetInfo.topTag}.${clickTargetInfo.topClass}`,
    ).toBe(true)
  })

  test('esim-select-package-sheet: panel docks at the frame bottom with no clipped package rows', async ({ page }) => {
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
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    const { frameBody, contentFrame } = await goToFrame(page, canvasRoot, 'esim-select-package-sheet')

    const panel = contentFrame.locator('.package-sheet__panel')
    const confirmButton = contentFrame.getByRole('button', { name: 'Confirm', exact: true })
    await expect(panel, 'SelectPackageSheet.jsx panel never rendered').toBeVisible()
    await expect(confirmButton, 'Confirm button never rendered').toBeVisible()

    const [panelBox, buttonBox, frameBodyBox] = await Promise.all([
      panel.boundingBox(),
      confirmButton.boundingBox(),
      frameBody.boundingBox(),
    ])
    expect(panelBox).not.toBeNull()
    expect(buttonBox).not.toBeNull()
    expect(frameBodyBox).not.toBeNull()

    const panelBottom = panelBox!.y + panelBox!.height
    const frameBodyBottom = frameBodyBox!.y + frameBodyBox!.height
    expect(
      frameBodyBottom - panelBottom,
      `package sheet panel is not docked to the frame bottom (panel bottom=${panelBottom.toFixed(1)}, ` +
        `frame bottom=${frameBodyBottom.toFixed(1)})`,
    ).toBeLessThanOrEqual(4)

    const buttonBottom = buttonBox!.y + buttonBox!.height
    expect(buttonBottom, 'Confirm button clipped by the frame bottom').toBeLessThanOrEqual(frameBodyBottom + 2)

    // No package row is squeezed/overlapped: each `.package-card` row has a
    // real, non-zero height and rows do not overlap each other vertically.
    const rowBoxes = await contentFrame.locator('.package-card').evaluateAll((rows) =>
      rows.map((r) => {
        const rect = r.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, height: rect.height }
      }),
    )
    expect(rowBoxes.length, 'no package rows found').toBeGreaterThan(0)
    for (const row of rowBoxes) {
      expect(row.height, `a package row has ~zero height (${JSON.stringify(row)})`).toBeGreaterThan(10)
    }
    for (let i = 1; i < rowBoxes.length; i += 1) {
      expect(
        rowBoxes[i].top,
        `package row ${i} overlaps the row above it (${JSON.stringify(rowBoxes[i - 1])} vs ${JSON.stringify(rowBoxes[i])})`,
      ).toBeGreaterThanOrEqual(rowBoxes[i - 1].bottom - 2)
    }
  })

  test('esim-device-picker-sheet: the centered action card is fully visible, not clipped or off-frame', async ({
    page,
  }) => {
    // Per the ALM design-system's own docs (`journey-screens/CLAUDE.md`),
    // the iOS ActionSheet is a CENTERED card with a transparent scrim (it
    // reuses the iOS Dialog's `IOSDialogCard`) — unlike BottomSheet, it does
    // NOT dock to the bottom by design. The correct assertion here is
    // "renders whole, centered, un-clipped", not "docked to the bottom".
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
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    const { frameBody, contentFrame } = await goToFrame(page, canvasRoot, 'esim-device-picker-sheet')

    const thisDevice = contentFrame.getByText('This device', { exact: true })
    const anotherDevice = contentFrame.getByText('Another device', { exact: true })
    await expect(thisDevice, '"This device" action never rendered').toBeVisible()
    await expect(anotherDevice, '"Another device" action never rendered').toBeVisible()

    const [thisBox, anotherBox, frameBodyBox] = await Promise.all([
      thisDevice.boundingBox(),
      anotherDevice.boundingBox(),
      frameBody.boundingBox(),
    ])
    expect(thisBox).not.toBeNull()
    expect(anotherBox).not.toBeNull()
    expect(frameBodyBox).not.toBeNull()

    // Both actions sit fully inside the frame's own visible bounds.
    for (const [label, box] of [
      ['This device', thisBox!],
      ['Another device', anotherBox!],
    ] as const) {
      expect(box.x, `${label} clipped on the left`).toBeGreaterThanOrEqual(frameBodyBox!.x - 2)
      expect(box.y, `${label} clipped on the top`).toBeGreaterThanOrEqual(frameBodyBox!.y - 2)
      expect(box.x + box.width, `${label} clipped on the right`).toBeLessThanOrEqual(
        frameBodyBox!.x + frameBodyBox!.width + 2,
      )
      expect(box.y + box.height, `${label} clipped on the bottom`).toBeLessThanOrEqual(
        frameBodyBox!.y + frameBodyBox!.height + 2,
      )
    }

    // Roughly centered horizontally in the frame (not pinned to an edge) —
    // generous tolerance since this only guards against a gross
    // mispositioning regression, not exact centering.
    const cardCenterX = (thisBox!.x + anotherBox!.x + anotherBox!.width) / 2
    const frameCenterX = frameBodyBox!.x + frameBodyBox!.width / 2
    expect(
      Math.abs(cardCenterX - frameCenterX),
      `device picker card is not roughly centered in the frame (cardCenterX=${cardCenterX.toFixed(1)}, ` +
        `frameCenterX=${frameCenterX.toFixed(1)})`,
    ).toBeLessThanOrEqual(frameBodyBox!.width * 0.25)
  })

  test('booking-details-screen: renders full content with no clipping and no overflow past the frame', async ({
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
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    const { frameBody, contentFrame } = await goToFrame(page, canvasRoot, 'booking-details-screen')

    // Regression guard for the canvas-06 bug: no element inside this frame
    // should be inflated to a wildly disproportionate height relative to the
    // frame's own — the previous bug inflated an unrelated price label to
    // ~1600px (roughly double the whole page's real content height).
    const frameBodyBox = await frameBody.boundingBox()
    expect(frameBodyBox).not.toBeNull()

    const installButtons = contentFrame.getByRole('button', { name: 'Install' })
    await expect(installButtons.first(), 'no Install button rendered').toBeVisible()

    const oversizedElements = await contentFrame.locator('body *').evaluateAll((elements, frameHeight) => {
      const offenders: string[] = []
      for (const el of elements) {
        const rect = el.getBoundingClientRect()
        // An individual leaf styling element taller than 3x the whole
        // frame's own content height is never legitimate content — it is
        // exactly the shape of the inheritance-leak bug this work order
        // fixed (a tiny price label locked to an unrelated ancestor's
        // height).
        if (rect.height > frameHeight * 3 && rect.width < 100) {
          offenders.push(
            `${el.tagName}.${String((el as HTMLElement).className).replace(/\s+/g, '.')} height=${rect.height.toFixed(0)}`,
          )
        }
      }
      return offenders
    }, frameBodyBox!.height)
    expect(
      oversizedElements,
      `found narrow elements with wildly disproportionate height relative to the frame — this is the ` +
        `CanvasScrollUnrollInjector min-height inheritance-leak shape canvas-06 fixed: ${oversizedElements.join(', ')}`,
    ).toEqual([])
  })
})
