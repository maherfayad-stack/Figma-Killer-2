import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

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
 * SAFETY — this spec WRITES, so it must never point at real user data. The
 * fixture is created fresh under this RUN's THROWAWAY COPY of
 * `studio-workspace/` (`WORKSPACE_ROOT`, made by `scripts/e2e-dev.ts`) and
 * removed afterwards; the tracked tree is never read or written.
 *
 * It used to be created in an OS temp directory and opened by absolute path.
 * That cannot work and never did: `resolveProjectDir`'s containment check
 * rejects any directory outside the root the SERVER resolved, so the board
 * route 404s and both cases fail on a 20 s timeout that reads exactly like a
 * product bug. The throwaway copy gives the same safety property for real.
 */

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

let fixture: FixtureProject

function cssPath(): string {
  return path.join(fixture.dir, 'pages', 'Home.css')
}

function readCss(): string {
  return fs.readFileSync(cssPath(), 'utf8')
}

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-css-writeback', {
    'pages/Home.css': FIXTURE_CSS,
    'pages/Home.tsx': FIXTURE_PAGE,
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

/**
 * Open the board on the fixture with auto-save ON — unlike every other studio
 * spec, reaching disk IS the thing under test here. Safe only because the
 * fixture lives in this run's throwaway workspace copy.
 *
 * This used to be a private opener that went straight from `goto` to a click.
 * It could not work: the canvas has no scroll container, so where a frame
 * LANDS is decided by a "center on open" pass that races the arrival of the
 * page documents it centres on. On a cold load the board settles pointed
 * somewhere with no frame in it, `page.mouse.click(box.x + w/2, …)` lands on
 * empty canvas, nothing is selected, and the failure reads like "the Style
 * panel never bound to a class" — a product bug that was never there. The
 * shared `openFixtureBoard` resets the view with the product's own Ctrl+0
 * first, and `panIntoView` puts the target under the pointer before the click.
 */
async function openStudioBoard(page: Page): Promise<{ canvasRoot: Locator; contentFrame: FrameLocator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(
    frame.locator(CANVAS_FRAME_IFRAME_SELECTOR),
    'the fixture frame never mounted a live canvas iframe after being panned into view',
  ).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, contentFrame: frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR) }
}

/** Select an element on the canvas and wait for the Style panel to bind to its class. */
async function selectAndOpenSizeSection(
  page: Page,
  canvasRoot: Locator,
  contentFrame: FrameLocator,
  selector: string,
  expectedChip: string,
) {
  const target = contentFrame.locator(selector).first()
  await panIntoView(page, canvasRoot, target, 80)
  await clickInFrame(page, target)

  // The write target used to be `StyleTargetChip`'s own Element/Class pair.
  // Wave 3's inspector-density work deleted that row as a duplicate of the
  // ClassPicker sitting directly above it (`SelectorPillStack.tsx`), and the
  // chip component now renders only for a MULTI-selection
  // (`MultiSelectTargetBar.tsx`). For a single selection the class pill IS
  // the write target, so that is what this asserts - the same claim, on the
  // surface that now makes it.
  const chip = page.getByTestId(`class-chip-${expectedChip.replace('.', '')}`)
  await expect(chip, `selecting ${selector} did not bind the inspector to a class`).toBeVisible({ timeout: 15_000 })
  await expect(chip).toHaveText(new RegExp(expectedChip.replace('.', '\\.')))

  // Size lives in Measures now (`MeasuresSection` renders `SizeSection`), and
  // Measures is always mounted - there is no category to navigate to first.
  const field = page.getByTestId('css-size-input-width').getByRole('textbox', { name: 'Width' })
  await expect(field, 'the Measures section did not render a width control').toBeVisible({ timeout: 10_000 })
  return { field }
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
    const { canvasRoot, contentFrame } = await openStudioBoard(page)

    // Sanity: the fixture is what we wrote, before anything touches it.
    expect(readCss()).toBe(FIXTURE_CSS)

    const { field } = await selectAndOpenSizeSection(page, canvasRoot, contentFrame, '.hero-title', '.hero-title')

    // `WriteTargetSlot` wraps each pill and carries the claim the chip's
    // `data-writable` used to make: `data-locked="false"` means an edit lands
    // here. That claim and the actual save outcome share
    // `classifyStylesheetEditability`, so a mismatch would mean the UI is
    // lying about a tier.
    const writeTarget = page
      .locator('[data-testid^="write-target-chip-"]')
      .filter({ has: page.getByTestId('class-chip-hero-title') })
    await expect(writeTarget, 'the inspector did not mark a plain .css class as writable').toHaveAttribute(
      'data-locked',
      'false',
    )

    await setWidth(field, '321px')
    await expect(field, 'the width control did not keep the typed value').toHaveValue('321px')
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
    const { canvasRoot, contentFrame } = await openStudioBoard(page)

    const before = readCss()
    const { field } = await selectAndOpenSizeSection(page, canvasRoot, contentFrame, '.trap', '.trap')

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
