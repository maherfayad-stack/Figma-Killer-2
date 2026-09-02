import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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
 * below is created fresh in an OS temp directory, opened by absolute path, and
 * removed afterwards. Nothing under `studio-workspace/` is read or written.
 */

const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'

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

let fixtureDir: string

function pagePath(): string {
  return path.join(fixtureDir, 'pages', 'Home.tsx')
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
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-struct01-'))
  fs.mkdirSync(path.join(fixtureDir, 'pages'), { recursive: true })
  fs.writeFileSync(pagePath(), FIXTURE_PAGE, 'utf8')
})

test.afterAll(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
})

/** Open the studio board on the temp fixture. Safe to write only because `fixtureDir` is a throwaway. */
async function openStudioBoard(page: Page, projectDir: string): Promise<FrameLocator> {
  await page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
    window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: true }))
  }, projectDir)

  await page.goto('/admin/site?studio')
  await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 90_000 })
  const frame = page.locator('[data-page-id]').first()
  await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 30_000 })
  return frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
}

/** Click an element inside a canvas iframe with real mouse coordinates (the canvas pans by transform, so `.click()` hangs). */
async function clickInFrame(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
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
    const contentFrame = await openStudioBoard(page, fixtureDir)
    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)

    // Selecting on the canvas auto-expands the layers tree to the node's row.
    // Addressed by node id, not class: `className` is translated to `classIds`
    // at parse time and dropped, so a project with no `.css` renders no class
    // attribute at all. `data-node-id` is what the canvas actually stamps.
    await clickInFrame(page, contentFrame.locator(`[data-node-id="${nodeId('p', 2)}"]`).first())
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

  test('dragging an element into a different parent REFUSES, and touches nothing', async ({ page }) => {
    const contentFrame = await openStudioBoard(page, fixtureDir)
    const before = readPage()

    await clickInFrame(page, contentFrame.locator(`[data-node-id="${nodeId('em')}"]`).first())
    const tree = await openLayers(page)

    const innerId = nodeId('em')
    const innerRow = page.getByTestId(`dom-tree-item-${innerId}`)
    await expect(innerRow, 'the nested element never appeared in the layers tree').toBeVisible({ timeout: 10_000 })

    // `.inner` lives inside `.box`; `.first` is a child of `<section>`. Dropping
    // on `.first`'s top edge asks for a new parent, which has no source
    // position to be written to.
    const firstRow = page.getByTestId(`dom-tree-item-${nodeId('p', 1)}`)
    await expect(firstRow).toBeVisible()

    const idsBefore = await rowIds(tree)
    await dragRow(page, innerRow, firstRow, 'before')

    // The user reads a reason. `pushToast` renders with role="alert".
    const alert = page.locator('[role="alert"]', { hasText: /different parent/i })
    await expect(alert, 'a reparent drag produced no explanation at all').toBeVisible({ timeout: 15_000 })

    // Refused BEFORE mutating: the tree is exactly as it was…
    expect(await rowIds(tree), 'a refused move still reordered the layers tree').toEqual(idsBefore)
    // …and so is the file.
    expect(readPage(), 'a refused move still modified the source file').toBe(before)
  })
})
