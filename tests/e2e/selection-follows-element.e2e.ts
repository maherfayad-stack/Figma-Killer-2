import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  SELECTION_RING,
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * ERR-5 — real-browser proof that the selection follows the ELEMENT when a
 * write outside the canvas shifts the line it is on
 * (`docs/audits/2026-09-23-studio-audit/02-errors-client.md`).
 *
 * A node's id is its `rel:line:col`. Before this fix, inserting a line above
 * the selected element left the selection on the old address — which now
 * named the inserted element — so the ring, the inspector and the next Delete
 * all landed on something the user never picked. The full-reload path left the
 * id untouched even when nothing had it any more.
 *
 * The write here is made directly on disk (the way an agent or an editor
 * outside Studio makes it), then the board is re-read through the SAME event
 * every full resync uses. The assertion is on the layers tree's selected row
 * and on the bytes: the selected row must be `.second`'s NEW id.
 *
 * SAFETY — writes only its own fixture under this run's throwaway copy of
 * `studio-workspace/`, removed afterwards.
 */
const FIXTURE_PAGE = `export default function Home() {
  return (
    <section className="list">
      <p className="first">First</p>
      <p className="second">Second</p>
    </section>
  )
}
`

/** The agent's write: a banner on the line `.second` used to be on. */
const WITH_BANNER = FIXTURE_PAGE.replace(
  '      <p className="second">Second</p>\n',
  '      <p className="banner">NEW BANNER</p>\n      <p className="second">Second</p>\n',
)

const SECOND_BEFORE = 'pages/Home.tsx:5:8'
const BANNER_AFTER = 'pages/Home.tsx:5:8'
const SECOND_AFTER = 'pages/Home.tsx:6:8'

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-selection-follows-element', { 'pages/Home.tsx': FIXTURE_PAGE })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openLayers(page: Page): Promise<Locator> {
  const explorer = page.getByRole('complementary', { name: 'Explorer' })
  if (!(await explorer.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Open Explorer panel' }).click()
  }
  const tree = page.getByTestId('dom-panel-tree')
  await expect(tree, 'the layers tree never rendered').toBeVisible({ timeout: 20_000 })
  return tree
}

test.describe('ERR-5 — the selection follows its element across a reparse', () => {
  test.setTimeout(180_000)

  test('a line inserted above the selected element does not move the selection onto the new line', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 60_000 })
    const contentFrame = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const second = contentFrame.locator(`[data-node-id="${SECOND_BEFORE}"]`).first()
    await panIntoView(page, canvasRoot, second, 80)
    await clickInFrame(page, second)
    await openLayers(page)
    await expect(page.getByTestId(`dom-tree-item-${SECOND_BEFORE}`)).toHaveAttribute('aria-selected', 'true')

    fs.writeFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), WITH_BANNER)
    await page.evaluate(() => window.dispatchEvent(new Event('cms-site-reload')))

    // The banner now owns `.second`'s old address — and is NOT selected.
    const bannerRow = page.getByTestId(`dom-tree-item-${BANNER_AFTER}`)
    const secondRow = page.getByTestId(`dom-tree-item-${SECOND_AFTER}`)
    await expect(secondRow, '`.second` never re-appeared at its shifted id').toBeVisible({ timeout: 30_000 })
    await expect(secondRow).toHaveAttribute('aria-selected', 'true')
    await expect(bannerRow).not.toHaveAttribute('aria-selected', 'true')
    await expect(contentFrame.locator(`[data-node-id="${BANNER_AFTER}"]`)).toContainText('NEW BANNER')
    await expect(page.locator(SELECTION_RING).first()).toBeVisible()
  })
})
