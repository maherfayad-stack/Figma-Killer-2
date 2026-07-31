import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for `board-02`: `board-01` (WS-7.1) shipped
 * `selectedFrameIds`, `framesInMarquee`, `FrameBulkInspector`, and the
 * `board.selectAllFrames` keybinding — all unit-tested against the store
 * directly, none of it reachable from real input. Dogfooding found three
 * concrete breaks:
 *   - "no bulk selection in the canvas"
 *   - "ctrl A selects text in the canvas panels not in the canvas itself"
 *   - "click and drag don't select multiple"
 *
 * This spec drives the actual DOM with `page.mouse`/`page.keyboard` — no
 * store calls — so a future regression that only breaks the wiring (not the
 * store logic `bulkFrameSize.test.ts` already covers) fails here.
 */

const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'

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

/**
 * Ctrl+wheel zoom-out (real pinch/trackpad-zoom gesture, centered on the
 * canvas — `useCanvas.ts`'s `handleWheel` treats ctrl/meta+wheel as zoom) in
 * a loop until `target`'s rendered width is small enough that two
 * side-by-side board frames fit in the viewport together. Every board
 * frame's board-space width is the fixed `FRAME_WIDTH` (1024) unless
 * manually resized, so rendered width is a direct, real proxy for effective
 * zoom — no store reads needed.
 */
async function zoomOutUntilNarrow(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  maxWidthPx = 260,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const box = await target.boundingBox()
    if (box && box.width <= maxWidthPx) return
    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('zoomOutUntilNarrow: the canvas root has no bounding box')
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 200)
    await page.keyboard.up('Control')
    await page.waitForTimeout(80)
  }
  throw new Error('zoomOutUntilNarrow: target never shrank below the target width after 10 zoom-out steps')
}

/**
 * Pans the board (native wheel — same mechanism `frame-fit-height.e2e.ts`'s
 * `panIntoView` uses) until every locator in `targets`' TOP-band midpoint
 * (`x + width/2`, `y + 30`) sits centered in the canvas viewport, within
 * `tolerancePx`. Deliberately NOT the full bounding box: board frames in
 * this corpus are auto-height (canvas-04) and can be thousands of board
 * units tall — only the header/top band (well inside the fixed
 * `FRAME_HEIGHT` `framesInMarquee` actually hit-tests against, see
 * `framesInMarquee.ts`'s module doc: intersection against the NOMINAL rect,
 * not the visually auto-grown one) needs to be on screen for this test.
 */
async function centerFrameTopsInView(
  page: Page,
  canvasRoot: Locator,
  targets: Locator[],
  tolerancePx = 80,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rootBox = await canvasRoot.boundingBox()
    if (!rootBox) throw new Error('centerFrameTopsInView: the canvas root has no bounding box')
    const boxes = await Promise.all(targets.map((t) => t.boundingBox()))
    if (boxes.some((b) => !b)) {
      throw new Error('centerFrameTopsInView: one of the target frames has no bounding box')
    }
    const minX = Math.min(...boxes.map((b) => b!.x))
    const maxX = Math.max(...boxes.map((b) => b!.x + b!.width))
    const topY = boxes.reduce((sum, b) => sum + b!.y, 0) / boxes.length
    const centerX = (minX + maxX) / 2
    const centerY = topY + 30
    const rootCenterX = rootBox.x + rootBox.width / 2
    const rootCenterY = rootBox.y + rootBox.height / 2
    const dx = centerX - rootCenterX
    const dy = centerY - rootCenterY

    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('centerFrameTopsInView: targets never reached the viewport center after 10 pan attempts')
}

/** Reads which board frames currently carry the `data-selected="true"` selection ring. */
async function selectedFramePageIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="board-frames-layer"] [data-selected="true"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-page-id') ?? '<missing>'),
  )
}

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control'

test.describe('board-02: bulk frame selection reachable from real input', () => {
  test('marquee drag selects live and on release, Escape clears, header shift-click extends, Ctrl/Cmd+A works from a panel but not while typing', async ({
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

    const frameA = page.locator('[data-page-id="booking-confirmation-screen"]')
    const frameB = page.locator('[data-page-id="booking-details-screen"]')
    await expect(frameA).toHaveCount(1)
    await expect(frameB).toHaveCount(1)

    // Let the canvas's own "center on open" pass settle before we drive
    // pan/zoom ourselves (same reasoning as frame-fit-height.e2e.ts).
    await expect(page.locator('iframe[title^="Canvas frame"]').first()).toBeVisible({ timeout: 20_000 })

    // Zoom out (real ctrl+wheel gesture) so both frameA and frameB (same
    // row, ~1104 board units of gap) fit on screen together, then pan their
    // top/header band into view.
    await zoomOutUntilNarrow(page, canvasRoot, frameA)
    await centerFrameTopsInView(page, canvasRoot, [frameA, frameB])

    const boxA = await frameA.boundingBox()
    const boxB = await frameB.boundingBox()
    if (!boxA || !boxB) throw new Error('frameA/frameB lost their bounding box after centering')

    // Drag from clearly outside/above-left of frameA's top edge to just
    // past frameB's top edge — both start and end points are empty canvas.
    // Only needs to cross each frame's TOP edge (intersection test, not
    // containment — see `centerFrameTopsInView`'s doc), so this works
    // regardless of how tall the frames visually render.
    const margin = 20
    const start = { x: boxA.x - margin, y: boxA.y - margin }
    const midOverA = { x: boxA.x + boxA.width / 2, y: boxA.y + 30 }
    const end = { x: boxB.x + boxB.width + margin, y: boxB.y + 30 }

    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(midOverA.x, midOverA.y, { steps: 5 })

    // LIVE update — while the button is still down and the drag has only
    // reached frameA, frameA must already be selected (this is the "live,
    // not only on release" requirement) and frameB must not be yet.
    await expect
      .poll(() => selectedFramePageIds(page), {
        message: 'marquee did not select frameA live, mid-drag, before mouseup',
      })
      .toContain('booking-confirmation-screen')
    const midDragSelection = await selectedFramePageIds(page)
    expect(
      midDragSelection,
      'marquee selected frameB before the drag rect ever reached it — the live update is not tracking the actual rect',
    ).not.toContain('booking-details-screen')

    await page.mouse.move(end.x, end.y, { steps: 8 })
    await expect
      .poll(() => selectedFramePageIds(page), {
        message: 'marquee did not select both frames once the rect enclosed both, before mouseup',
      })
      .toEqual(expect.arrayContaining(['booking-confirmation-screen', 'booking-details-screen']))

    await page.mouse.up()
    const afterRelease = await selectedFramePageIds(page)
    expect(
      new Set(afterRelease),
      'the marquee selection changed on mouseup instead of persisting what was already live-selected',
    ).toEqual(new Set(['booking-confirmation-screen', 'booking-details-screen']))

    // Escape clears the frame selection (must keep working). Explicit
    // `.focus()` before the key press — this repo's own established pattern
    // (`visual-builder.e2e.ts`'s BUILDER-005 test) for driving canvas
    // keyboard shortcuts reliably from Playwright; a synthetic mouse click's
    // default focus-follows-mousedown isn't a reliable enough signal for
    // `page.keyboard.press` to route to in this environment.
    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Escape')
    await expect.poll(() => selectedFramePageIds(page)).toEqual([])

    // Header click (replace) + Shift-click (toggle-add) — the other two
    // documented selection entry points, still real pointer input. Click
    // the frame's title text — it lives directly inside the header/drag-
    // handle div (`BoardFrameView`'s `.header`), so a click there always
    // lands in the header regardless of the header's actual CSS-rendered
    // height (its `FRAME_HEADER_HEIGHT` constant is a geometric hit-test
    // abstraction for the marquee/virtualization math, NOT its real content-
    // driven CSS height — computing a manual pixel offset from that was
    // unreliable at this zoom level; letting Playwright center-click the
    // real title element is not).
    await frameA.getByText('BookingConfirmationScreen', { exact: true }).click()
    await expect.poll(() => selectedFramePageIds(page)).toEqual(['booking-confirmation-screen'])

    await page.keyboard.down('Shift')
    await frameB.getByText('BookingDetailsScreen', { exact: true }).click()
    await page.keyboard.up('Shift')
    const afterShiftClick = await selectedFramePageIds(page)
    expect(new Set(afterShiftClick)).toEqual(
      new Set(['booking-confirmation-screen', 'booking-details-screen']),
    )

    // ─── Ctrl/Cmd+A from a panel, and NOT while typing ──────────────────────
    // FrameBulkInspector is now showing (2 frames selected).
    const inspector = page.getByTestId('frame-bulk-inspector')
    await expect(inspector).toBeVisible()

    // 1) Typing in a panel input: Ctrl/Cmd+A must select the FIELD'S text,
    //    not hijack frame selection. The rename-pattern input is a real
    //    `<input>` (FrameBulkInspector.tsx's batch-rename field).
    const renameInput = page.getByLabel('Rename pattern — use {n} for the position number')
    await renameInput.click()
    await renameInput.fill('')
    await page.keyboard.type('Hello')
    await page.keyboard.press(`${MOD_KEY}+a`)
    const nativeSelection = await renameInput.evaluate((el: HTMLInputElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      value: el.value,
    }))
    expect(
      nativeSelection,
      'Ctrl/Cmd+A while typing in a panel input must select the FIELD text (native browser behavior), not be intercepted',
    ).toEqual({ start: 0, end: 5, value: 'Hello' })
    const selectionDuringTyping = await selectedFramePageIds(page)
    expect(
      new Set(selectionDuringTyping),
      'Ctrl/Cmd+A while typing in a panel input must not change the frame selection',
    ).toEqual(new Set(['booking-confirmation-screen', 'booking-details-screen']))

    // 2) Focus a NON-editable panel control and press Ctrl/Cmd+A: this must
    //    select every frame on the board, proving the shortcut is scoped by
    //    editable-target, not by DOM focus living inside the canvas subtree.
    //    A real `<button>` (the "Align left" icon button) — not the device-
    //    preset control, which turns out to be backed by a `readOnly
    //    <input role="combobox">` (`Select.tsx`'s trigger element), so
    //    `isTextInputTarget`'s tag-based check correctly treats IT as an
    //    editable field too, same as any other `<input>`. `.focus()` alone
    //    (no click) has no side effect on a disabled-until-2-frames button.
    const alignLeftButton = page.getByRole('button', { name: 'Align left' })
    await alignLeftButton.focus()
    await expect(alignLeftButton).toBeFocused()
    await page.keyboard.press(`${MOD_KEY}+a`)

    const allBoardFrameIds = [
      'booking-confirmation-screen',
      'booking-details-screen',
      'homepage-screen',
      'esim-activate-intro-screen',
      'esim-activate-settings-screen',
      'esim-activation-flow-screen',
      'esim-device-picker-sheet',
      'esim-esim-data-screen',
      'esim-esim-success-screen',
      'esim-manual-entry-screen',
      'esim-onboarding-carousel-screen',
      'esim-qr-code-screen',
      'esim-select-package-sheet',
      'esim-static-screenshot-screen',
      'esim-topup-flow-screen',
    ]
    await expect
      .poll(() => selectedFramePageIds(page).then((ids) => ids.length), {
        message:
          'Ctrl/Cmd+A with focus on a non-editable panel control (device preset select) did not select every frame on the board',
      })
      .toBe(allBoardFrameIds.length)
    const allSelected = await selectedFramePageIds(page)
    expect(new Set(allSelected)).toEqual(new Set(allBoardFrameIds))
  })
})
