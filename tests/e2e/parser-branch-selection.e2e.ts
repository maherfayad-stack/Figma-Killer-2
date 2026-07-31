import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Real-browser coverage for parser-06: a multi-return/ternary/`&&` JSX branch
 * used to render EVERY branch, stacked. On `studio-workspace/maherfayad-stack-
 * eSIM`'s `homepage-screen`, the "2 eSIMs for your trip to London to install"
 * card (`EsimStatusBanner`, a multi-stage component) rendered THREE times in
 * three different visual states, stacked in a column — exactly what the user
 * reported as "a lot of screens ... didn't render well". `studio_fidelity_report`
 * confirmed it structurally (176 `MULTI_BRANCH_ALL_RENDERED` findings board-
 * wide, 0 after the fix — see `STATE.md`'s `parser-06` entry) and
 * `loadStudioPages` confirmed the card now parses to exactly one node — this
 * test is the third leg: confirming the SAME thing is true of what actually
 * paints inside the canvas iframe, which `bun test`'s happy-dom cannot see
 * (no layout engine, and more importantly here, no real DOM to count text
 * nodes in the way a person scrolling the board would).
 */

const HOMEPAGE_ID = 'homepage-screen'
const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

interface StudioProjectSummary {
  dir: string
  name: string
}

/**
 * Finds the on-disk `maherfayad-stack-eSIM` project the same way the Overview
 * launcher does (`GET /admin/api/studio/projects`) — matched by trailing
 * folder name so this works regardless of `/` vs `\` path separators on
 * Windows, same pattern as `frame-fit-height.e2e.ts`'s
 * `findEsimJourneyProjectDir`.
 */
async function findEsimStackProjectDir(page: Page): Promise<string | null> {
  const res = await page.request.get('/admin/api/studio/projects')
  if (!res.ok()) return null
  const body = (await res.json()) as { projects?: StudioProjectSummary[] }
  const projects = body.projects ?? []
  const match = projects.find((p) => p.dir.replace(/\\/g, '/').split('/').pop() === 'maherfayad-stack-eSIM')
  return match?.dir ?? null
}

/**
 * Pans the studio board (native wheel = pan) until `target`'s screen-space
 * center sits within `tolerancePx` of the canvas viewport's own center — same
 * mechanism and same rationale as `frame-fit-height.e2e.ts`'s `panIntoView`
 * (every board frame's outer `.frame` div stays mounted at its true screen
 * position at all times, so `target.boundingBox()` is trustworthy before the
 * frame's own iframe has mounted).
 */
async function panIntoView(page: Page, canvasRoot: Locator, target: Locator, tolerancePx = 40): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) {
      throw new Error(`panIntoView: target frame [data-page-id="${HOMEPAGE_ID}"] has no bounding box`)
    }

    const dx = targetBox.x + targetBox.width / 2 - (rootBox.x + rootBox.width / 2)
    const dy = targetBox.y + targetBox.height / 2 - (rootBox.y + rootBox.height / 2)
    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target frame never reached the viewport center after 8 pan attempts')
}

test.describe('parser-06 regression: homepage-screen does not stack a multi-stage card', () => {
  test('the "2 eSIMs for your trip" card renders exactly once, not three times', async ({ page }) => {
    const projectDir = await findEsimStackProjectDir(page)
    if (!projectDir) {
      test.skip(true, 'studio-workspace/maherfayad-stack-eSIM is not present on disk for this run')
      return
    }

    await page.addInitScript((dir: string) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
    }, projectDir)

    await page.goto('/admin/site?studio')
    await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('board-frames-layer')).toBeAttached()

    const targetFrame = page.locator(`[data-page-id="${HOMEPAGE_ID}"]`)
    await expect(
      targetFrame,
      `expected exactly one board frame for page id "${HOMEPAGE_ID}" — check ` +
        'studio-workspace/maherfayad-stack-eSIM/.studio/boards.json still curates it onto a board',
    ).toHaveCount(1)

    // Let the canvas's own "center on open" pass finish before panning
    // ourselves — any live frame appearing is proof it has run at least once.
    await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })

    const canvasRoot = page.getByTestId('canvas-root')
    await panIntoView(page, canvasRoot, targetFrame)

    const iframeEl = targetFrame.locator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(
      iframeEl,
      'the homepage-screen frame never mounted a live iframe after being panned into view',
    ).toBeVisible({ timeout: 15_000 })

    const contentFrame = targetFrame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    // THE REGRESSION THIS CATCHES: before parser-06, `EsimStatusBanner`'s
    // three `return`s (loading / empty / loaded) each rendered, locked,
    // stacked in a column under the same call site — so this exact text
    // painted three times on the live canvas. `getByText` with `exact` would
    // throw "strict mode violation" itself if more than one matched; the
    // explicit `toHaveCount(1)` makes that failure mode legible instead of a
    // cryptic Playwright strict-mode error.
    const card = contentFrame.getByText('2 eSIMs for your trip to London to install', { exact: true })
    await expect(
      card,
      'expected exactly one "2 eSIMs for your trip to London to install" card — ' +
        'if this finds more than one, parser-06 has regressed and the ' +
        'multi-stage EsimStatusBanner is stacking its branches again',
    ).toHaveCount(1)
    await expect(card).toBeVisible()
  })
})
