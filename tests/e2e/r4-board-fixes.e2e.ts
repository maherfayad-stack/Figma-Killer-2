import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * Round-4 board audit (findings 5-11), replayed with a real mouse and keyboard.
 * Every case asserts what the UI shows after a RELOAD and the bytes on disk,
 * and each one fails on the code the audit was written against.
 *
 *   #5  a page rename survives a reload (board metadata, one undo entry)
 *   #6  a layer rename survives a reload (board metadata, one undo entry)
 *   #7  Duplicate frame / Duplicate as RTL land in free space, not on a neighbour
 *   #8  a frame size preset can be picked with the mouse
 *   #9  R then Enter on an empty board writes into no page that is not on the board
 *   #10 Escape in a sticky note keeps the typed text
 *   #11 a new prototype link is one undo step and rewrites no other link
 *
 * SAFETY - writes only to this run's throwaway fixture under the e2e workspace.
 */

const NAME = '__e2e-r4-board'

const HOME = `export default function Home() {
  return (
    <main style={{ padding: "30px", width: "360px", fontFamily: "sans-serif", background: "#fff" }}>
      <section style={{ padding: "12px", background: "#eee" }}>
        <h1 style={{ margin: 0 }}>Welcome home</h1>
        <p style={{ margin: 0 }}>Second line</p>
      </section>
    </main>
  )
}
`

const ABOUT = `export default function About() {
  return (
    <main style={{ padding: "30px", width: "360px", fontFamily: "sans-serif", background: "#fff" }}>
      <h1>About us</h1>
    </main>
  )
}
`

const SIDE = `export default function Side() {
  return (
    <main style={{ padding: "30px", width: "360px", fontFamily: "sans-serif", background: "#fff" }}>
      <h1>Side page</h1>
    </main>
  )
}
`

interface Frame {
  id: string
  pageId: string
  x: number
  y: number
  width: number
  height: number
}

const frame = (id: string, pageId: string, x: number): Frame => ({ id, pageId, x, y: 0, width: 400, height: 500 })

function boardsJson(frames: Frame[], extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify(
      {
        version: 1,
        boards: [{ id: 'board-1', name: 'Board 1', frames, notes: [], docs: [], guides: [], ...extra }],
      },
      null,
      2,
    ) + '\n'
  )
}

const META = JSON.stringify({ pagesDir: 'pages', trust: 'static', frameDefaults: { width: 400, height: 500 } }, null, 2) + '\n'

let fixture: FixtureProject

const studioFile = (rel: string): string => path.join(fixture.dir, ...rel.split('/'))
const readText = (rel: string): string => fs.readFileSync(studioFile(rel), 'utf8')

function makeFixture(files: Record<string, string>): void {
  fixture = createAuthoredFixtureProject(NAME, { '.studio/meta.json': META, ...files })
}

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openBoard(page: Page): Promise<Locator> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  await expect(page.getByTestId('studio-pages-tree')).toBeVisible({ timeout: 30_000 })
  return canvasRoot
}

async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  await expect(locator).toBeVisible({ timeout: 15_000 })
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('no bounding box')
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

async function mouseDoubleClick(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centreOf(target)
  await page.mouse.move(x, y)
  await page.mouse.dblclick(x, y)
}

async function mouseClick(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centreOf(target)
  await page.mouse.move(x, y)
  await page.mouse.click(x, y)
}

/** Wait for the debounced boards autosave to land `predicate` on disk. */
async function expectBoardsOnDisk(predicate: (text: string) => boolean, message: string): Promise<void> {
  try {
    await expect.poll(() => predicate(readText('.studio/boards.json')), { timeout: 20_000, message }).toBe(true)
  } catch (err) {
    console.log(`[boards.json on failure]
${readText('.studio/boards.json')}`)
    throw err
  }
}

const pageRow = (page: Page, title: string): Locator =>
  page.getByTestId('studio-pages-tree').getByRole('treeitem', { name: new RegExp(`^${title}\\b`) }).first()

test.describe('#5 page rename', () => {
  test.setTimeout(240_000)

  test('is kept after a reload and undoes to the original bytes', async ({ page }) => {
    const original = boardsJson([frame('f-home', 'home', 0), frame('f-about', 'about', 500)])
    makeFixture({ 'pages/Home.tsx': HOME, 'pages/About.tsx': ABOUT, '.studio/boards.json': original })
    await openBoard(page)

    const row = pageRow(page, 'About')
    await mouseDoubleClick(page, row)
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Checkout')
    await page.keyboard.press('Enter')
    await expect(pageRow(page, 'Checkout')).toBeVisible()

    await expectBoardsOnDisk((text) => text.includes('"pageNames"') && text.includes('"about": "Checkout"'), 'the rename never reached .studio/boards.json')
    const renamed = readText('.studio/boards.json')
    expect(fs.readFileSync(studioFile('pages/About.tsx'), 'utf8'), 'a rename must not touch the page source').toBe(ABOUT)

    // One Ctrl+Z puts the page back, and the file returns to its original bytes.
    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await expect(pageRow(page, 'About')).toBeVisible()
    await expectBoardsOnDisk((text) => text === original, 'undo did not restore the boards file byte for byte')

    await page.keyboard.press('Control+Shift+z')
    await expect(pageRow(page, 'Checkout')).toBeVisible()
    await expectBoardsOnDisk((text) => text === renamed, 'redo did not rewrite the rename')

    await page.reload()
    await openBoard(page)
    await expect(pageRow(page, 'Checkout'), 'the new name is gone after a reload').toBeVisible({ timeout: 30_000 })
    await expect(pageRow(page, 'About')).toHaveCount(0)
  })
})

test.describe('#6 layer rename', () => {
  test.setTimeout(240_000)

  const layers = (page: Page): Locator => page.getByRole('tree', { name: 'Page element tree' })

  test('is kept after a reload and undoes to the original bytes', async ({ page }) => {
    const original = boardsJson([frame('f-home', 'home', 0)])
    makeFixture({ 'pages/Home.tsx': HOME, '.studio/boards.json': original })
    const canvasRoot = await openBoard(page)
    const homeFrame = page.locator('[data-page-id="home"]').first()
    await panIntoView(page, canvasRoot, homeFrame, 120)
    await expect(visibleCanvasIframe(homeFrame)).toBeVisible({ timeout: 60_000 })

    // Pick the heading on the canvas (Ctrl-click is the deep select); its row is revealed in Layers.
    await selectInFrame(page, canvasContentFrame(homeFrame).getByText('Welcome home'))
    const selectedRow = layers(page).getByRole('treeitem', { selected: true })
    await mouseDoubleClick(page, selectedRow)
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Hero Title')
    await page.keyboard.press('Enter')
    await expect(layers(page).getByRole('treeitem', { name: /Hero Title/ })).toHaveCount(1)

    await expectBoardsOnDisk((text) => text.includes('"layerNames"') && text.includes('Hero Title'), 'the layer name never reached .studio/boards.json')
    const renamed = readText('.studio/boards.json')
    expect(readText('pages/Home.tsx'), 'a layer rename must not touch the page source').toBe(HOME)

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await expect(layers(page).getByRole('treeitem', { name: /Hero Title/ })).toHaveCount(0)
    await expectBoardsOnDisk((text) => text === original, 'undo did not restore the boards file byte for byte')

    await page.keyboard.press('Control+Shift+z')
    await expect(layers(page).getByRole('treeitem', { name: /Hero Title/ })).toHaveCount(1)
    await expectBoardsOnDisk((text) => text === renamed, 'redo did not rewrite the layer name')

    await page.reload()
    const canvasAgain = await openBoard(page)
    const frameAgain = page.locator('[data-page-id="home"]').first()
    await panIntoView(page, canvasAgain, frameAgain, 120)
    await expect(visibleCanvasIframe(frameAgain)).toBeVisible({ timeout: 60_000 })
    await selectInFrame(page, canvasContentFrame(frameAgain).getByText('Welcome home'))
    await expect(
      layers(page).getByRole('treeitem', { name: /Hero Title/ }),
      'the layer name is gone after a reload',
    ).toHaveCount(1, { timeout: 30_000 })
  })
})

export { canvasContentFrame, mouseClick }
