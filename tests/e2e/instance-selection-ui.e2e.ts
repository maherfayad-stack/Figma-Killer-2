import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for `instance-ui-01`: the PANEL + SELECTION half of
 * WS-4.2, which `parser-05` shipped the engine for and explicitly named as an
 * honest gap.
 *
 * Why this spec has to exist at all is `STATE.md`'s standing acceptance bar:
 * happy-dom has no layout engine and no real input pipeline, so a green
 * `bun test` cannot tell you whether a user can actually click a component,
 * see it ring, step into it, and edit its call-site props. Three features this
 * run shipped green and unusable. Everything below drives real mouse and real
 * keys.
 *
 * The four user-visible claims, each asserted against the real corpus
 * (`studio-workspace/maherfayad-stack-eSIM`, `booking-confirmation-screen`):
 *
 *   1. Clicking a component selects the INSTANCE (`studio.instance`), not the
 *      deep descendant under the cursor, and the selection ring RENDERS for it
 *      — the non-obvious half, because a `studio.instance` is a bare React
 *      Fragment with zero DOM elements (`InstanceEditor.tsx`), so
 *      `[data-node-id="…"]` finds nothing and the ring had no box to measure
 *      until `canvasNodeLookup`'s fragment fallback.
 *   2. Enter steps INTO the instance, Escape steps back OUT to it (Figma's
 *      component/instance model, asked for by name).
 *   3. The call-site prop panel edits `instanceOf.callSiteProps` per instance.
 *   4. Detach is refusal-first: on the 58% of corpus instances where it cannot
 *      land, the user gets the parser's own human-readable reason, not a
 *      failure.
 *
 * SAFETY — this spec runs against REAL USER DATA and must not mutate it.
 * Two independent guards:
 *   - Auto-save is switched OFF in `localStorage` before the app boots, so the
 *     call-site prop edit in step 3 stays in the editor store and never
 *     reaches disk. Nothing here presses Cmd+S.
 *   - Detach is only ever clicked on `SheetHeader`, which calls `useLanguage()`
 *     and therefore REFUSES (`uses-hooks`). A refused codemod writes nothing.
 *     Detach is deliberately never clicked on a component that would succeed —
 *     that path writes to source immediately (a direct one-shot HTTP call, not
 *     the autosave batch), which is exactly what this spec must not do.
 */

const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'
const TARGET_PAGE_ID = 'booking-confirmation-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

interface StudioProjectSummary {
  dir: string
  name: string
}

/** Same lookup pattern as `canvas-selection-overlay-zoom.e2e.ts`. */
async function findProjectDir(page: Page, folderName: string): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === folderName)
  return match?.dir ?? null
}

/** Same pan mechanism as `frame-fit-height.e2e.ts` / the overlay-zoom spec. */
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
 * Click an element rendered INSIDE a canvas iframe using real mouse
 * coordinates. `locator.click()`'s actionability wants to scroll the element
 * into view, and the canvas has no native scroll container to scroll (it pans
 * via a CSS transform), so it would hang instead of failing usefully.
 */
async function clickInFrame(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

/** Open the board with auto-save disabled — see this file's SAFETY note. */
async function openStudioBoard(page: Page, projectDir: string): Promise<Locator> {
  await page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
    // `usePersistence`'s auto-save scheduler bails on `readAutoSavePreference()`
    // being false, so no store edit this spec makes can reach the user's disk.
    window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: false }))
  }, projectDir)

  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 20_000 })
  // A COLD `pageParseCache` re-parses all 15 corpus pages with ts-morph before
  // the board can mount, which comfortably exceeds the 10s default. The admin
  // shell shows its "Could not load CMS site" state in the meantime — that is
  // the pre-studio CMS document, transient, and NOT a failure to assert on.
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 90_000 })
  await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 30_000 })
  return canvasRoot
}

test.describe('instance-ui-01: click selects the instance, Enter/Esc step in and out, call-site props edit, detach refuses', () => {
  // Four interaction phases against a 15-page corpus board, plus a possible
  // cold ts-morph parse on open — the 60s default covers none of that.
  test.setTimeout(240_000)

  test('the whole instance interaction model, driven by real mouse and real keys', async ({ page }) => {
    const projectDir = await findProjectDir(page, PROJECT_FOLDER_NAME)
    if (!projectDir) {
      test.skip(true, `studio-workspace/${PROJECT_FOLDER_NAME} is not present on disk for this run`)
      return
    }

    const canvasRoot = await openStudioBoard(page, projectDir)

    const targetFrame = page.locator(`[data-page-id="${TARGET_PAGE_ID}"]`)
    await expect(targetFrame, `expected one board frame for page id "${TARGET_PAGE_ID}"`).toHaveCount(1)
    await panIntoView(page, canvasRoot, targetFrame)

    const contentFrame: FrameLocator = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    // ── 1. Click a component → the INSTANCE is selected, and it RINGS ──────
    //
    // `BookingConfirmationScreen.jsx` renders `<Price value="69"
    // color="var(--text-base-default)" />` — a LOCAL component whose call site
    // carries two string LITERALS, so its call-site props are genuinely
    // writable (not `codeProps`-locked) and step 3 has something real to edit.
    // The click lands on the `<span class="price__value">` deep inside Price's
    // own expansion; selecting the instance instead of that span is the whole
    // claim.
    const priceValue = contentFrame.locator('.price__value', { hasText: '69' }).first()
    await panIntoView(page, canvasRoot, priceValue, 60)
    await clickInFrame(page, priceValue)

    // The Properties panel renders `InstanceCallSiteView` only for a
    // `studio.instance` node — its presence IS the assertion that the click
    // resolved to the instance and not to the clicked span.
    const detachButton = page.getByTestId('instance-detach-button')
    await expect(
      detachButton,
      'clicking a component did not select its studio.instance (no call-site view in the Properties panel)',
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('instance-source-badge')).toHaveText('Local')
    // Price's own call-site props, one control each.
    await expect(page.getByTestId('instance-call-site-prop-value')).toBeVisible()

    // The ring. A `studio.instance` renders no element of its own, so this
    // fails outright without `canvasNodeLookup`'s fragment-node rect fallback:
    // the node is selected, the panel is open, and the canvas shows nothing.
    const ring = contentFrame.locator('[data-canvas-selection-ring="true"]')
    await expect(
      ring,
      'the selected studio.instance drew no selection ring — a zero-DOM fragment node has no [data-node-id] element to measure',
    ).toBeVisible({ timeout: 10_000 })

    // The ring must actually cover the component, not collapse to a point at
    // the frame origin (which is what an unmeasurable node degrades to).
    const [ringBox, priceBox] = await Promise.all([ring.boundingBox(), priceValue.boundingBox()])
    expect(ringBox, 'selection ring has no bounding box').not.toBeNull()
    expect(priceBox, 'price value has no bounding box').not.toBeNull()
    expect(ringBox!.width, 'the instance ring collapsed to zero width').toBeGreaterThan(0)
    expect(ringBox!.height, 'the instance ring collapsed to zero height').toBeGreaterThan(0)
    // The instance's box is the union of its rendered descendants, so it must
    // CONTAIN the clicked descendant (with a px of tolerance for the ring's
    // own outline width and sub-pixel rounding).
    const TOL = 3
    expect(ringBox!.x, 'the instance ring does not enclose the element clicked').toBeLessThanOrEqual(priceBox!.x + TOL)
    expect(ringBox!.y, 'the instance ring does not enclose the element clicked').toBeLessThanOrEqual(priceBox!.y + TOL)
    expect(ringBox!.x + ringBox!.width).toBeGreaterThanOrEqual(priceBox!.x + priceBox!.width - TOL)
    expect(ringBox!.y + ringBox!.height).toBeGreaterThanOrEqual(priceBox!.y + priceBox!.height - TOL)

    // ── 2. Enter steps INTO the instance, Escape steps back OUT ────────────
    //
    // Real keystrokes. Focus is inside the canvas iframe at this point
    // (`focusNodeWithoutScrolling` focuses the clicked element on every node
    // click), which is precisely why `useInstanceEntryKeyboard` listens on the
    // parent `document` and `IframeFrameSurface` re-dispatches iframe keydowns
    // there — if that bridge is broken, this step is where it shows.
    // The ring's `data-canvas-overlay-node-id` is the node id the overlay is
    // tracking, so it doubles as a read of "what is selected" that does not
    // need the store — used below to prove Enter/Escape move the selection
    // ACROSS the instance boundary, not merely open and close a panel.
    const ringNodeIds = async (): Promise<(string | null)[]> =>
      contentFrame
        .locator('[data-canvas-selection-ring="true"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-canvas-overlay-node-id')))

    const instanceNodeId = (await ringNodeIds())[0]
    expect(instanceNodeId, 'the selection ring is not tracking any node id').toBeTruthy()
    // A `studio.instance` id is its CALL SITE (`<file>:<line>:<col>`) — the one
    // place an edit to these props may land.
    expect(instanceNodeId).toContain('BookingConfirmationScreen.jsx')

    await page.keyboard.press('Enter')
    await expect(
      detachButton,
      'Enter did not step INTO the instance — the panel still shows the instance call-site view',
    ).toBeHidden({ timeout: 10_000 })
    const insideNodeId = (await ringNodeIds())[0]
    // Entering selects a node from the COMPONENT'S OWN file, reached through
    // the call site — the `<call site>~<inner node>` id shape.
    expect(insideNodeId, 'Enter did not move the selection inside the instance').not.toBe(instanceNodeId)
    expect(insideNodeId).toContain('~')

    await page.keyboard.press('Escape')
    await expect(
      detachButton,
      'Escape did not step back OUT to the instance',
    ).toBeVisible({ timeout: 10_000 })
    expect(
      (await ringNodeIds())[0],
      'Escape re-opened the panel but the selection did not return to the instance itself',
    ).toBe(instanceNodeId)

    // ── 3. Edit a call-site prop ───────────────────────────────────────────
    //
    // `value="69"` is a string literal at THIS call site, so the control is
    // writable. The edit is instance-local by construction: it targets the one
    // call site this node's id decodes to, never Price's own declaration.
    //
    // NOTE, and this is a real limitation worth stating rather than hiding:
    // the canvas does NOT live-update from a call-site prop edit. The rendered
    // subtree was produced by the parser at load time with the old value
    // substituted in; the new text appears only after a save + re-parse. What
    // is asserted here is what the user can actually observe now — the control
    // takes the value and the document becomes dirty.
    const valueInput = page.getByTestId('instance-call-site-prop-value').locator('input').first()
    await expect(valueInput).toBeVisible()
    await expect(valueInput, 'the call-site control did not seed from the parsed literal').toHaveValue('69')
    await valueInput.fill('88')
    await valueInput.blur()
    await expect(valueInput, 'the call-site prop edit did not stick in the panel').toHaveValue('88')

    // ── 4. Detach, refusal-first ───────────────────────────────────────────
    //
    // `SheetHeader` calls `useLanguage()`, so `detachComponent` refuses with
    // `uses-hooks` — one of the 42 of 139 corpus instances that do. A refused
    // codemod writes nothing, which is why this is the component the spec is
    // allowed to press Detach on at all.
    const grabber = contentFrame.locator('.sheet-header__grabber').first()
    await panIntoView(page, canvasRoot, grabber, 60)
    await clickInFrame(page, grabber)
    await expect(
      page.getByTestId('instance-detach-button'),
      'clicking the sheet header did not select the SheetHeader instance',
    ).toBeVisible({ timeout: 10_000 })

    await page.getByTestId('instance-detach-button').click()

    const refusal = page.getByTestId('instance-detach-refusal')
    await expect(
      refusal,
      'detaching a hook-using component neither refused visibly nor explained why',
    ).toBeVisible({ timeout: 15_000 })
    // The refusal must be a REASON in the user's own terms, not a bare
    // "failed" — the parser writes human-readable text and the panel shows it.
    const refusalText = (await refusal.innerText()).trim()
    expect(refusalText.length, 'the detach refusal rendered with no explanation').toBeGreaterThan(20)
  })
})
