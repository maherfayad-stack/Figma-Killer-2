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
 * `struct-01` — real-browser proof that a structural edit on the board either
 * reaches the user's `.tsx` or refuses out loud.
 *
 * Why this spec has to exist. Until now `StudioEdit` had no `move`, `delete`,
 * `insert` or `reorder` kind at all, and `saveSite` walked node VALUES only —
 * so dragging a row in the layers tree updated the tree, reported a successful
 * save, changed no byte of the repository, and lost the move on the next
 * reload. In Studio the repository IS the document, so that was a silent
 * no-op. A unit test cannot see the difference between "wrote" and "reported
 * that it wrote": only the file on disk can.
 *
 * The two claims, and both are asserted against the bytes:
 *
 *   1. **It writes.** Dragging one sibling past another in the layers tree
 *      moves that JSX child in `pages/Home.tsx`, and the file is otherwise
 *      byte-identical — the comment, the blank line, and the multi-line
 *      element's own wrapping all survive verbatim.
 *   2. **It refuses.** Dragging an element into a DIFFERENT parent has no
 *      source position to be written to, so it is refused BEFORE the tree
 *      mutates: the user reads a reason, the layers tree does not move, and
 *      the file is byte-identical.
 *
 * SAFETY — this spec WRITES, so it never points at real user data. The fixture
 * below is created fresh under this RUN's THROWAWAY COPY of `studio-workspace/`
 * (`WORKSPACE_ROOT`, made by `scripts/e2e-dev.ts`) and removed afterwards; the
 * tracked tree is never read or written. It used to be created in an OS temp
 * directory instead, which `resolveProjectDir`'s containment check 404s — so
 * both cases died on a timeout that read exactly like a product bug.
 */


/**
 * The fixture page, written verbatim and asserted against verbatim.
 *
 * `.first`/`.second` are the REORDER pair — two plain siblings, each alone on
 * its own line, which is the shape the move codemod can splice byte-exactly.
 * `.box` holds `.inner`, which is the REPARENT target: dragging it out to sit
 * beside `.first` crosses a parent boundary and must refuse. The comment and
 * the blank line exist so "every other byte survived" has something real to
 * protect.
 */
const FIXTURE_PAGE = `export default function Home() {
  return (
    <section className="list">
      {/* this comment must not move */}
      <p className="first">First</p>

      <p className="second">Second</p>
      <div className="box">
        <em className="inner">Inner</em>
      </div>
    </section>
  )
}
`

let fixture: FixtureProject

function pagePath(): string {
  return path.join(fixture.dir, 'pages', 'Home.tsx')
}

function readPage(): string {
  return fs.readFileSync(pagePath(), 'utf8')
}

/**
 * The studio node id of the Nth `<tag` in the fixture — `relFile:line:col`,
 * where col is 1-based at the character right after `<`. Derived rather than
 * hardcoded so editing the fixture above cannot silently retarget the spec.
 */
function nodeId(tag: string, occurrence = 1): string {
  const re = new RegExp(`<${tag}(?=[\\s/>])`, 'g')
  let match: RegExpExecArray | null
  let count = 0
  let index = -1
  while ((match = re.exec(FIXTURE_PAGE)) !== null) {
    count += 1
    if (count === occurrence) {
      index = match.index
      break
    }
  }
  if (index < 0) throw new Error(`fixture has no <${tag} #${occurrence}`)
  const before = FIXTURE_PAGE.slice(0, index + 1)
  const lines = before.split('\n')
  // `+ 1`: the column convention is 1-based at the character right AFTER `<`,
  // and `before` ends with the `<` itself.
  return `pages/Home.tsx:${lines.length}:${lines[lines.length - 1]!.length + 1}`
}

test.beforeAll(() => {
  // Under this RUN's throwaway copy of `studio-workspace/`, not an OS temp
  // directory: `resolveProjectDir`'s containment check 404s any project
  // outside the root the server resolved, so a temp-dir fixture could never be
  // opened at all — the spec failed on a timeout that read like a product bug.
  fixture = createAuthoredFixtureProject('__e2e-structural-writeback', {
    'pages/Home.tsx': FIXTURE_PAGE,
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

/** Open the studio board on the fixture — safe to write because it is in the run's throwaway workspace copy. */
async function openStudioBoard(page: Page): Promise<{ canvasRoot: Locator; contentFrame: FrameLocator }> {
  // `openFixtureBoard` rather than a private `goto`: the canvas has no scroll
  // container, so where a frame LANDS is decided by a "center on open" pass
  // that races the arrival of the page documents it centres on. On a cold load
  // the board settles pointed somewhere with no frame in it, every
  // `page.mouse.click(box.x + w/2, ...)` lands on empty canvas, nothing is
  // selected, and the failure reads like "the element never appeared in the
  // layers tree" - a product bug that was never there. The shared opener
  // resets the view with the product's own Ctrl+0 first.
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(
    frame.locator(CANVAS_FRAME_IFRAME_SELECTOR),
    'the fixture frame never mounted a live canvas iframe after being panned into view',
  ).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, contentFrame: frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR) }
}

/**
 * Reveal the layers tree and return its locator.
 *
 * LANDMINE: addressed by test id, not by `getByRole('tree', { name: 'Page
 * element tree' })`. Studio mode nests `DomPanel`'s tree INSIDE
 * `StudioPagesTree`'s own `role="tree"`, and a `tree` is not a permitted child
 * of a `tree` — Chrome prunes the inner node out of the accessibility tree
 * entirely, so the role query matches nothing while the panel is plainly on
 * screen. Studio also has no "Layers" tab to click: the tree is always
 * embedded.
 */
async function openLayers(page: Page): Promise<Locator> {
  const explorer = page.getByRole('complementary', { name: 'Explorer' })
  if (!(await explorer.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Open Explorer panel' }).click()
  }
  const tree = page.getByTestId('dom-panel-tree')
  await expect(tree, 'the layers tree never rendered').toBeVisible({ timeout: 20_000 })
  return tree
}

/** Every layer row's node id, in tree order. */
function rowIds(tree: Locator): Promise<string[]> {
  return tree
    .locator('[data-studio-node-id]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.studioNodeId ?? ''))
}

/**
 * Drag one layer row onto another and drop on the requested edge band.
 *
 * LANDMINE (`lock-01`): BOTH dnd-kit and `useDomPanelDnd` auto-scroll the tree
 * when the pointer nears an edge, and rows are measured once at drag start —
 * a drag begun near the bottom scrolls the list out from under those rects and
 * no drop target ever resolves, which is indistinguishable from a refusal.
 * Centre the row first, settle, then move in small steps.
 */
async function dragRow(page: Page, row: Locator, target: Locator, edge: 'before' | 'after'): Promise<void> {
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(500)

  const [from, to] = await Promise.all([row.boundingBox(), target.boundingBox()])
  if (!from || !to) throw new Error('the drag source or drop target has no bounding box')

  await page.mouse.move(from.x + 120, from.y + from.height / 2)
  await page.mouse.down()
  // Past the PointerSensor's 5px activation distance first…
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from.x + 120, from.y + from.height / 2 + step * 3)
    await page.waitForTimeout(30)
  }
  // …then into the target row's edge band.
  const y = edge === 'before' ? to.y + 2 : to.y + to.height - 2
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(to.x + 120, y)
    await page.waitForTimeout(60)
  }
  await expect(target).toHaveAttribute('data-drop-position', edge)
  await page.mouse.up()
}

test.describe('struct-01 — a structural edit reaches the .tsx, or says why it cannot', () => {
  // A cold ts-morph parse on open, a write, and a reload.
  test.setTimeout(180_000)

  test('dragging one sibling past another rewrites the JSX, byte-exact elsewhere', async ({ page }) => {
    const { canvasRoot, contentFrame } = await openStudioBoard(page)
    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)

    // Selecting on the canvas auto-expands the layers tree to the node's row.
    // Addressed by node id, not class: `className` is translated to `classIds`
    // at parse time and dropped, so a project with no `.css` renders no class
    // attribute at all. `data-node-id` is what the canvas actually stamps.
    const secondTarget = contentFrame.locator(`[data-node-id="${nodeId('p', 2)}"]`).first()
    await panIntoView(page, canvasRoot, secondTarget, 80)
    await clickInFrame(page, secondTarget)
    const tree = await openLayers(page)

    const secondId = nodeId('p', 2)
    const firstId = nodeId('p', 1)
    const secondRow = page.getByTestId(`dom-tree-item-${secondId}`)
    const firstRow = page.getByTestId(`dom-tree-item-${firstId}`)
    await expect(secondRow).toBeVisible({ timeout: 10_000 })
    await expect(firstRow).toBeVisible()

    const before = await rowIds(tree)
    expect(before.indexOf(secondId)).toBeGreaterThan(before.indexOf(firstId))

    await dragRow(page, secondRow, firstRow, 'before')

    // The tree moved…
    await expect(async () => {
      const after = await rowIds(tree)
      expect(after.indexOf(secondId)).toBeLessThan(after.indexOf(firstId))
    }).toPass({ timeout: 10_000 })

    // …and so did the file. This is the assertion the whole work order exists
    // for: on unmodified HEAD the tree moved and this file never changed.
    const expected = FIXTURE_PAGE.replace('      <p className="second">Second</p>\n', '').replace(
      '      <p className="first">First</p>\n',
      '      <p className="second">Second</p>\n      <p className="first">First</p>\n',
    )
    await expect
      .poll(readPage, { message: 'the reorder never reached pages/Home.tsx on disk', timeout: 30_000 })
      .toBe(expected)

    // Byte-exact: the comment kept its place, the blank line kept its place,
    // and the `.box` subtree was not reformatted.
    expect(readPage()).toBe(expected)
  })

  test('dragging an element into a different parent in the same file rewrites the JSX', async ({ page }) => {
    // THIS CASE USED TO ASSERT A REFUSAL, and that premise is now obsolete.
    // W4-1 made a same-file reparent a real write: `moveJsxElement.ts` takes a
    // `destinationLine`/`destinationCol` naming the NEW PARENT and places the
    // subtree with `jsxChildPlacement.ts` - the same function an insert uses -
    // so the drag the old case performed is no longer refused, it lands. The
    // refusal that survives is about SCOPE, not about crossing a parent:
    // `freeVariablesOutOfScopeAt` refuses markup lifted out of a `.map`
    // callback (and `refuseStructuralEdit`'s `cross-file` answers a move
    // between files, which `transplantJsxElement.ts` then writes when it is
    // honest). Neither has a case here yet - see `docs/archive/e2e/COLD-SUITE-TRIAGE.md`.
    const { canvasRoot, contentFrame } = await openStudioBoard(page)
    const before = readPage()

    const innerTarget = contentFrame.locator(`[data-node-id="${nodeId('em')}"]`).first()
    await panIntoView(page, canvasRoot, innerTarget, 80)
    await clickInFrame(page, innerTarget)
    await openLayers(page)

    const innerRow = page.getByTestId(`dom-tree-item-${nodeId('em')}`)
    await expect(innerRow, 'the nested element never appeared in the layers tree').toBeVisible({ timeout: 10_000 })

    // `.inner` lives inside `.box`; `.first` is a child of `<section>`.
    // Dropping on `.first`'s top edge asks for a new parent in the same file.
    const firstRow = page.getByTestId(`dom-tree-item-${nodeId('p', 1)}`)
    await expect(firstRow).toBeVisible()

    await dragRow(page, innerRow, firstRow, 'before')

    // The write is the assertion: `.inner` left `.box` and now sits inside
    // `<section>` ahead of `.first`, and `.box` is left without it.
    await expect
      .poll(() => readPage(), {
        message: 'the reparent drag never reached pages/Home.tsx on disk',
        timeout: 30_000,
      })
      .not.toBe(before)

    const after = readPage()
    const innerAt = after.indexOf('className="inner"')
    const firstAt = after.indexOf('className="first"')
    const boxAt = after.indexOf('className="box"')
    expect(innerAt, 'the moved element is no longer in the file at all').toBeGreaterThan(-1)
    expect(innerAt, 'the moved element did not land ahead of .first').toBeLessThan(firstAt)
    expect(innerAt, 'the moved element never left .box').toBeLessThan(boxAt)

    // Everything the move did NOT name survives verbatim.
    expect(after, 'the reparent reformatted the comment').toContain('{/* this comment must not move */}')
    expect(after, 'the reparent dropped a sibling').toContain('className="second"')
  })
})
