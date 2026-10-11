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
 *   #12 a new board opens with its name field up
 *   #14 Ctrl+D and Delete work on a selected frame
 *   #13 a page made from the Pages panel opens with its frame in view
 *   #15 a click on a page row brings an off-screen frame into view
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


const header = (page: Page, pageId: string, nth = 0): Locator =>
  page.locator(`[data-page-id="${pageId}"]`).nth(nth).getByTestId('board-frame-header')

async function mouseRightClick(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centreOf(target)
  await page.mouse.move(x, y)
  await page.mouse.click(x, y, { button: 'right' })
}

const readBoards = (): { boards: Array<{ frames: Frame[]; notes: Array<{ text: string }>; layers?: unknown[] }> } =>
  JSON.parse(readText('.studio/boards.json'))

const overlap = (a: Frame, b: Frame): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test.describe('#7 duplicated frames', () => {
  test.setTimeout(240_000)

  test('land in free space to the right, never on the next frame, and undo to the original bytes', async ({ page }) => {
    // About starts 100 px right of Home: a copy placed one gap (48) past Home sits ON About.
    const original = boardsJson([frame('f-home', 'home', 0), frame('f-about', 'about', 500)])
    makeFixture({ 'pages/Home.tsx': HOME, 'pages/About.tsx': ABOUT, '.studio/boards.json': original })
    await openBoard(page)

    await mouseRightClick(page, header(page, 'home'))
    await mouseClick(page, page.getByRole('menuitem', { name: 'Duplicate frame' }))
    await expectBoardsOnDisk((text) => (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.frames.length === 3, 'Duplicate frame never reached boards.json')

    await mouseRightClick(page, header(page, 'home'))
    await mouseClick(page, page.getByRole('menuitem', { name: /^Duplicate as RTL$/ }))
    await expectBoardsOnDisk((text) => (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.frames.length === 4, 'Duplicate as RTL never reached boards.json')

    const frames = readBoards().boards[0]!.frames
    for (let i = 0; i < frames.length; i += 1) {
      for (let j = i + 1; j < frames.length; j += 1) {
        expect(overlap(frames[i]!, frames[j]!), `frames ${frames[i]!.id} and ${frames[j]!.id} overlap`).toBe(false)
      }
    }
    // Both copies are to the right of the source, on its row.
    const copies = frames.filter((f) => f.pageId === 'home' && f.id !== 'f-home')
    expect(copies).toHaveLength(2)
    for (const copy of copies) {
      expect(copy.x).toBeGreaterThan(0)
      expect(copy.y).toBe(0)
    }

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expectBoardsOnDisk((text) => text === original, 'two undos did not restore the boards file byte for byte')
  })
})

test.describe('#8 frame presets', () => {
  test.setTimeout(240_000)

  test('a mouse click on a preset option resizes the frame', async ({ page }) => {
    const original = boardsJson([frame('f-home', 'home', 0)])
    makeFixture({ 'pages/Home.tsx': HOME, '.studio/boards.json': original })
    await openBoard(page)

    await mouseClick(page, header(page, 'home'))
    const select = page.getByRole('combobox', { name: 'Device size preset' })
    await mouseClick(page, select)
    const option = page.getByRole('option', { name: /^iPad \(768/ }).first()
    await expect(option).toBeVisible({ timeout: 10_000 })
    // Where the audit clicked: the option's own centre, with no scrolling. It must lie inside
    // the open menu - below the menu's edge the press lands on the panel under it.
    const menuBox = (await page.getByRole('listbox').boundingBox())!
    const optionBox = (await option.boundingBox())!
    expect(optionBox.y + optionBox.height, 'the iPad option sits below the fold of the preset menu').toBeLessThanOrEqual(menuBox.y + menuBox.height)
    await mouseClick(page, option)

    await expectBoardsOnDisk((text) => {
      const home = (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.frames[0]!
      return home.width === 768 && home.height === 1024
    }, 'clicking the iPad preset did not resize the frame on disk')
    await expect(page.getByRole('textbox', { name: 'Frame width' })).toHaveValue('768')

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await expectBoardsOnDisk((text) => text === original, 'undo did not restore the boards file byte for byte')
  })
})

test.describe('#10 sticky note text', () => {
  test.setTimeout(240_000)

  test('Escape keeps what was typed, on screen, on disk and after a reload', async ({ page }) => {
    makeFixture({ 'pages/Home.tsx': HOME, '.studio/boards.json': boardsJson([frame('f-home', 'home', 0)]) })
    await openBoard(page)

    await mouseClick(page, page.getByRole('button', { name: '+ Sticky note' }))
    const note = page.getByTestId('sticky-note')
    await expect(note).toHaveCount(1)
    await page.keyboard.type('Second')
    await page.keyboard.press('Escape')

    await expect(note).toContainText('Second')
    await expectBoardsOnDisk((text) => (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.notes[0]?.text === 'Second', 'the note text was not saved when Escape closed the editor')

    await page.reload()
    await openBoard(page)
    await expect(page.getByTestId('sticky-note')).toContainText('Second', { timeout: 30_000 })
  })
})

test.describe('#9 R then Enter', () => {
  test.setTimeout(240_000)

  const pageSources = (): Record<string, string> =>
    Object.fromEntries(fs.readdirSync(studioFile('pages')).map((name) => [name, readText(`pages/${name}`)]))

  test('writes into no page when none is selected; the shape becomes a loose layer on the board', async ({ page }) => {
    // The home page (Index) is the one the editor has open, and it is NOT on the board that is shown.
    makeFixture({
      'pages/Index.tsx': HOME.replace('Home', 'Index'),
      'pages/About.tsx': ABOUT,
      '.studio/boards.json': boardsJson([frame('f-about', 'about', 0)]),
    })
    const canvasRoot = await openBoard(page)
    const before = pageSources()

    // Nothing selected: click empty canvas well away from the frame, then R, Enter.
    const rootBox = (await canvasRoot.boundingBox())!
    await page.mouse.click(rootBox.x + rootBox.width - 60, rootBox.y + rootBox.height - 60)
    await page.keyboard.press('r')
    await page.keyboard.press('Enter')

    await expect
      .poll(() => fs.existsSync(studioFile('.studio/canvas')) && fs.readdirSync(studioFile('.studio/canvas')).length, {
        timeout: 20_000,
        message: 'the rectangle did not become a loose layer on the board',
      })
      .toBe(1)
    await expectBoardsOnDisk((text) => (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.layers?.length === 1, 'the loose layer has no placement on the board')
    expect(pageSources(), 'a page source changed - the shape was written into a page that is not on the board').toEqual(before)
  })
})

test.describe('#11 prototype links', () => {
  test.setTimeout(300_000)

  // A link as an older build wrote it: a bare "click" trigger and an `origin`. The reader repairs both, so a
  // save that re-serialized the parsed file would rewrite this entry.
  const LEGACY_FILE = `{
  "version": 1,
  "links": [
    {
      "id": "legacy-link",
      "origin": "design",
      "source": {
        "pageId": "about",
        "node": {
          "nodeId": "pages/About.tsx:3:7",
          "indexPath": [
            0
          ],
          "moduleId": "base.text",
          "textSnippet": "About us"
        }
      },
      "trigger": "click",
      "action": "navigate",
      "targetPageId": "home",
      "transition": "slide-left"
    }
  ]
}
`
  const FILE_TAIL = '\n  ]\n}\n'

  test('one link is one write, one undo step, and no other link is rewritten', async ({ page }) => {
    makeFixture({
      'pages/Home.tsx': HOME,
      'pages/About.tsx': ABOUT,
      '.studio/boards.json': boardsJson([frame('f-home', 'home', 0), frame('f-about', 'about', 500)]),
      '.studio/prototype.json': LEGACY_FILE,
    })
    await page.setViewportSize({ width: 1600, height: 960 })
    const canvasRoot = await openBoard(page)
    // Shift+1: fit the whole board, so both frames are on screen and the drop target is real.
    await canvasRoot.focus()
    await page.keyboard.press('Shift+1')
    await page.waitForTimeout(600)
    const homeFrame = page.locator('[data-page-id="home"]').first()
    await expect(visibleCanvasIframe(homeFrame)).toBeVisible({ timeout: 60_000 })

    await mouseClick(page, page.getByTestId('canvas-prototype-toggle'))
    await selectInFrame(page, canvasContentFrame(homeFrame).getByText('Welcome home'))
    const handle = page.getByTestId('prototype-link-handle')
    const from = await centreOf(handle)
    const aboutFrame = page.locator('[data-page-id="about"]').first()
    const to = await centreOf(aboutFrame)

    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 30, from.y + 10, { steps: 4 })
    await page.mouse.move(to.x, to.y, { steps: 18 })
    await page.waitForTimeout(250)
    await page.mouse.up()

    await expect
      .poll(() => (JSON.parse(readText('.studio/prototype.json')) as { links: unknown[] }).links.length, { timeout: 20_000, message: 'the new link never reached .studio/prototype.json' })
      .toBe(2)
    const written = readText('.studio/prototype.json')
    expect(
      written.startsWith(LEGACY_FILE.slice(0, LEGACY_FILE.length - FILE_TAIL.length) + ','),
      'saving the new link rewrote the existing one (its bytes changed):\n' + written,
    ).toBe(true)

    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => readText('.studio/prototype.json'), { timeout: 20_000, message: 'Ctrl+Z did not take the link back, byte for byte' }).toBe(LEGACY_FILE)

    await page.keyboard.press('Control+Shift+z')
    await expect
      .poll(() => readText('.studio/prototype.json'), { timeout: 20_000, message: 'redo did not put the link back' })
      .toBe(written)

    await page.reload()
    await openBoard(page)
    await expect
      .poll(() => (JSON.parse(readText('.studio/prototype.json')) as { links: unknown[] }).links.length)
      .toBe(2)
  })
})

test.describe('#12 new board', () => {
  test.setTimeout(240_000)

  test('the first thing typed names it, and the name survives a reload', async ({ page }) => {
    makeFixture({ 'pages/Home.tsx': HOME, '.studio/boards.json': boardsJson([frame('f-home', 'home', 0)]) })
    await openBoard(page)

    await mouseClick(page, page.getByRole('button', { name: 'New board' }))
    // No click in the name field: the typed letters must land in it (they used to arm tools: R, F, ...).
    await page.keyboard.type('Flows')
    await page.keyboard.press('Enter')

    await expectBoardsOnDisk(
      (text) => (JSON.parse(text) as { boards: Array<{ name: string }> }).boards.some((board) => board.name === 'Flows'),
      'the typed name never reached .studio/boards.json',
    )
    expect((JSON.parse(readText('.studio/boards.json')) as { boards: unknown[] }).boards).toHaveLength(2)

    await page.reload()
    await openBoard(page)
    await expect(page.getByTestId('studio-boards-list').getByRole('treeitem', { name: 'Flows' })).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('#14 frame keyboard', () => {
  test.setTimeout(240_000)

  test('Ctrl+D duplicates a selected frame and Delete takes it off the board, each in one undo step', async ({ page }) => {
    const original = boardsJson([frame('f-home', 'home', 0), frame('f-about', 'about', 900)])
    makeFixture({ 'pages/Home.tsx': HOME, 'pages/About.tsx': ABOUT, '.studio/boards.json': original })
    await openBoard(page)

    await mouseClick(page, header(page, 'home'))
    await page.keyboard.press('Control+d')
    await expectBoardsOnDisk((text) => (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.frames.length === 3, 'Ctrl+D did not duplicate the selected frame')
    const withCopy = readText('.studio/boards.json')

    await page.keyboard.press('Delete')
    await expectBoardsOnDisk((text) => (JSON.parse(text) as ReturnType<typeof readBoards>).boards[0]!.frames.length === 2, 'Delete did not take the selected frame off the board')
    expect(fs.existsSync(studioFile('pages/Home.tsx')), 'Delete must never remove the page file').toBe(true)

    await page.keyboard.press('Control+z')
    await expectBoardsOnDisk((text) => text === withCopy, 'undo of Delete did not restore the board byte for byte')
    await page.keyboard.press('Control+z')
    await expectBoardsOnDisk((text) => text === original, 'undo of Ctrl+D did not restore the board byte for byte')
  })
})

test.describe('#13 new page', () => {
  test.setTimeout(300_000)

  test('is opened and shown whole in the middle of the canvas, not left at the board edge', async ({ page }) => {
    makeFixture({ 'pages/Home.tsx': HOME, '.studio/boards.json': boardsJson([frame('f-home', 'home', 0)]) })
    const canvasRoot = await openBoard(page)

    await mouseClick(page, page.getByRole('button', { name: 'Add page' }).first())
    await mouseClick(page, page.getByRole('menuitem', { name: /Screen/ }).first())

    await expect.poll(() => fs.existsSync(studioFile('pages/Page.tsx')), { timeout: 60_000, message: 'the page file was never written' }).toBe(true)
    const created = page.locator('[data-page-id="page"]').first()
    await expect(created).toBeAttached({ timeout: 60_000 })
    const rootBox = (await canvasRoot.boundingBox())!
    await expect
      .poll(async () => {
        const box = await created.boundingBox()
        if (!box) return false
        const centre = box.x + box.width / 2
        // Centred in the visible canvas, give or take the panel inset - never at the far edge.
        return centre > rootBox.x + rootBox.width * 0.2 && centre < rootBox.x + rootBox.width * 0.8
      }, { timeout: 30_000, message: 'the new page frame was left at the edge of the board, out of the middle of the canvas' })
      .toBe(true)
  })
})

test.describe('#15 page row click', () => {
  test.setTimeout(240_000)

  test('brings the page frame into view when the board is looking elsewhere', async ({ page }) => {
    makeFixture({
      'pages/Home.tsx': HOME,
      'pages/About.tsx': ABOUT,
      '.studio/boards.json': boardsJson([frame('f-home', 'home', 0), frame('f-about', 'about', 4000)]),
    })
    const canvasRoot = await openBoard(page)
    const aboutFrame = page.locator('[data-page-id="about"]').first()
    const rootBox = (await canvasRoot.boundingBox())!
    const insideCanvas = async (): Promise<boolean> => {
      const box = await aboutFrame.boundingBox()
      return box !== null && box.x < rootBox.x + rootBox.width && box.x + box.width > rootBox.x
    }
    expect(await insideCanvas(), 'the fixture must start with the About frame far off screen').toBe(false)

    await mouseClick(page, pageRow(page, 'About'))

    await expect.poll(insideCanvas, { timeout: 15_000, message: 'the About frame is still off screen after its row was clicked' }).toBe(true)
    await expect(visibleCanvasIframe(aboutFrame)).toBeVisible({ timeout: 60_000 })
  })
})

export { canvasContentFrame, mouseClick }
