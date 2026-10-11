import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * CT-4 - modes on the board, in a real browser.
 *
 * The claim a unit test cannot make: two frames of ONE page, one light and one
 * dark, paint different computed colours, because each frame's `<html>` carries
 * the gate the project's own CSS tests for (`[data-theme='dark']`, `.compact`
 * - read from the token catalog), and switching a frame's chip flips only that
 * frame. The fixture's dark mode and its density axis are plain CSS custom
 * properties under attribute/class gates; nothing in the page source mentions
 * either.
 */

const TOKENS_CSS = `:root {
  --bg: #ffffff;
  --fg: #111111;
  --pad: 24px;
}

[data-theme='dark'] {
  --bg: #111111;
  --fg: #ffffff;
}

.compact {
  --pad: 4px;
}
`

const HOME_CSS = `.page {
  background: var(--bg);
  color: var(--fg);
  padding: var(--pad);
}
`

const HOME_TSX = `import './Home.css'

export default function Home() {
  return (
    <div className="page">
      <h1 className="title">Modes</h1>
    </div>
  )
}
`

const MAIN_TSX = `import './index.css'

export {}
`

const LIGHT_FG = 'rgb(17, 17, 17)'
const DARK_FG = 'rgb(255, 255, 255)'

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-board-modes', {
    'src/main.tsx': MAIN_TSX,
    'src/index.css': TOKENS_CSS,
    'pages/Home.css': HOME_CSS,
    'pages/Home.tsx': HOME_TSX,
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

const framesOfPage = (page: Page): Locator => page.locator('[data-frame-id]')

async function contentOf(page: Page, canvasRoot: Locator, frame: Locator): Promise<FrameLocator> {
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame), 'the frame never mounted a canvas iframe').toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  await expect(content.locator('h1').first()).toBeVisible({ timeout: 30_000 })
  return content
}

const fgOf = (content: FrameLocator): Promise<string> => content.locator('h1').first().evaluate((el) => getComputedStyle(el).color)
const padOf = (content: FrameLocator): Promise<string> => content.locator('.page').first().evaluate((el) => getComputedStyle(el).paddingTop)

/** A frame wider and taller than the viewport has its header chips off screen; bring the control itself to the middle before pressing it. */
async function reach(page: Page, canvasRoot: Locator, control: Locator): Promise<void> {
  await panIntoView(page, canvasRoot, control, 120)
}

async function pickMode(page: Page, canvasRoot: Locator, frame: Locator, axis: string, mode: string): Promise<void> {
  const chip = frame.locator(`[data-testid="board-frame-mode-chip"][data-axis="${axis}"]`)
  await reach(page, canvasRoot, chip)
  await chip.click()
  await page.locator(`[data-testid="board-frame-mode-option"][data-mode="${mode}"]`).click({ timeout: 20_000 })
}

test.describe('CT-4 - modes on the board', () => {
  test.setTimeout(240_000)

  test('+ Mode makes a dark twin; each frame paints its own mode; the chip flips it; it persists', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    await expect(framesOfPage(page)).toHaveCount(1)
    const original = framesOfPage(page).first()
    const originalContent = await contentOf(page, canvasRoot, original)

    // The catalog's two axes get a chip each, and the frame starts in the defaults.
    const schemeChip = original.locator('[data-testid="board-frame-mode-chip"][data-axis="color-scheme"]')
    await expect(schemeChip, 'no colour-scheme chip: the catalog never reached the frame header').toBeAttached({ timeout: 30_000 })
    await expect(schemeChip).toHaveText('Light')
    await expect(original.locator('[data-testid="board-frame-mode-chip"][data-axis="theme"]')).toHaveText('Default')
    expect(await fgOf(originalContent)).toBe(LIGHT_FG)

    // + Mode duplicates the frame into dark, beside the source.
    const addMode = original.getByTestId('board-frame-add-mode')
    await reach(page, canvasRoot, addMode)
    await addMode.click()
    await page.getByRole('menuitem', { name: 'Color scheme: Dark' }).click({ timeout: 20_000 })
    await expect(framesOfPage(page)).toHaveCount(2)

    const twin = framesOfPage(page).nth(1)
    const twinContent = await contentOf(page, canvasRoot, twin)
    await expect(twin.locator('[data-testid="board-frame-mode-chip"][data-axis="color-scheme"]')).toHaveText('Dark')
    await expect
      .poll(() => fgOf(twinContent), { message: 'the dark twin never painted the [data-theme=dark] tokens', timeout: 20_000 })
      .toBe(DARK_FG)

    // The source frame is untouched, so the two frames of one page now disagree.
    const sourceContent = await contentOf(page, canvasRoot, original)
    expect(await fgOf(sourceContent)).toBe(LIGHT_FG)

    // Switching the twin's chip flips that frame, and only that frame.
    await pickMode(page, canvasRoot, twin, 'color-scheme', 'light')
    await expect.poll(() => fgOf(twinContent), { timeout: 20_000 }).toBe(LIGHT_FG)
    await pickMode(page, canvasRoot, twin, 'color-scheme', 'dark')
    await expect.poll(() => fgOf(twinContent), { timeout: 20_000 }).toBe(DARK_FG)
    expect(await fgOf(sourceContent)).toBe(LIGHT_FG)

    // A second axis comes from the project's `.compact` class gate, per frame.
    expect(await padOf(sourceContent)).toBe('24px')
    await pickMode(page, canvasRoot, original, 'theme', 'compact')
    await expect.poll(() => padOf(sourceContent), { message: 'the .compact class gate never reached the frame', timeout: 20_000 }).toBe('4px')
    expect(await padOf(twinContent)).toBe('24px')

    // Both frames' modes are in boards.json.
    const boardsFile = path.join(fixture.dir, '.studio', 'boards.json')
    await expect
      .poll(
        () => {
          if (!fs.existsSync(boardsFile)) return null
          const frames = (JSON.parse(fs.readFileSync(boardsFile, 'utf8')) as { boards: Array<{ frames: Array<{ axes?: unknown }> }> }).boards[0]?.frames ?? []
          return frames.map((frame) => frame.axes ?? null)
        },
        { message: 'the frames modes never reached .studio/boards.json', timeout: 30_000 },
      )
      .toEqual([{ modes: { theme: 'compact' } }, { colorScheme: 'dark' }])
  })
})
