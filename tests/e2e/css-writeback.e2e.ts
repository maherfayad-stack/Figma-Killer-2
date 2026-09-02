import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * `panel-02` (WS-6.3) — real-browser proof that changing a value in the Figma
 * inspector lands in the project's actual `.css` file on disk, and that an
 * edit which could NOT land honestly refuses instead.
 *
 * Why this spec has to exist: `src/core/css-codemods/` was byte-exact unit
 * tested and reached nothing for an entire work order. A green `bun test` says
 * the postcss round-trip is correct; it says nothing about whether a user can
 * select an element, find the control, and have the bytes change. Per
 * `STATE.md`'s standing acceptance bar, that is the only thing that counts as
 * done — so everything below drives real mouse and real keys, then reads the
 * file back off the filesystem.
 *
 * The two claims:
 *
 *   1. **It writes.** Typing a width for a class-styled element updates that
 *      declaration in the source `.css`, leaving every other byte of the file
 *      alone (comments, formatting, unrelated rules).
 *   2. **It refuses.** A selector declared twice, where the LATER block also
 *      sets the property being edited, cannot land on one honest target —
 *      `setDeclaration` writes the first match while the cascade honours the
 *      last, so the write would change the file and change nothing on screen.
 *      The user gets a readable reason and the file is untouched.
 *
 * SAFETY — this spec WRITES, so it must never point at real user data.
 * `studio-workspace/` is read-only for tests. The fixture below is created
 * fresh in an OS temp directory, opened by absolute path (the studio dir
 * resolver accepts one), and removed afterwards. Nothing under
 * `studio-workspace/` is read or written at any point.
 */

const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

/**
 * The fixture stylesheet, written verbatim and asserted against verbatim.
 *
 * `.hero-title` is the WRITE target — declared once, so it has exactly one
 * honest home. `.trap` is the REFUSE target — declared twice, both blocks
 * setting `width`, which is precisely the case where a successful-looking
 * write would be invisible on the canvas. The comment and the blank-line
 * rhythm are here so the "everything else is byte-identical" assertion has
 * something real to protect.
 */
const FIXTURE_CSS = `/* panel-02 fixture — formatting here must survive a write. */
.hero {
  display: flex;
  gap: 8px;
}

.hero-title {
  width: 120px;
  font-size: 24px;
}

.trap {
  width: 50px;
}

.trap {
  width: 70px;
}
`

const FIXTURE_PAGE = `import './Home.css'

export default function Home() {
  return (
    <div className="hero">
      <h1 className="hero-title">Panel 02</h1>
      <p className="trap">Trap</p>
    </div>
  )
}
`

let fixtureDir: string

function cssPath(): string {
  return path.join(fixtureDir, 'pages', 'Home.css')
}

function readCss(): string {
  return fs.readFileSync(cssPath(), 'utf8')
}

test.beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-panel02-'))
  fs.mkdirSync(path.join(fixtureDir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'Home.css'), FIXTURE_CSS, 'utf8')
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'Home.tsx'), FIXTURE_PAGE, 'utf8')
})

test.afterAll(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
})

/**
 * Open the studio board on the temp fixture with auto-save ON — unlike every
 * other studio spec, reaching disk IS the thing under test here. Safe only
 * because `fixtureDir` is a throwaway temp directory.
 */
async function openStudioBoard(page: Page, projectDir: string): Promise<Locator> {
  await page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
    window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: true }))
  }, projectDir)

  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 90_000 })
  await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 30_000 })
  return canvasRoot
}

/**
 * Click an element inside a canvas iframe with real mouse coordinates.
 * `locator.click()` would try to scroll it into view, and the canvas pans via
 * a CSS transform with no native scroll container, so it hangs rather than
 * failing usefully. Same helper shape as `instance-selection-ui.e2e.ts`.
 */
async function clickInFrame(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

/** Select an element on the canvas and wait for the Style panel to bind to its class. */
async function selectAndOpenSizeSection(page: Page, contentFrame: FrameLocator, selector: string, expectedChip: string) {
  await clickInFrame(page, contentFrame.locator(selector).first())

  const chip = page.getByTestId('style-target-chip-class')
  await expect(chip, `selecting ${selector} did not bind the Style panel to a class`).toBeVisible({ timeout: 15_000 })
  await expect(chip).toHaveText(new RegExp(expectedChip.replace('.', '\\.')))

  // The rail navigates the section list; Size is where width/height live.
  await page.getByTestId('style-category-size').click()
  const field = page.getByTestId('css-size-scrub-width-field')
  await expect(field, 'the Size section did not render a width control').toBeVisible({ timeout: 10_000 })
  return { chip, field }
}

/** Type a value into a ScrubInput and commit it with Enter. */
async function setWidth(field: Locator, value: string): Promise<void> {
  await field.click()
  await field.press('ControlOrMeta+a')
  await field.fill(value)
  await field.press('Enter')
}

test.describe('panel-02 — CSS write-back reaches disk, and refuses when it cannot land honestly', () => {
  // A cold ts-morph parse on open plus two autosave round trips.
  test.setTimeout(180_000)

  test('an inspector width change is written into the real .css file, byte-exact elsewhere', async ({ page }) => {
    await openStudioBoard(page, fixtureDir)

    const frame = page.locator('[data-page-id]').first()
    const contentFrame = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    // Sanity: the fixture is what we wrote, before anything touches it.
    expect(readCss()).toBe(FIXTURE_CSS)

    const { chip, field } = await selectAndOpenSizeSection(page, contentFrame, '.hero-title', '.hero-title')

    // The chip must claim this class is writable — that claim and the actual
    // save outcome share `classifyStylesheetEditability`, so a mismatch here
    // would mean the UI is lying about a tier.
    await expect(chip, 'the style-target chip did not mark a plain .css class as writable').toHaveAttribute(
      'data-writable',
      'true',
    )

    await setWidth(field, '321px')
    await expect(field, 'the width control did not keep the typed value').toHaveValue('321px')
    // `data-state` is driven by the STORE's stored value, not the input's own
    // draft — so this distinguishes "typed but never committed" from "committed",
    // which is exactly the seam that hid this feature's original failure.
    await expect(page.getByTestId('css-size-input-width'), 'the commit never reached the store').toHaveAttribute('data-state', 'set')

    // Autosave debounces at STUDIO_AUTOSAVE_DELAY_MS (2s); poll the real file.
    await expect
      .poll(() => readCss(), {
        message: 'the inspector edit never reached pages/Home.css on disk',
        timeout: 30_000,
      })
      .toContain('width: 321px')

    // The whole point of a CST round-trip: one declaration changed, every
    // other byte — the comment, the blank lines, the unrelated rules —
    // survived exactly.
    expect(readCss()).toBe(FIXTURE_CSS.replace('width: 120px', 'width: 321px'))
  })

  test('a selector declared twice REFUSES with a readable reason and leaves the file untouched', async ({ page }) => {
    await openStudioBoard(page, fixtureDir)

    const frame = page.locator('[data-page-id]').first()
    const contentFrame = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const before = readCss()
    const { field } = await selectAndOpenSizeSection(page, contentFrame, '.trap', '.trap')

    await setWidth(field, '999px')

    // The refusal surfaces through the global toast bus, which renders with
    // role="alert" — the same channel every other studio refusal uses.
    const alert = page.locator('[role="alert"]', { hasText: /declared more than once/i })
    await expect(alert, 'editing a doubly-declared selector did not surface a refusal').toBeVisible({ timeout: 30_000 })

    // The file is the real assertion: a refusal that still wrote would be
    // worse than no refusal at all.
    expect(readCss(), 'a refused CSS edit still modified the stylesheet').toBe(before)
  })
})
