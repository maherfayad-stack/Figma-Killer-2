import { expect, test, type FrameLocator, type Locator, type Page, type Route } from '@playwright/test'
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
 * The Phase 1 exit gate (`ROADMAP.md` §5): "a page file is edited outside
 * Studio mid-session, then the canvas edits and deletes, and the file changes
 * exactly where intended."
 *
 * Phase 1 exists because a node id is a `rel:line:col`, and an edit made
 * outside Studio (VS Code, `git pull`, the agent's own Edit tool) moves every
 * line under it. Before P1-A/P1-D, a stale id named the element one line up,
 * and a text edit or a Delete landed there and reported success (WB-1). This
 * file drives the whole road in a real browser — the watcher that notices the
 * outside write (P1-D), the identity every write carries (P1-A), the
 * server's re-location of an edit whose file moved under it (P1-D), and the
 * undo of a delete (P1-F / `store-15`) — and asserts on the BYTES on disk:
 * the right element got the edit, the right one was deleted, and every other
 * byte, the outside edit included, is untouched.
 *
 * The three race cases make the outside write while the canvas edit is still
 * PENDING (typed, not yet sent) or IN FLIGHT (sent, held on the wire by
 * `page.route`). For those the contract is the one Phase 1 promises: the edit
 * lands on the element the user pointed at, or it is refused and nothing is
 * written. It never lands on a neighbour. Which of the two happened is
 * recorded as a test annotation.
 *
 * SAFETY — every case authors its own fixture under this run's throwaway copy
 * of `studio-workspace/` (a distinct directory per case, so one case's
 * watcher and remembered source text can never answer for another's), and
 * all of them are removed afterwards.
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

/**
 * What the outside writer leaves on disk: a comment above the component (so
 * EVERY node id in the file shifts, the section's included) and a new
 * same-tag sibling above the list (so each stale id now names a real `<p>` —
 * "Two"'s old address is "Zero", "Three"'s is "One").
 */
const AFTER_OUTSIDE_EDIT = `// Edited outside Studio, mid-session.
${FIXTURE_PAGE.replace('    <section className="list">\n', '    <section className="list">\n      <p className="zero">Zero</p>\n')}`

/** Appended to "Two" on the canvas. No space: a trailing space in a contenteditable is an nbsp, which is not what this gate is about. */
const TYPED = '-edited'

/** `source` with "Two"'s text replaced the way `setJsxText` writes it. */
const withTwoEdited = (source: string) =>
  replaceOnce(source, '<p className="two">Two</p>', `<p className="two">{${JSON.stringify(`Two${TYPED}`)}}</p>`)

/** `source` without the "Three" line — what `deleteJsxElement` leaves. */
const withoutThree = (source: string) => replaceOnce(source, '      <p className="three">Three</p>\n', '')

function replaceOnce(source: string, from: string, to: string): string {
  const at = source.indexOf(from)
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`the fixture does not hold exactly one ${JSON.stringify(from)}`)
  return source.slice(0, at) + to + source.slice(at + from.length)
}

const fixtures: FixtureProject[] = []

function authorFixture(name: string): FixtureProject {
  const fixture = createAuthoredFixtureProject(name, {
    [REL]: FIXTURE_PAGE,
    // Pinned to the static tier: the writes under test run on the parsed
    // board, and a live frame would add a second canvas iframe to the frame.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
  fixtures.push(fixture)
  return fixture
}

const pagePath = (fixture: FixtureProject) => path.join(fixture.dir, ...REL.split('/'))
const readPage = (fixture: FixtureProject) => fs.readFileSync(pagePath(fixture), 'utf8')
/** The outside writer. Nobody tells the board. */
const writeOutside = (fixture: FixtureProject) => fs.writeFileSync(pagePath(fixture), AFTER_OUTSIDE_EDIT, 'utf8')

test.afterAll(() => {
  for (const fixture of fixtures) removeFixtureProject(fixture)
})

/** Open the fixture's board and return its one frame's content, with "Two" rendered. */
async function openBoard(page: Page, fixture: FixtureProject, autoSave: boolean) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  await expect(content.locator('p', { hasText: 'Two' })).toBeVisible({ timeout: 30_000 })
  return { canvasRoot, content }
}

/** The `<p>` the parser minted for the Nth `<p` of `source`. */
function paragraph(content: FrameLocator, source: string, occurrence: number): Locator {
  return content.locator(`[data-node-id="${sourceNodeId(source, REL, 'p', occurrence)}"]`).first()
}

/** Double-click a text node on the canvas, append `TYPED` as one input, and commit with ⌘/Ctrl+Enter. */
async function appendTextInline(page: Page, canvasRoot: Locator, content: FrameLocator, target: Locator) {
  await panIntoView(page, canvasRoot, target, 80)
  const box = await target.boundingBox()
  expect(box, 'the text node has no bounding box').not.toBeNull()
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await expect(
    content.locator('[contenteditable]'),
    'double-clicking the text node did not open inline editing, so no value edit could be made',
  ).toHaveCount(1, { timeout: 15_000 })
  await page.keyboard.insertText(TYPED)
  await page.keyboard.press('Control+Enter')
  await expect(target).toHaveText(`Two${TYPED}`)
}

/** Error and warning toast cards: a refusal the user was told about. */
const refusalToasts = (page: Page) => page.locator('[data-toast-kind="error"], [data-toast-kind="warning"]')

/**
 * Wait until the file on disk settles on one of the two honest outcomes of a
 * racing edit: `landed` (the outside edit plus exactly the intended change)
 * or — once the user has been told of a refusal — `untouched` (the outside
 * edit alone). Any OTHER content is the failure Phase 1 exists to prevent: a
 * write that reached a different element, or a partial one. A non-matching
 * read has to repeat before it counts, so a read that races the server's own
 * (non-atomic) file write cannot fail the case.
 */
async function settleOnDisk(
  page: Page,
  fixture: FixtureProject,
  { untouched, landed, what }: { untouched: string; landed: string; what: string },
): Promise<'landed' | 'refused'> {
  const deadline = Date.now() + 45_000
  let strangeReads = 0
  for (;;) {
    const disk = readPage(fixture)
    if (disk === landed) return 'landed'
    if (disk !== untouched) {
      strangeReads += 1
      if (strangeReads >= 3) {
        throw new Error(
          `${what}: the file on disk is neither the outside edit alone nor the outside edit plus the intended change — ` +
            `a write landed on an element it was not aimed at.\n--- on disk ---\n${disk}\n--- intended ---\n${landed}`,
        )
      }
    } else {
      strangeReads = 0
      if ((await refusalToasts(page).count()) > 0) return 'refused'
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: after 45 s the edit had neither landed nor been refused — the file still holds the outside edit alone ` +
          'and the user was never told why their change is missing.',
      )
    }
    await page.waitForTimeout(150)
  }
}

/**
 * Hold the first `/admin/api/studio/save` request whose batch carries an edit
 * of `kind`, and let every other one through. `release()` sends the held
 * request on to the server — AFTER the spec has changed the file under it.
 */
async function holdFirstSave(page: Page, kind: 'text' | 'delete') {
  let held: Route | null = null
  let released = false
  await page.route('**/admin/api/studio/save', async (route) => {
    if (held === null && !released && (route.request().postData() ?? '').includes(`"kind":"${kind}"`)) {
      held = route
      return
    }
    await route.continue()
  })
  return {
    isHeld: () => held !== null,
    release: async () => {
      released = true
      await held?.continue()
    },
  }
}

test.describe('Phase 1 exit gate — an outside edit never redirects a canvas write', () => {
  test.setTimeout(240_000)

  test('outside edit, then a text edit, a Delete and an undo on the canvas: the file changes exactly where intended', async ({ page }) => {
    const fixture = authorFixture('__e2e-phase1-exit-gate')
    const { canvasRoot, content } = await openBoard(page, fixture, true)

    writeOutside(fixture)

    // P1-D: the board re-reads the file by itself, and every id moves with it.
    await expect(content.locator('p', { hasText: 'Zero' }), 'the canvas never noticed the outside edit').toBeVisible({
      timeout: 20_000,
    })
    const two = paragraph(content, AFTER_OUTSIDE_EDIT, 3)
    await expect(two, '"Two" is not at its new address after the outside edit').toHaveText('Two', { timeout: 20_000 })

    // A value edit on "Two".
    await appendTextInline(page, canvasRoot, content, two)
    const afterText = withTwoEdited(AFTER_OUTSIDE_EDIT)
    await expect
      .poll(() => readPage(fixture), { message: 'the text edit never landed on "Two" alone', timeout: 30_000 })
      .toBe(afterText)

    // A Delete on "Three".
    const three = paragraph(content, afterText, 4)
    await expect(three).toHaveText('Three')
    await panIntoView(page, canvasRoot, three, 80)
    await clickInFrame(page, three)
    await page.keyboard.press('Delete')
    const afterDelete = withoutThree(afterText)
    await expect
      .poll(() => readPage(fixture), { message: 'the Delete never landed on "Three" alone', timeout: 30_000 })
      .toBe(afterDelete)
    await expect(content.locator('p', { hasText: 'Three' }), 'the canvas still shows the deleted element').toHaveCount(0, {
      timeout: 20_000,
    })

    // ⌘Z puts "Three" back — byte for byte — without touching the outside edit or the text edit.
    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect
      .poll(() => readPage(fixture), { message: 'undoing the Delete did not restore the file exactly', timeout: 30_000 })
      .toBe(afterText)
    await expect(content.locator('p', { hasText: 'Three' })).toHaveCount(1, { timeout: 20_000 })

    // Recovered silently: nothing the user did was refused.
    await expect(refusalToasts(page)).toHaveCount(0)
  })

  test('race — the outside edit lands while a text edit is still PENDING: it reaches "Two", or is refused', async ({ page }) => {
    const fixture = authorFixture('__e2e-phase1-race-pending')
    // Autosave off: the edit stays pending in the store until something flushes it.
    const { canvasRoot, content } = await openBoard(page, fixture, false)

    const two = paragraph(content, FIXTURE_PAGE, 2)
    await appendTextInline(page, canvasRoot, content, two)
    expect(readPage(fixture), 'the text edit was written before the outside edit — nothing was pending').toBe(FIXTURE_PAGE)

    // The pending edit names "Two" by its OLD line, which now holds "Zero".
    writeOutside(fixture)

    const outcome = await settleOnDisk(page, fixture, {
      untouched: AFTER_OUTSIDE_EDIT,
      landed: withTwoEdited(AFTER_OUTSIDE_EDIT),
      what: 'a pending text edit on "Two" racing an outside edit',
    })
    test.info().annotations.push({ type: 'race outcome (pending text edit)', description: outcome })
    if (outcome === 'landed') await expect(refusalToasts(page)).toHaveCount(0)
    await expect(content.locator('p', { hasText: 'Zero' }), 'the canvas never re-read the outside edit').toBeVisible({
      timeout: 20_000,
    })
  })

  test('race — the outside edit lands while a text edit is IN FLIGHT: it reaches "Two", or is refused', async ({ page }) => {
    const fixture = authorFixture('__e2e-phase1-race-inflight-text')
    const hold = await holdFirstSave(page, 'text')
    const { canvasRoot, content } = await openBoard(page, fixture, true)

    await appendTextInline(page, canvasRoot, content, paragraph(content, FIXTURE_PAGE, 2))
    await expect.poll(hold.isHeld, { message: 'the text edit never went out as a save', timeout: 30_000 }).toBe(true)

    // The request is on the wire, carrying "Two"'s OLD address. Change the file under it, then let it arrive.
    writeOutside(fixture)
    await hold.release()

    const outcome = await settleOnDisk(page, fixture, {
      untouched: AFTER_OUTSIDE_EDIT,
      landed: withTwoEdited(AFTER_OUTSIDE_EDIT),
      what: 'an in-flight text edit on "Two" racing an outside edit',
    })
    test.info().annotations.push({ type: 'race outcome (in-flight text edit)', description: outcome })
    if (outcome === 'landed') await expect(refusalToasts(page)).toHaveCount(0)
  })

  test('race — the outside edit lands while a Delete is IN FLIGHT: it removes "Three", or is refused', async ({ page }) => {
    const fixture = authorFixture('__e2e-phase1-race-inflight-delete')
    const hold = await holdFirstSave(page, 'delete')
    const { canvasRoot, content } = await openBoard(page, fixture, true)

    const three = paragraph(content, FIXTURE_PAGE, 3)
    await expect(three).toHaveText('Three')
    await panIntoView(page, canvasRoot, three, 80)
    await clickInFrame(page, three)
    await page.keyboard.press('Delete')
    await expect.poll(hold.isHeld, { message: 'the Delete never went out as a save', timeout: 30_000 }).toBe(true)

    // The delete names "Three"'s OLD line, which now holds "One".
    writeOutside(fixture)
    await hold.release()

    const outcome = await settleOnDisk(page, fixture, {
      untouched: AFTER_OUTSIDE_EDIT,
      landed: withoutThree(AFTER_OUTSIDE_EDIT),
      what: 'an in-flight Delete of "Three" racing an outside edit',
    })
    test.info().annotations.push({ type: 'race outcome (in-flight delete)', description: outcome })
    if (outcome === 'landed') {
      await expect(refusalToasts(page)).toHaveCount(0)
      await expect(content.locator('p', { hasText: 'Three' }), 'the canvas disagrees with disk').toHaveCount(0, { timeout: 20_000 })
    }
    await expect(content.locator('p', { hasText: 'One' })).toHaveCount(1)
  })
})
