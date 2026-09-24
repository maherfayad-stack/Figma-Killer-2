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
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P3-E (ERR-9, WB-9) — real-browser proof that an edit made on the canvas
 * survives the writes that land before it is saved.
 *
 * The board holds an unsaved text edit while two other writes reach the same
 * file first: one from OUTSIDE Studio (a text change in another element, the
 * way VS Code or the agent's own Edit tool makes one) and the user's own ⌘D,
 * whose write comes back as a re-read of the page. Before P3-E that re-read
 * replaced the page wholesale: the typed text vanished and a toast blamed "an
 * agent". Now the unsaved edit is rebased onto the page as re-read and saved
 * on ⌘S — and all three changes are in the file, byte for byte, with the
 * edited text still raw JSX text on its own line (WB-9).
 *
 * Deterministic on purpose: autosave is off, so the canvas edit cannot be
 * saved before the other writes, and the ⌘D's `/save` is held on the wire
 * until the canvas edit has been typed — the "0.3–2 s between a ⌘D and its
 * resync" the audit measured, stretched until the test is ready.
 *
 * SAFETY — this spec WRITES, so its fixture lives under this run's throwaway
 * copy of `studio-workspace/` and is removed afterwards.
 */

const REL = 'pages/Home.tsx'

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

/** The outside writer changes the SECOND line's text — nothing moves. */
const AFTER_OUTSIDE_EDIT = FIXTURE_PAGE.replace('>Two<', '>Deux<')

/** Every change on disk: the outside edit, the ⌘D copy of "Three", and the canvas edit on "One". */
const EXPECTED = AFTER_OUTSIDE_EDIT.replace('>One<', '>One!<').replace(
  '      <p className="three">Three</p>\n',
  '      <p className="three">Three</p>\n      <p className="three">Three</p>\n',
)

let fixture: FixtureProject

const pagePath = () => path.join(fixture.dir, ...REL.split('/'))
const readPage = () => fs.readFileSync(pagePath(), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-edits-survive-concurrent-writes', {
    [REL]: FIXTURE_PAGE,
    // Pinned to the static tier: the re-read under test is the parsed board's,
    // and a live frame would add a second canvas iframe to the frame.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

/** Hold the NEXT `/save` on the wire until `release()` — the only one this spec holds. */
async function holdNextSave(page: Page): Promise<{ held: Promise<void>; release: () => void }> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalHeld!: () => void
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve
  })
  let holding = true
  await page.route('**/admin/api/studio/save', async (route) => {
    if (holding) {
      holding = false
      signalHeld()
      await gate
    }
    await route.continue()
  })
  return { held, release }
}

async function appendTextInline(page: Page, canvasRoot: Locator, content: FrameLocator, target: Locator, typed: string) {
  await panIntoView(page, canvasRoot, target, 80)
  const box = await target.boundingBox()
  expect(box, 'the edited element has no bounding box').not.toBeNull()
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(content.locator('[contenteditable]')).toHaveCount(1, { timeout: 15_000 })
  await page.keyboard.insertText(typed)
  await page.keyboard.press('Control+Enter')
}

test.describe('P3-E — an unsaved canvas edit survives the writes that land before its save', () => {
  test.setTimeout(180_000)

  test('an outside edit and a ⌘D land first; the typed text is rebased, saved, and the file is exact', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 60_000 })
    const content = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    const nodeAt = (occurrence: number) =>
      content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'p', occurrence)}"]`).first()
    await expect(nodeAt(3)).toHaveText('Three', { timeout: 30_000 })

    // 1. The user duplicates "Three"; its write is held on the wire.
    const save = await holdNextSave(page)
    await panIntoView(page, canvasRoot, nodeAt(3), 80)
    await clickInFrame(page, nodeAt(3))
    await page.keyboard.press('Control+d')
    await save.held

    // 2. Something outside Studio edits the same file. The board re-reads it.
    fs.writeFileSync(pagePath(), AFTER_OUTSIDE_EDIT, 'utf8')
    await expect(nodeAt(2), 'the canvas never noticed the outside edit').toHaveText('Deux', { timeout: 20_000 })

    // 3. The user types into "One" — autosave is off, so this stays unsaved.
    await appendTextInline(page, canvasRoot, content, nodeAt(1), '!')
    await expect(nodeAt(1)).toHaveText('One!')

    // 4. The ⌘D's write lands, and the board re-reads the page it wrote.
    save.release()
    await expect.poll(() => readPage().split('className="three"').length - 1, { timeout: 30_000 }).toBe(2)
    await expect(content.locator('p', { hasText: 'Three' })).toHaveCount(2, { timeout: 20_000 })

    // The typed text is still on the canvas — the re-read did not take it away.
    await expect(nodeAt(1)).toHaveText('One!')

    // 5. ⌘S writes it — onto the page as it is now.
    await canvasRoot.focus()
    await page.keyboard.press('Control+s')
    await expect
      .poll(readPage, { message: 'the file does not hold all three changes, exactly', timeout: 30_000 })
      .toBe(EXPECTED)

    // Nothing was lost, so nothing is reported — and no one is blamed.
    await expect(page.getByRole('alert').filter({ hasText: /overwritten|agent|not saved|changed/i })).toHaveCount(0)
  })
})
