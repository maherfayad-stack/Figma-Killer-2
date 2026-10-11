import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * CT-6 - a Tailwind v4 project in the Variables panel, in a real browser
 * against real files.
 *
 * Four claims a unit test cannot make:
 *
 *   1. **An `@theme` value edits in place.** Typing repaints the canvas while
 *      `src/index.css` is byte-identical; Enter changes exactly the one
 *      declaration INSIDE `@theme`; the panel's Undo restores the file.
 *   2. **A rename moves the utility classes too.** `--color-crust` ->
 *      `--color-toast` rewrites the `@theme` declaration, the `var()` read in
 *      `Home.css` AND the `text-crust` class in `Home.tsx`, in one step; the
 *      canvas colour does not change; Undo puts all three files back.
 *   3. **A rename it cannot follow is refused beside the row, in words.**
 *      `--spacing-gutter` is read by every spacing utility; nothing is written.
 *   4. **Apply by utility class.** With the heading selected, the Variables
 *      panel's "Apply --color-cream as a class" adds `border-cream` to its
 *      `className` in the source, and Undo takes it back byte for byte.
 *
 * The fixture has no Tailwind installed (this suite never installs one), so the
 * canvas colour is driven by a plain `var(--color-crust)` rule; the claims are
 * about the files and the panel. The fixture lives in this run's throwaway
 * workspace copy, so writing is safe.
 */

const INDEX_CSS = ['@import "tailwindcss";', '', '/* bakery palette */', '@theme {', '  --color-crust: #c58940;', '  --color-cream: #fff7e8;', '  --spacing-gutter: 2rem;', '}', ''].join('\r\n')

const HOME_CSS = `.hero-title {
  color: var(--color-crust);
}
`

const HOME_TSX = `import './Home.css'

export default function Home() {
  return (
    <div>
      <h1 className="hero-title bg-cream text-crust">Fresh bread</h1>
    </div>
  )
}
`

const MAIN_TSX = `import './index.css'

export {}
`

const ORIGINAL_COLOR = 'rgb(197, 137, 64)'
const EDITED_COLOR = 'rgb(255, 0, 0)'

const THEME_FILE = 'src/index.css'
const HOME_CSS_FILE = 'pages/Home.css'
const HOME_TSX_FILE = 'pages/Home.tsx'

let fixture: FixtureProject

const read = (rel: string): string => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-tailwind-theme', {
    'package.json': JSON.stringify({ name: 'bakery', dependencies: { react: '^19.0.0', vite: '^6.0.0', tailwindcss: '^4.0.0' } }),
    'src/main.tsx': MAIN_TSX,
    'src/index.css': INDEX_CSS,
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
  await expect(page.getByLabel('--color-crust Default')).toBeVisible({ timeout: 30_000 })
  return { title, contentFrame }
}

const colorOf = (title: Locator): Promise<string> => title.evaluate((el) => getComputedStyle(el).color)

test.describe('CT-6 - Tailwind v4 theme in the Variables panel', () => {
  test.setTimeout(180_000)

  test('an @theme value previews on type, writes one declaration inside @theme on Enter, and Undo restores the file', async ({ page }) => {
    const { title } = await openVariables(page)
    expect(await colorOf(title)).toBe(ORIGINAL_COLOR)

    const field = page.getByLabel('--color-crust Default')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.fill('#ff0000')

    await expect.poll(() => colorOf(title), { message: 'typing an @theme value never repainted the canvas', timeout: 15_000 }).toBe(EDITED_COLOR)
    expect(read(THEME_FILE)).toBe(INDEX_CSS)

    await field.press('Enter')
    await expect
      .poll(() => read(THEME_FILE), { message: 'the committed @theme value never reached src/index.css', timeout: 30_000 })
      .toBe(INDEX_CSS.replace('--color-crust: #c58940;', '--color-crust: #ff0000;'))
    expect(read(HOME_CSS_FILE)).toBe(HOME_CSS)
    expect(read(HOME_TSX_FILE)).toBe(HOME_TSX)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => read(THEME_FILE), { message: 'Undo did not restore src/index.css byte for byte', timeout: 30_000 }).toBe(INDEX_CSS)
  })

  test('renaming a theme colour moves the declaration, the var() and the utility class, and Undo puts all three files back', async ({ page }) => {
    const { title } = await openVariables(page)

    await page.getByLabel('Rename --color-crust').click()
    const input = page.getByLabel('New name for --color-crust')
    await input.fill('--color-toast')
    await input.press('Enter')

    await expect
      .poll(() => read(HOME_TSX_FILE), { message: 'rename never moved the text-crust class in Home.tsx', timeout: 30_000 })
      .toBe(HOME_TSX.replace('text-crust', 'text-toast'))
    expect(read(THEME_FILE)).toBe(INDEX_CSS.replace('--color-crust', '--color-toast'))
    expect(read(HOME_CSS_FILE)).toBe(HOME_CSS.replace('--color-crust', '--color-toast'))
    await expect.poll(() => colorOf(title), { message: 'a rename left the heading without its colour', timeout: 15_000 }).toBe(ORIGINAL_COLOR)
    // `bg-cream` names another colour and is untouched.
    expect(read(HOME_TSX_FILE)).toContain('bg-cream')

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => read(THEME_FILE), { timeout: 30_000 }).toBe(INDEX_CSS)
    expect(read(HOME_CSS_FILE)).toBe(HOME_CSS)
    expect(read(HOME_TSX_FILE)).toBe(HOME_TSX)
  })

  test('a rename Studio cannot follow is refused beside the row with the reason, and nothing is written', async ({ page }) => {
    await openVariables(page)

    await page.getByLabel('Rename --spacing-gutter').click()
    const input = page.getByLabel('New name for --spacing-gutter')
    await input.fill('--spacing-edge')
    await input.press('Enter')

    const alert = page.getByTestId('variable-row---spacing-gutter').getByRole('alert')
    await expect(alert).toContainText('Tailwind theme variable', { timeout: 30_000 })
    await expect(alert).toContainText('every spacing and sizing utility')
    expect(read(THEME_FILE)).toBe(INDEX_CSS)
    expect(read(HOME_TSX_FILE)).toBe(HOME_TSX)
  })

  test('Apply by utility class adds the class to the selected element in the source, and Undo restores the file', async ({ page }) => {
    const { title } = await openVariables(page)
    await selectInFrame(page, title)

    await page.getByLabel('Apply --color-cream as a class').click()
    await page.getByRole('button', { name: 'border-cream' }).click()

    await expect
      .poll(() => read(HOME_TSX_FILE), { message: 'the applied class never reached Home.tsx', timeout: 30_000 })
      .toBe(HOME_TSX.replace('hero-title bg-cream text-crust', 'hero-title bg-cream text-crust border-cream'))
    expect(read(THEME_FILE)).toBe(INDEX_CSS)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => read(HOME_TSX_FILE), { message: 'Undo did not restore Home.tsx byte for byte', timeout: 30_000 }).toBe(HOME_TSX)
  })
})
