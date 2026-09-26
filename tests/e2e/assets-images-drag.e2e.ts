import { expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * P5-B3 (IMG-6) — dragging an image from the Assets panel's Images section
 * onto a design frame.
 *
 * The gesture is the canvas's own POINTER drag (`useCanvasInsertionDrag`,
 * never HTML5 drag-and-drop), relayed out of the frame by
 * `markCanvasPointerRelay` — which is exactly the part a unit test cannot
 * reach: happy-dom has no layout, no iframe realm and no pointer relay. So
 * this drives a real mouse from a real card to a real element inside the
 * frame, and asserts on disk and on computed layout (standing-02):
 *
 *   1. an `<img src="/brand-logo.png">` is written into the page's source —
 *      the literal the project's own site serves the file at;
 *   2. NOTHING was uploaded: `public/` holds exactly the file it held before
 *      (the insert references the project file, it never copies it);
 *   3. the image renders in the frame with a measured, non-zero box.
 */

/** A 1x1 opaque PNG — real enough for the browser to decode and lay out. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const FIXTURE_PAGE = `import './home.css'

export default function Home() {
  return (
    <main className="home">
      <h1 className="home__title">Drop target</h1>
      <p className="home__body">Drag an image from the Assets panel onto this frame.</p>
    </main>
  )
}
`

const FIXTURE_CSS = `.home {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 40px;
  min-height: 560px;
  font-family: system-ui, sans-serif;
  background: #ffffff;
}

.home__title { margin: 0; font-size: 32px; }
.home__body { margin: 0; font-size: 16px; }
.home img { width: 120px; height: 120px; }
`

let fixture: FixtureProject

const readPage = (): string => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.jsx'), 'utf8')
const publicFiles = (): string[] => fs.readdirSync(path.join(fixture.dir, 'public')).sort()

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-assets-images-drag', {
    'pages/Home.jsx': FIXTURE_PAGE,
    'pages/home.css': FIXTURE_CSS,
    'public/.gitkeep': '',
    'package.json': JSON.stringify({ name: 'assets-images-drag-fixture', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify(
        {
          displayName: 'Zz Assets Images Drag Fixture',
          platform: 'web',
          pagesDir: 'pages',
          frameDefaults: { width: 900, height: 640 },
          // One design frame per page — the gesture under test targets it
          // (see frame-file-drop.e2e.ts for why static keeps the spec honest).
          trust: 'static',
        },
        null,
        2,
      ) + '\n',
  })
  fs.writeFileSync(path.join(fixture.dir, 'public', 'brand-logo.png'), Buffer.from(PNG_BASE64, 'base64'))
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openImagesSection(page: Page) {
  await page.getByTestId('panel-rail-assets').click()
  const assets = page.getByTestId('assets-panel')
  await expect(assets).toBeVisible({ timeout: 10_000 })
  // The Images section sits below the design system's cards; a search for the
  // file narrows every other section to nothing, the way a user finds it.
  await assets.getByRole('searchbox', { name: 'Search assets' }).fill('brand-logo')
  const card = assets.locator('[data-testid="assets-image-card"][data-asset-path="public/brand-logo.png"]')
  await expect(card, 'the project image is not listed in the Assets panel Images section').toBeVisible({ timeout: 30_000 })
  await card.scrollIntoViewIfNeeded()
  return card
}

test.describe('dragging a project image from the Assets panel onto a frame (IMG-6)', () => {
  test.setTimeout(240_000)

  test('writes an <img> that references the file, uploads nothing, and renders it', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const boardFrame = page.locator('[data-page-id]').first()
    await expect(visibleCanvasIframe(boardFrame), 'no design frame mounted on the fixture board').toHaveCount(1, { timeout: 60_000 })
    await expect(canvasRoot).toBeVisible()
    const contentFrame = canvasContentFrame(boardFrame)
    await expect(contentFrame.locator('.home__body')).toBeVisible({ timeout: 60_000 })

    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)
    const publicBefore = publicFiles()

    const card = await openImagesSection(page)
    const from = await card.boundingBox()
    const to = await contentFrame.locator('.home__body').boundingBox()
    if (!from || !to) throw new Error('the card or the drop target has no box')

    // A real pointer gesture: press on the card, travel past the drag
    // threshold in several steps (the resolver runs once per animation frame),
    // release over the paragraph inside the frame.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
    await page.mouse.move(to.x + to.width / 2, to.y + to.height - 2, { steps: 12 })
    await page.waitForTimeout(100)
    await page.mouse.up()

    await expect
      .poll(() => readPage(), {
        timeout: 60_000,
        message: 'no <img> reached the page source — the drag from the Assets panel did not become an insert',
      })
      .toMatch(/<img[^>]*src="\/brand-logo\.png"/)

    const after = readPage()
    expect(after, 'the written <img> has no alt seeded from the file name').toContain('alt="brand-logo"')
    expect(after, 'the page lost content it already had').toContain('<h1 className="home__title">Drop target</h1>')
    expect(publicFiles(), 'dragging a project image uploaded a copy of it').toEqual(publicBefore)

    // Computed layout, not a DOM presence check: the image resolved through
    // the project asset route and was laid out with a real box.
    const img = contentFrame.locator('img[src*="brand-logo.png"]').first()
    await expect(img).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () => img.evaluate((element) => {
        const image = element as HTMLImageElement
        const rect = image.getBoundingClientRect()
        return image.complete && image.naturalWidth > 0 && rect.width > 0 && rect.height > 0
      }), { timeout: 30_000, message: 'the inserted image never decoded or was laid out with an empty box' })
      .toBe(true)
  })
})
