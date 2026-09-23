import { expect, test } from '@playwright/test'
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
 * P1-A (WB-1) — real-browser proof that a file edited OUTSIDE Studio mid-session
 * cannot make a canvas gesture land on the wrong element.
 *
 * The board reads the list, then something else (the agent's Edit tool, VS
 * Code, `git pull`) inserts a line above it. Nothing tells the board, so every
 * `line:col` it holds now names the element one line up. Before P1-A a Delete
 * on "Three" removed "Two" and reported success. Now the write carries the
 * identity the parser recorded, the server refuses `element-moved`, and the
 * board silently re-reads the file, re-finds "Three" at its new line and
 * deletes THAT — so the file changes exactly where the user pointed.
 *
 * SAFETY — this spec WRITES, so its fixture lives under this run's throwaway
 * copy of `studio-workspace/` and is removed afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <ul className="list">
      <li className="one">One</li>
      <li className="two">Two</li>
      <li className="three">Three</li>
    </ul>
  )
}
`

/** What the outside writer leaves on disk: one new line above the list items. */
const AFTER_OUTSIDE_EDIT = FIXTURE_PAGE.replace(
  '    <ul className="list">\n',
  '    <ul className="list">\n      <li className="zero">Zero</li>\n',
)

let fixture: FixtureProject

const pagePath = () => path.join(fixture.dir, 'pages', 'Home.tsx')
const readPage = () => fs.readFileSync(pagePath(), 'utf8')

/** `rel:line:col` of the Nth `<tag` in `source`, col 1-based just after `<` — the id the parser mints. */
function nodeId(source: string, tag: string, occurrence: number): string {
  const re = new RegExp(`<${tag}(?=[\\s/>])`, 'g')
  let match: RegExpExecArray | null
  let count = 0
  while ((match = re.exec(source)) !== null) {
    count += 1
    if (count !== occurrence) continue
    const lines = source.slice(0, match.index + 1).split('\n')
    return `pages/Home.tsx:${lines.length}:${lines[lines.length - 1]!.length + 1}`
  }
  throw new Error(`fixture has no <${tag} #${occurrence}`)
}

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-element-identity-guard', {
    'pages/Home.tsx': FIXTURE_PAGE,
    // Pinned to the static tier: the gesture under test runs on the parsed
    // board, and a live frame would add a second canvas iframe to the frame.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

test.describe('P1-A — an outside edit never redirects a canvas gesture', () => {
  test.setTimeout(180_000)

  test('Delete on "Three" after a line was inserted above it deletes "Three", nothing else', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 60_000 })
    const content = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const three = content.locator(`[data-node-id="${nodeId(FIXTURE_PAGE, 'li', 3)}"]`).first()
    await panIntoView(page, canvasRoot, three, 80)
    await clickInFrame(page, three)

    // The outside writer. The board is not told.
    fs.writeFileSync(pagePath(), AFTER_OUTSIDE_EDIT, 'utf8')

    await page.keyboard.press('Delete')

    const expected = AFTER_OUTSIDE_EDIT.replace('      <li className="three">Three</li>\n', '')
    await expect
      .poll(readPage, { message: 'the delete never landed on "Three"', timeout: 30_000 })
      .toBe(expected)
    // The neighbour the stale id now names — and everything else — survived.
    expect(readPage()).toContain('<li className="two">Two</li>')
    expect(readPage()).toContain('<li className="zero">Zero</li>')
    // Recovered silently: no error or warning toast for a refusal the user did not cause.
    await expect(page.getByRole('alert').filter({ hasText: /changed|not saved|refused/i })).toHaveCount(0)
  })
})
