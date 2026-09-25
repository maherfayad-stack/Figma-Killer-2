import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * P1-D (ERR-19, WB-1) — real-browser proof that a file edited OUTSIDE Studio
 * mid-session reaches the canvas by itself, and that a later canvas edit lands
 * on the element the user pointed at.
 *
 * Before P1-D nothing watched the files: the board kept showing the old list
 * until someone reloaded by hand, and every `line:col` it held below the
 * change named the element one line up. Now the server's project watcher
 * notices the write, pushes a live reload down the editor bridge, and the
 * board re-reads the file — so "Zero" appears on the canvas with no gesture at
 * all, and a Delete on "Three" afterwards deletes "Three".
 *
 * SAFETY — this spec WRITES, so its fixture lives under this run's throwaway
 * copy of `studio-workspace/` and is removed afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <section className="list">
      <p className="one">One</p>
      <p className="two">Two</p>
      <p className="three">Three</p>
    </section>
  )
}
`

/** What the outside writer leaves on disk: one new line above the list items. */
const AFTER_OUTSIDE_EDIT = FIXTURE_PAGE.replace(
  '    <section className="list">\n',
  '    <section className="list">\n      <p className="zero">Zero</p>\n',
)

let fixture: FixtureProject

const pagePath = () => path.join(fixture.dir, 'pages', 'Home.tsx')
const readPage = () => fs.readFileSync(pagePath(), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-outside-edit-live-reload', {
    'pages/Home.tsx': FIXTURE_PAGE,
    // Pinned to the static tier: the reload under test is the parsed board's,
    // and a live frame would add a second canvas iframe to the frame.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

test.describe('P1-D — an edit made outside Studio reaches the canvas by itself', () => {
  test.setTimeout(180_000)

  test('the canvas shows the outside edit with no gesture, and a later Delete lands on the right element', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)
    await expect(content.locator('p', { hasText: 'Three' })).toBeVisible({ timeout: 30_000 })
    await expect(content.locator('p', { hasText: 'Zero' })).toHaveCount(0)

    // The outside writer — VS Code, `git pull`, the agent's own Edit tool. Nobody tells the board.
    fs.writeFileSync(pagePath(), AFTER_OUTSIDE_EDIT, 'utf8')

    // The board re-reads the file on its own: "Zero" appears, and "Three" is
    // now addressed by its NEW line.
    await expect(content.locator('p', { hasText: 'Zero' }), 'the canvas never noticed the outside edit').toBeVisible({
      timeout: 20_000,
    })
    const three = content.locator(`[data-node-id="${sourceNodeId(AFTER_OUTSIDE_EDIT, 'pages/Home.tsx', 'p', 4)}"]`).first()
    await expect(three).toHaveText('Three', { timeout: 20_000 })

    await panIntoView(page, canvasRoot, three, 80)
    await clickInFrame(page, three)
    await page.keyboard.press('Delete')

    const expected = AFTER_OUTSIDE_EDIT.replace('      <p className="three">Three</p>\n', '')
    await expect
      .poll(readPage, { message: 'the delete never landed on "Three"', timeout: 30_000 })
      .toBe(expected)
    expect(readPage()).toContain('<p className="two">Two</p>')
    expect(readPage()).toContain('<p className="zero">Zero</p>')
    // Nothing to report: no error or warning toast for a change the user did not cause.
    await expect(page.getByRole('alert').filter({ hasText: /changed|not saved|refused/i })).toHaveCount(0)
  })
})
