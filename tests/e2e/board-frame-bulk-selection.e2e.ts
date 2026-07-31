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
 *
 * SAFETY — this spec runs against REAL USER DATA (`studio-workspace/`) and
 * mutates nothing: it only selects, deselects, and types into a rename field
 * it never submits.
 *
 * `board-03` — WHY EVERY COORDINATE IS MEASURED, NOT DERIVED. The committed
 * version of this spec hard-coded the board's shape: it zoomed out "until a
 * frame is under 260px wide" as a stand-in for zoom level (true only while
 * every frame is the default 1024 board units wide), then centred two frames
 * named by page id and dragged from `frameA.x - 20`. The user then dogfooded
 * the board — resized every frame to 393 and dragged one screen 758 units off
 * to the left — and both premises died at once: the zoom loop exited on the
 * first check without zooming at all, the two named frames no longer fit on
 * screen together, and the drag's start point landed on the Explorer panel,
 * 125px outside the canvas. Nothing was ever pressed on the canvas, so nothing
 * was ever selected, and it read exactly like a product regression. It was not:
 * two agents burned time proving it wasn't theirs.
 *
 * `board.frames` is a user-editable document. So this spec derives its whole
 * gesture from what is actually rendered: it zooms out until enough frames
 * FIT, scans for a drag origin that hit-tests to the canvas root, and computes
 * which frames a rect crosses from their measured boxes. The assertions are
 * unchanged in kind — live mid-drag selection, exactly the crossed frames,
 * persistence on release — they are just no longer expressed in coordinates
 * only one particular boards.json produces.
 */

const PROJECT_FOLDER_NAME = 'maherfayad-stack-eSIM'
const FRAMES_LAYER = '[data-testid="board-frames-layer"]'
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control'

interface StudioProjectSummary {
  dir: string
  name: string
}

/** A rectangle in viewport (page) coordinates. */
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A board frame's rendered box, in viewport coordinates. */
interface FrameBox extends Rect {
  pageId: string
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
 * Every board frame's rendered box. Every frame on the board has one
 * regardless of virtualization — `BoardFramesLayer` only swaps a frame's BODY
 * for a poster when it scrolls offscreen, the `.frame` box stays mounted — so
 * this is also the honest answer to "which frames are on this board".
 */
async function readFrameBoxes(page: Page): Promise<FrameBox[]> {
  return page.locator(`${FRAMES_LAYER} [data-page-id]`).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return {
        pageId: el.getAttribute('data-page-id') ?? '<missing>',
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }
    }),
  )
}

/** Reads which board frames currently carry the `data-selected="true"` selection ring. */
async function selectedFramePageIds(page: Page): Promise<string[]> {
  return page.locator(`${FRAMES_LAYER} [data-selected="true"]`).evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-page-id') ?? '<missing>'),
  )
}

/**
 * Wait until the editor shell has stopped moving. Selecting anything auto-opens
 * the docked Properties panel, which animates the canvas viewport's width — so
 * a point scanned during that animation is stale by the time a click lands
 * (`select-01`'s landmine). Two identical consecutive samples of the canvas
 * root's box is the cheapest honest "settled" signal.
 */
async function waitForCanvasLayoutToSettle(page: Page, canvasRoot: Locator): Promise<void> {
  let previous = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = JSON.stringify(await canvasRoot.boundingBox())
    if (current === previous) return
    previous = current
    await page.waitForTimeout(100)
  }
}

/** Strict intersection — the same rule `framesInMarquee` applies, touching edges excluded. */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

/**
 * Which frames a marquee rect crosses — plus whether any frame is close enough
 * to an edge that a pixel of rounding could flip the answer. The caller only
 * ever asserts against an UNAMBIGUOUS rect, so a sub-pixel disagreement between
 * this spec's arithmetic and the browser's can never be mistaken for a bug in
 * the feature.
 */
function framesCrossedBy(rect: Rect, boxes: readonly FrameBox[], slackPx = 6): {
  hits: string[]
  ambiguous: string[]
} {
  const grown = inflate(rect, slackPx)
  const shrunk = inflate(rect, -slackPx)
  const hits: string[] = []
  const ambiguous: string[] = []
  for (const box of boxes) {
    if (intersects(rect, box)) hits.push(box.pageId)
    if (intersects(grown, box) !== intersects(shrunk, box)) ambiguous.push(box.pageId)
  }
  return { hits, ambiguous }
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/**
 * Ctrl+wheel zoom-out (a real pinch/trackpad-zoom gesture, centred on the
 * canvas — `useCanvas.ts`'s `handleWheel` treats ctrl/meta+wheel as zoom) until
 * at least `minFrames` frames are entirely inside the canvas viewport. Framed
 * as "do enough frames FIT" rather than "is a frame under N pixels wide"
 * because frame size is user data (see this file's header).
 */
async function zoomOutUntilFramesFit(
  page: Page,
  canvasRoot: Locator,
  minFrames: number,
): Promise<{ root: Rect; boxes: FrameBox[] }> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const root = await canvasRoot.boundingBox()
    if (!root) throw new Error('zoomOutUntilFramesFit: the canvas root has no bounding box')
    const boxes = await readFrameBoxes(page)
    const inside = boxes.filter((b) => contains(inflate(root, -8), b))
    if (inside.length >= minFrames) return { root, boxes }

    await page.mouse.move(root.x + root.width / 2, root.y + root.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 220)
    await page.keyboard.up('Control')
    await page.waitForTimeout(120)
  }
  throw new Error(
    `zoomOutUntilFramesFit: fewer than ${minFrames} frames fit in the canvas viewport after 12 zoom-out steps`,
  )
}

/**
 * A point inside the canvas that hit-tests to the canvas root itself — genuine
 * empty board background, the only place a marquee arms
 * (`useMarqueeSelection`'s `e.target !== canvasRootEl` guard). Scanned, never
 * guessed: `.layer`/`.transformLayer` are 0×0 in studio board mode, frames move
 * with every pan, and the canvas is overlaid with real chrome (the insert
 * notch, the mode toggle, the sticky-note toolbar) that would swallow a
 * pointerdown. `preferCorner` biases the scan toward one corner so the caller
 * can drag a rect ACROSS the board from it.
 */
async function findBackgroundPoint(
  page: Page,
  preferCorner: 'top-left' | 'bottom-right',
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((corner: 'top-left' | 'bottom-right') => {
    const root = document.querySelector('[data-studio-canvas-root="true"]')
    if (!(root instanceof HTMLElement)) return null
    const rect = root.getBoundingClientRect()
    const STEP = 12
    let best: { x: number; y: number; score: number } | null = null
    for (let x = rect.left + STEP; x < rect.right - STEP; x += STEP) {
      for (let y = rect.top + STEP; y < rect.bottom - STEP; y += STEP) {
        if (document.elementFromPoint(x, y) !== root) continue
        const dx = corner === 'top-left' ? x - rect.left : rect.right - x
        const dy = corner === 'top-left' ? y - rect.top : rect.bottom - y
        const score = dx + dy
        if (!best || score < best.score) best = { x, y, score }
      }
    }
    return best ? { x: best.x, y: best.y } : null
  }, preferCorner)
  if (!point) throw new Error(`findBackgroundPoint: no empty canvas background found near ${preferCorner}`)
  return point
}

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

    // Let the canvas's own "center on open" pass settle before we drive
    // pan/zoom ourselves (same reasoning as frame-fit-height.e2e.ts).
    await expect(page.locator('iframe[title^="Canvas frame"]').first()).toBeVisible({ timeout: 20_000 })
    await waitForCanvasLayoutToSettle(page, canvasRoot)

    // ─── Plan the drag from what is actually on screen ───────────────────────
    const { root, boxes } = await zoomOutUntilFramesFit(page, canvasRoot, 3)
    expect(boxes.length, 'the eSIM board should have frames on it').toBeGreaterThan(2)

    const start = await findBackgroundPoint(page, 'top-left')
    // The far corner of the canvas, pulled in far enough that no frame edge
    // grazes the marquee boundary (which would make "did it cross?" a
    // rounding question rather than a behavioural one).
    const endCandidates = [8, 24, 44, 70].map((inset) => ({
      x: root.x + root.width - inset,
      y: root.y + root.height - inset,
    }))
    const end = endCandidates.find((candidate) => {
      const { hits, ambiguous } = framesCrossedBy(rectFromPoints(start, candidate), boxes)
      return ambiguous.length === 0 && hits.length >= 2
    })
    if (!end) {
      throw new Error(
        'no unambiguous marquee rect crosses 2+ frames from the scanned background origin — the board is laid out too densely for this spec to plan a drag',
      )
    }
    const fullExpected = framesCrossedBy(rectFromPoints(start, end), boxes).hits

    // A point PART WAY along the same drag whose rect crosses a strict,
    // non-empty subset — this is what makes the mid-drag assertion below a
    // claim about the LIVE rect rather than about the end state.
    let mid: { x: number; y: number } | null = null
    let midExpected: string[] = []
    for (let t = 0.15; t <= 0.9; t += 0.05) {
      const candidate = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
      const { hits, ambiguous } = framesCrossedBy(rectFromPoints(start, candidate), boxes)
      if (ambiguous.length > 0) continue
      if (hits.length >= 1 && hits.length < fullExpected.length) {
        mid = candidate
        midExpected = hits
        break
      }
    }
    if (!mid) {
      throw new Error(
        'no point part-way through the drag crosses a strict subset of the frames — cannot distinguish a live marquee from an on-release one',
      )
    }

    // ─── The gesture: real mouse, no store calls ─────────────────────────────
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(mid.x, mid.y, { steps: 6 })

    // LIVE update — while the button is still down and the rect has only
    // reached part of the board, exactly those frames must already be
    // selected, and the ones the rect has not reached yet must not be.
    await expect
      .poll(() => selectedFramePageIds(page).then((ids) => [...ids].sort()), {
        message: `marquee did not select ${midExpected.join(', ')} live, mid-drag, before mouseup`,
      })
      .toEqual([...midExpected].sort())

    await page.mouse.move(end.x, end.y, { steps: 10 })
    await expect
      .poll(() => selectedFramePageIds(page).then((ids) => [...ids].sort()), {
        message: 'marquee did not select every frame its rect crossed, before mouseup',
      })
      .toEqual([...fullExpected].sort())

    await page.mouse.up()
    const afterRelease = await selectedFramePageIds(page)
    expect(
      new Set(afterRelease),
      'the marquee selection changed on mouseup instead of persisting what was already live-selected',
    ).toEqual(new Set(fullExpected))

    // The user's own read of "is it selected": a painted ring, not store state.
    const ring = await page
      .locator(`${FRAMES_LAYER} [data-page-id="${fullExpected[0]}"]`)
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return { style: style.outlineStyle, width: style.outlineWidth }
      })
    expect(ring, 'a marquee-selected frame does not render a visible selection ring').toEqual({
      style: 'solid',
      width: '2px',
    })

    // ─── Escape clears the frame selection (must keep working) ───────────────
    // Explicit `.focus()` before the key press — this repo's own established
    // pattern (`visual-builder.e2e.ts`'s BUILDER-005 test) for driving canvas
    // keyboard shortcuts reliably from Playwright.
    await canvasRoot.focus()
    await page.keyboard.press('Escape')
    await expect.poll(() => selectedFramePageIds(page)).toEqual([])

    // ─── A marquee that crosses nothing ends at nothing selected ─────────────
    await waitForCanvasLayoutToSettle(page, canvasRoot)
    const emptyBoxes = await readFrameBoxes(page)
    const emptyOrigin = await findBackgroundPoint(page, 'bottom-right')
    const emptyTarget = [24, 40, 60]
      .map((d) => ({ x: emptyOrigin.x - d, y: emptyOrigin.y - d }))
      .find((candidate) => framesCrossedBy(rectFromPoints(emptyOrigin, candidate), emptyBoxes).hits.length === 0)
    if (emptyTarget) {
      await page.mouse.move(emptyOrigin.x, emptyOrigin.y)
      await page.mouse.down()
      await page.mouse.move(emptyTarget.x, emptyTarget.y, { steps: 4 })
      await page.mouse.up()
      await expect
        .poll(() => selectedFramePageIds(page), {
          message: 'a marquee drag that crossed no frame still ended with frames selected',
        })
        .toEqual([])
    }

    // ─── Header click (replace) + Shift-click (toggle-add) ───────────────────
    // The other two documented selection entry points, still real pointer
    // input. The two targets are chosen from the frames currently on screen —
    // and from the LEFT of the canvas, because the first click auto-opens the
    // docked inspector, which eats the right-hand side of the viewport.
    await waitForCanvasLayoutToSettle(page, canvasRoot)
    const clickable = (await readFrameBoxes(page))
      .filter((b) => contains(inflate(root, -8), b))
      .sort((a, b) => a.x + a.width - (b.x + b.width))
    expect(clickable.length, 'need two on-screen frames to exercise header click + shift-click').toBeGreaterThan(1)
    const [headerA, headerB] = clickable

    const headerOf = (pageId: string) =>
      page.locator(`${FRAMES_LAYER} [data-page-id="${pageId}"] [data-testid="board-frame-header"]`)

    await headerOf(headerA.pageId).click()
    await expect.poll(() => selectedFramePageIds(page)).toEqual([headerA.pageId])
    await waitForCanvasLayoutToSettle(page, canvasRoot)

    await page.keyboard.down('Shift')
    await headerOf(headerB.pageId).click()
    await page.keyboard.up('Shift')
    await expect
      .poll(() => selectedFramePageIds(page).then((ids) => new Set(ids).size), {
        message: 'shift-clicking a second frame header replaced the selection instead of extending it',
      })
      .toBe(2)
    const afterShiftClick = await selectedFramePageIds(page)
    expect(new Set(afterShiftClick)).toEqual(new Set([headerA.pageId, headerB.pageId]))

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
    ).toEqual(new Set([headerA.pageId, headerB.pageId]))

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

    // "Every frame on the board" read from the board itself, not from a
    // hard-coded id list — `board.frames` is a document the user edits.
    const allBoardFrameIds = (await readFrameBoxes(page)).map((b) => b.pageId)
    expect(allBoardFrameIds.length).toBeGreaterThan(2)
    await expect
      .poll(() => selectedFramePageIds(page).then((ids) => ids.length), {
        message:
          'Ctrl/Cmd+A with focus on a non-editable panel control did not select every frame on the board',
      })
      .toBe(allBoardFrameIds.length)
    const allSelected = await selectedFramePageIds(page)
    expect(new Set(allSelected)).toEqual(new Set(allBoardFrameIds))
  })
})
