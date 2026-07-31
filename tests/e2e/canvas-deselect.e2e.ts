import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for `select-01`: **you must be able to get back to
 * nothing selected.**
 *
 * The user dogfooded the board and reported "I can't deselect after selecting."
 * No unit test in this repo could see it: happy-dom has no iframes with their
 * own event loop, so it cannot model the one mechanism that broke it — a
 * keystroke that originates inside a canvas frame's `<iframe>`, is re-dispatched
 * by `IframeFrameSurface`'s bridge onto the PARENT `document`, and therefore
 * never reaches any React `onKeyDown` (React 19 delegates to its root container,
 * a descendant of `document`; an event whose target IS `document` propagates
 * document → window only). `useCanvasKeyboardShortcuts` — where the generic
 * "Escape clears the selection" branch used to live — is exactly such a React
 * `onKeyDown`, and clicking a node focuses the element inside the iframe
 * (`focusNodeWithoutScrolling`), so after ANY normal selection Escape was
 * delivered to a handler that could not run.
 *
 * The four claims below are the whole precedence ladder, asserted end to end:
 *
 *   1. Select a node, press Escape → nothing selected.
 *   2. Select a node, click empty board background → nothing selected.
 *   3. Enter an instance, press Escape → steps OUT to the instance (does NOT
 *      clear); press Escape again → nothing selected.
 *   4. A marquee drag that hits no frame ends with nothing selected.
 *
 * "Nothing selected" is read from the canvas the way a user reads it: the
 * in-iframe selection ring (`[data-canvas-selection-ring="true"]`, WS-5.1) is
 * gone. That is a rendered consequence of store state, not a store call.
 *
 * SAFETY — this spec runs against REAL USER DATA (`studio-workspace/`) and
 * mutates nothing. It only selects and deselects; auto-save is switched off in
 * `localStorage` before boot anyway, and no edit, save, or detach is performed.
 */

const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'
const TARGET_PAGE_ID = 'booking-confirmation-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
const SELECTION_RING = '[data-canvas-selection-ring="true"]'

interface StudioProjectSummary {
  dir: string
  name: string
}

/** Same lookup pattern as `instance-selection-ui.e2e.ts`. */
async function findProjectDir(page: Page, folderName: string): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === folderName)
  return match?.dir ?? null
}

/** Same pan mechanism as `frame-fit-height.e2e.ts` / `instance-selection-ui.e2e.ts`. */
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
    const dx = targetBox.x + targetBox.width / 2 - rootCenterX
    const dy = targetBox.y + targetBox.height / 2 - rootCenterY
    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target never reached the viewport center after 8 pan attempts')
}

/**
 * Click an element rendered INSIDE a canvas iframe with real mouse coordinates.
 * `locator.click()`'s actionability wants to scroll the element into view and
 * the canvas pans via a CSS transform (no scroll container), so it would hang.
 */
async function clickInFrame(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

/**
 * A viewport point that hit-tests to the canvas root itself — genuine empty
 * board background. Scanned rather than guessed because the board's frames move
 * with every pan, and because `.layer`/`.transformLayer` are 0×0 in studio board
 * mode (see `useMarqueeSelection`'s module doc), so background points resolve
 * straight to `[data-studio-canvas-root]`.
 */
async function findEmptyBackgroundPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const root = document.querySelector('[data-studio-canvas-root="true"]')
    if (!(root instanceof HTMLElement)) return null
    const rect = root.getBoundingClientRect()
    const STEPS = 24
    for (let row = 1; row < STEPS; row += 1) {
      for (let col = STEPS - 1; col >= 1; col -= 1) {
        const x = rect.left + (rect.width * col) / STEPS
        const y = rect.top + (rect.height * row) / STEPS
        if (document.elementFromPoint(x, y) === root) return { x, y }
      }
    }
    return null
  })
  expect(point, 'no empty canvas background point found in the viewport').not.toBeNull()
  return point!
}

test.describe('select-01: deselect always gets you back to nothing selected', () => {
  // Four interaction phases against a 15-page corpus board, plus a possible
  // cold ts-morph parse on open — the 60s default covers none of that.
  test.setTimeout(300_000)

  test('Escape, background click, instance step-out, and an empty marquee all end at nothing selected', async ({
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
      // `usePersistence`'s auto-save scheduler bails when this is false, so no
      // store change this spec makes can reach the user's disk.
      window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: false }))
    }, projectDir)

    await page.goto('/admin/site?studio')
    const canvasRoot = page.getByTestId('canvas-root')
    await expect(canvasRoot).toBeVisible({ timeout: 20_000 })
    // A COLD `pageParseCache` re-parses all 15 corpus pages with ts-morph before
    // the board mounts; the shell shows its CMS "could not load" state meanwhile
    // — transient, not a failure.
    await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 90_000 })
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 30_000 })

    const targetFrame = page.locator(`[data-page-id="${TARGET_PAGE_ID}"]`)
    await expect(targetFrame, `expected one board frame for page id "${TARGET_PAGE_ID}"`).toHaveCount(1)
    await panIntoView(page, canvasRoot, targetFrame)

    const contentFrame: FrameLocator = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    const rings = contentFrame.locator(SELECTION_RING)
    const detachButton = page.getByTestId('instance-detach-button')

    // `<Price value="69" />` — a local component instance whose expansion is
    // easy to hit and whose call site is a real `studio.instance`, so the same
    // target serves both the plain-selection cases and the instance ladder.
    const priceValue = contentFrame.locator('.price__value', { hasText: '69' }).first()
    await panIntoView(page, canvasRoot, priceValue, 60)

    // ── 1. Select, then Escape → nothing selected ──────────────────────────
    await clickInFrame(page, priceValue)
    await expect(rings, 'clicking a node drew no selection ring').toHaveCount(1, { timeout: 10_000 })

    await page.keyboard.press('Escape')
    await expect(
      rings,
      'Escape did not clear the selection — this is the reported "I can\'t deselect" defect',
    ).toHaveCount(0, { timeout: 10_000 })

    // ── 2. Select, then click empty board background → nothing selected ────
    await clickInFrame(page, priceValue)
    await expect(rings, 'clicking a node drew no selection ring').toHaveCount(1, { timeout: 10_000 })

    const background = await findEmptyBackgroundPoint(page)
    await page.mouse.click(background.x, background.y)
    await expect(
      rings,
      'clicking empty board background did not clear the selection',
    ).toHaveCount(0, { timeout: 10_000 })

    // ── 3. Instance ladder: Escape steps OUT first, and only then clears ───
    await clickInFrame(page, priceValue)
    await expect(
      detachButton,
      'clicking the component did not select its studio.instance',
    ).toBeVisible({ timeout: 10_000 })
    const instanceNodeId = await rings.first().getAttribute('data-canvas-overlay-node-id')
    expect(instanceNodeId, 'the selection ring is not tracking any node id').toBeTruthy()

    await page.keyboard.press('Enter')
    await expect(
      detachButton,
      'Enter did not step INTO the instance',
    ).toBeHidden({ timeout: 10_000 })

    // First Escape: steps OUT one level. It must NOT clear — a cleared
    // selection here is the regression `instance-ui-01` fixed.
    await page.keyboard.press('Escape')
    await expect(
      rings,
      'Escape inside an entered instance cleared the selection instead of stepping out',
    ).toHaveCount(1, { timeout: 10_000 })
    expect(
      await rings.first().getAttribute('data-canvas-overlay-node-id'),
      'Escape did not step back OUT to the instance call site',
    ).toBe(instanceNodeId)

    // Second Escape: nothing entered any more, so it means "clear".
    await page.keyboard.press('Escape')
    await expect(
      rings,
      'Escape with a selection and nothing entered did not clear the selection',
    ).toHaveCount(0, { timeout: 10_000 })

    // ── 4. A marquee drag that hits no frame ends at nothing selected ──────
    await clickInFrame(page, priceValue)
    await expect(rings, 'clicking a node drew no selection ring').toHaveCount(1, { timeout: 10_000 })

    const dragStart = await findEmptyBackgroundPoint(page)
    const dragEnd = { x: dragStart.x + 60, y: dragStart.y + 60 }
    const dragEndIsBackground = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y) === document.querySelector('[data-studio-canvas-root="true"]'),
      dragEnd,
    )
    expect(dragEndIsBackground, 'the marquee drag would have crossed a frame').toBe(true)

    await page.mouse.move(dragStart.x, dragStart.y)
    await page.mouse.down()
    await page.mouse.move(dragStart.x + 20, dragStart.y + 20, { steps: 4 })
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 6 })
    await page.mouse.up()

    await expect(
      rings,
      'a marquee drag that selected no frame left the node selection behind',
    ).toHaveCount(0, { timeout: 10_000 })
    await expect(
      page.locator('[data-page-id][data-selected="true"]'),
      'a marquee drag that hit no frame still selected a frame',
    ).toHaveCount(0)
  })
})
