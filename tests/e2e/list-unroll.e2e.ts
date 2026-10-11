import { expect, test, type Page, type Request } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  selectInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * G-9 (OD-24) — "Unroll list", in a real browser against the production
 * bundle, asserted on the FILE on disk and on the `/save` requests:
 *
 *   - Delete on an element INSIDE a `.map` row is refused (one piece of JSX
 *     renders every row, so "this row's heading" has no place in the source);
 *     the dialog offers "Unroll list";
 *   - taking it writes the three rows out as separate elements AND deletes the
 *     heading of the SECOND row only — two writes, the array left untouched;
 *   - ONE ⌘Z puts the file back byte for byte.
 *
 * SAFETY — this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const HOME = 'pages/Home.tsx'

const HOME_PAGE = `const LANES = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
]

export default function Home() {
  return (
    <main style={{ padding: "24px" }}>
      <ul className="lanes">
        {LANES.map((lane) => (
          <li key={lane.id} className="lane">
            <b>{lane.title}</b>
            <span>cards</span>
          </li>
        ))}
      </ul>
    </main>
  )
}
`

const UNROLLED_THEN_DELETED = `const LANES = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
]

export default function Home() {
  return (
    <main style={{ padding: "24px" }}>
      <ul className="lanes">
        <li className="lane">
          <b>To do</b>
          <span>cards</span>
        </li>
        <li className="lane">
          <span>cards</span>
        </li>
        <li className="lane">
          <b>Done</b>
          <span>cards</span>
        </li>
      </ul>
    </main>
  )
}
`

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-list-unroll', {
    [HOME]: HOME_PAGE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

function recordSaves(page: Page): Request[] {
  const saves: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request)
  })
  return saves
}

const QUIET_MS = 2_000
/** The heading of row `k`: the `<b>` inside the row template, as the board names it. */
const HEADING = (k: number) => `${sourceNodeId(HOME_PAGE, HOME, 'b', 1)}#${k}`

test.describe('G-9 — Unroll list', () => {
  test.setTimeout(240_000)

  test('a Delete inside a row offers "Unroll list"; taking it writes the rows out, deletes that row’s heading, and ONE ⌘Z restores the file', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const heading = canvasContentFrame(frame).locator(`[data-node-id="${HEADING(1)}"]`).first()
    await panIntoView(page, canvasRoot, heading, 80)
    await selectInFrame(page, heading)
    const saves = recordSaves(page)

    await page.keyboard.press('Delete')
    const unroll = page.getByTestId('constraint-action-unroll-list')
    await expect(unroll).toBeVisible({ timeout: 20_000 })
    await expect(unroll).toHaveText('Unroll list')
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a refused gesture writes nothing').toHaveLength(0)
    expect(read(HOME)).toBe(HOME_PAGE)

    await unroll.click()
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(UNROLLED_THEN_DELETED)
    await page.waitForTimeout(QUIET_MS)
    expect(saves.map((save) => save.postDataJSON().edits[0].kind), 'the rows, then the replayed delete').toEqual(['unroll-list', 'delete'])
    await expect(page.getByText('List unrolled')).toBeVisible()

    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })
})
