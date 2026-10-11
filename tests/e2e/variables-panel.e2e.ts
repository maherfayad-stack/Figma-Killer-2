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
 * CT-3 - the Variables panel, in a real browser against real files.
 *
 * Three claims a unit test cannot make:
 *
 *   1. **Typing previews, committing writes once.** Typing a new value for
 *      `--color-brand` repaints the canvas frame (computed style) while the
 *      stylesheet on disk is still byte-identical; Enter writes it - one
 *      declaration changed, every other byte kept.
 *   2. **One undo puts it back.** The panel's Undo restores the file byte for
 *      byte and the canvas shows the old colour again.
 *   3. **Rename touches every use in one step.** A rename rewrites the
 *      declaration in `src/index.css` AND the `var()` read in `Home.css`, and the
 *      canvas colour does not change (nothing was dangling); Undo restores
 *      both files.
 *
 * The fixture lives in this run's throwaway workspace copy
 * (`createAuthoredFixtureProject`), so writing is safe.
 */

const TOKENS_CSS = `:root {
  --color-brand: #0c9ab0;
  --space-md: 16px;
}

[data-theme='dark'] {
  --color-brand: #5fd3e4;
}
`

const HOME_CSS = `.hero-title {
  color: var(--color-brand);
  margin: var(--space-md);
}
`

const HOME_TSX = `import './Home.css'

export default function Home() {
  return (
    <div>
      <h1 className="hero-title">Variables</h1>
    </div>
  )
}
`

const MAIN_TSX = `import './index.css'

export {}
`

const ORIGINAL_COLOR = 'rgb(12, 154, 176)'
const EDITED_COLOR = 'rgb(255, 0, 0)'

const TOKENS_FILE = 'src/index.css'
const HOME_FILE = 'pages/Home.css'

let fixture: FixtureProject

/** Workspace-relative read: the tokens live in the app's global stylesheet, the use in a screen's. */
const read = (rel: string): string => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-variables-panel', {
    // The token layer is the global stylesheet the app's entry module imports.
    'src/main.tsx': MAIN_TSX,
    'src/index.css': TOKENS_CSS,
    'pages/Home.css': HOME_CSS,
    'pages/Home.tsx': HOME_TSX,
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openVariables(page: Page): Promise<{ title: Locator; contentFrame: FrameLocator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame), 'the fixture frame never mounted a canvas iframe').toBeVisible({ timeout: 60_000 })
  const contentFrame = canvasContentFrame(frame)
  const title = contentFrame.locator('.hero-title').first()
  await expect(title).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('panel-rail-variables').click()
  await expect(page.getByTestId('variables-panel')).toBeVisible()
  await expect(page.getByLabel('--color-brand Default')).toBeVisible({ timeout: 30_000 })
  return { title, contentFrame }
}

const colorOf = (title: Locator): Promise<string> => title.evaluate((el) => getComputedStyle(el).color)

test.describe('CT-3 - Variables panel', () => {
  test.setTimeout(180_000)

  test('typing previews on the canvas, Enter writes one declaration, Undo restores the file', async ({ page }) => {
    const { title } = await openVariables(page)
    expect(await colorOf(title)).toBe(ORIGINAL_COLOR)

    const field = page.getByLabel('--color-brand Default')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.fill('#ff0000')

    // Preview: the frame repaints, the file has not moved.
    await expect.poll(() => colorOf(title), { message: 'typing a token value never repainted the canvas', timeout: 15_000 }).toBe(EDITED_COLOR)
    expect(read(TOKENS_FILE)).toBe(TOKENS_CSS)

    await field.press('Enter')
    await expect
      .poll(() => read(TOKENS_FILE), { message: 'the committed token value never reached src/index.css', timeout: 30_000 })
      .toBe(TOKENS_CSS.replace('--color-brand: #0c9ab0', '--color-brand: #ff0000'))
    expect(read(HOME_FILE)).toBe(HOME_CSS)
    await expect.poll(() => colorOf(title), { timeout: 15_000 }).toBe(EDITED_COLOR)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => read(TOKENS_FILE), { message: 'Undo did not restore src/index.css byte for byte', timeout: 30_000 }).toBe(TOKENS_CSS)
    await expect.poll(() => colorOf(title), { timeout: 15_000 }).toBe(ORIGINAL_COLOR)
  })

  test('rename rewrites the declaration and every var() in one step, and Undo puts both files back', async ({ page }) => {
    const { title } = await openVariables(page)

    await page.getByLabel('Rename --color-brand').click()
    const input = page.getByLabel('New name for --color-brand')
    await input.fill('--color-primary')
    await input.press('Enter')

    await expect
      .poll(() => read(HOME_FILE), { message: 'rename never updated the var() read in Home.css', timeout: 30_000 })
      .toBe(HOME_CSS.replace('--color-brand', '--color-primary'))
    expect(read(TOKENS_FILE)).toBe(TOKENS_CSS.replaceAll('--color-brand', '--color-primary'))
    await expect.poll(() => colorOf(title), { message: 'a rename left the heading without its colour', timeout: 15_000 }).toBe(ORIGINAL_COLOR)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => read(TOKENS_FILE), { timeout: 30_000 }).toBe(TOKENS_CSS)
    expect(read(HOME_FILE)).toBe(HOME_CSS)
  })
})
