import { expect, test, type Page, type Request } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame } from './helpers/canvasIframe'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  readToastRecorder,
  removeFixtureProject,
  selectInFrame,
  sourceNodeId,
  startToastRecorder,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * Owner report (2026-09-30): "in svg I can't control the fill and other stuff,
 * and can't paste it in any file" — with a "Cannot add this to imported code /
 * What you copied is not in your project's code any more…" toast, twice.
 *
 * Reproduced on the base before the fix:
 *   - a `<svg>` selected in a frame offered only the CSS Fill / Stroke
 *     sections (`background`, `border`) — nothing wrote its `fill` attribute;
 *   - a vector drawn on the EMPTY board (a free-canvas loose layer) closed the
 *     Properties panel when selected, so it had no controls at all;
 *   - ⌘C on that loose layer copied nothing, so the next ⌘V pasted whatever
 *     an earlier copy had left in the clipboard — here the About heading, for
 *     the owner a stale entry that refused with that toast.
 *
 * Every assertion reads the files on disk or the rendered frame.
 */

const HOME_REL = 'pages/Home.tsx'
const ABOUT_REL = 'pages/About.tsx'
const LAYER_ID = 'claaaaaaaaaa'
const LAYER_REL = `.studio/canvas/${LAYER_ID}.tsx`

const HOME = `export default function Home() {
  return (
    <main className="home" style={{ padding: "32px", minHeight: "400px" }}>
      <svg className="logo" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth={2}>
        <path d="M4 4h16v16H4z" />
        <circle cx="12" cy="12" r="4" fill="red" />
      </svg>
      <p className="home__body">Home body</p>
    </main>
  )
}
`

const ABOUT = `export default function About() {
  return (
    <main className="about" style={{ padding: "32px", minHeight: "400px" }}>
      <h1>About</h1>
      <p className="about__body">About body</p>
    </main>
  )
}
`

/** What the pen writes for a stroke drawn on the empty board. */
const LAYER = `/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.

export default function CanvasLayer() {
  return (
    <svg width={120} height={60} viewBox="0 0 120 60" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 2L118 58" />
    </svg>
  )
}
`

const HOME_SVG = sourceNodeId(HOME, HOME_REL, 'svg', 1)
const ABOUT_H1 = sourceNodeId(ABOUT, ABOUT_REL, 'h1', 1)
const ABOUT_BODY = sourceNodeId(ABOUT, ABOUT_REL, 'p', 1)

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-svg-inspector-paste', {
    [HOME_REL]: HOME,
    [ABOUT_REL]: ABOUT,
    [LAYER_REL]: LAYER,
    'package.json': JSON.stringify({ name: 'svg-inspector-paste', private: true, type: 'module' }, null, 2) + '\n',
    '.studio/meta.json':
      JSON.stringify({ displayName: 'Zz Svg Inspector Paste', platform: 'web', pagesDir: 'pages', trust: 'static', frameDefaults: { width: 600, height: 500 } }, null, 2) + '\n',
    '.studio/boards.json':
      JSON.stringify(
        {
          version: 1,
          boards: [
            {
              id: 'board-1',
              name: 'Board 1',
              frames: [
                { id: 'f-home', pageId: 'home', x: 0, y: 0, width: 600, height: 500 },
                { id: 'f-about', pageId: 'about', x: 700, y: 0, width: 600, height: 500 },
              ],
              notes: [],
              docs: [],
              layers: [{ id: LAYER_ID, x: 0, y: 700 }],
            },
          ],
        },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

function savesOn(page: Page): Request[] {
  const saves: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request)
  })
  return saves
}

async function withToasts<T>(page: Page, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${String(error)}\ntoasts: ${JSON.stringify(await readToastRecorder(page))}`, { cause: error })
  }
}

const vectorSection = (page: Page) => page.locator('[data-inspector-tab="design"] [data-section-id="vector"]')

/** Type a colour into the Vector section's fill field and commit it (blur), as a hand would. */
async function setFillColour(scope: ReturnType<Page['locator']>, colour: string): Promise<void> {
  const input = scope.getByRole('textbox', { name: 'Fill colour' })
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(colour)
  await input.press('Tab')
}

async function selectLooseLayer(page: Page): Promise<void> {
  const host = page.frameLocator('iframe[data-studio-canvas-surface-frame]').locator(`[data-studio-layer-id="${LAYER_ID}"]`)
  await expect(host).toBeAttached({ timeout: 30_000 })
  const box = (await host.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('SVG paint in the inspector, and copy / paste of an SVG across files', () => {
  test.setTimeout(240_000)

  test('a <svg> in a frame: the Vector fill writes the fill attribute — one save, rendered, ⌘Z restores the file', async ({ page }) => {
    const saves = savesOn(page)
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    await zoomToPercent(page, canvasRoot, 50)
    await startToastRecorder(page)
    const home = await frameForPage(page, canvasRoot, 'home')
    const content = canvasContentFrame(home)
    await selectInFrame(page, content.locator(`[data-node-id="${HOME_SVG}"]`).first())

    const section = vectorSection(page)
    await expect(section, 'a selected <svg> offers no Vector section').toBeVisible({ timeout: 15_000 })
    const before = read(HOME_REL)
    const savesBefore = saves.length

    await withToasts(page, async () => {
      await setFillColour(section, '#ff0000')
      await expect.poll(() => read(HOME_REL), { timeout: 30_000, message: 'the fill never reached the source' }).toContain('fill="#ff0000"')
    })
    const after = read(HOME_REL)
    // The whole graphic: the root takes the fill and the circle's own literal
    // gives way, so every shape draws with it.
    expect(after).toContain('<svg className="logo" width="48" height="48" viewBox="0 0 24 24" fill="#ff0000" stroke="black" strokeWidth={2}>')
    expect(after).toContain('<circle cx="12" cy="12" r="4" />')
    expect(saves.length - savesBefore, 'one colour change posted more than one save').toBe(1)

    // Rendered: the frame's path and circle compute the new fill.
    const path = content.locator(`[data-node-id="${HOME_SVG}"] path`).first()
    await expect.poll(() => path.evaluate((el) => getComputedStyle(el).fill), { timeout: 30_000 }).toBe('rgb(255, 0, 0)')
    const circle = content.locator(`[data-node-id="${HOME_SVG}"] circle`).first()
    expect(await circle.evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(255, 0, 0)')

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME_REL), { timeout: 30_000, message: '⌘Z did not restore the file' }).toBe(before)
  })

  test('copy a <svg> in page A, paste into page B: one <svg> lands in B and renders there', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    await zoomToPercent(page, canvasRoot, 50)
    await startToastRecorder(page)
    const home = await frameForPage(page, canvasRoot, 'home')
    await selectInFrame(page, canvasContentFrame(home).locator(`[data-node-id="${HOME_SVG}"]`).first())
    await page.keyboard.press('Control+c')

    const about = await frameForPage(page, canvasRoot, 'about')
    await selectInFrame(page, canvasContentFrame(about).locator(`[data-node-id="${ABOUT_BODY}"]`).first())
    await page.keyboard.press('Control+v')

    await withToasts(page, () =>
      expect.poll(() => read(ABOUT_REL).match(/<svg /g)?.length ?? 0, { timeout: 30_000, message: 'the svg was never pasted into About' }).toBe(1),
    )
    expect(read(ABOUT_REL)).toContain('<circle cx="12" cy="12" r="4" fill="red" />')
    expect(read(HOME_REL), 'the copy changed its source page').toBe(HOME)
    await expect(canvasContentFrame(about).locator('svg circle')).toHaveCount(1, { timeout: 30_000 })
  })

  test('a vector drawn on the empty board: selecting it opens its Vector controls, and ⌘C / ⌘V puts it in a page', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    await zoomToPercent(page, canvasRoot, 50)
    const about = await frameForPage(page, canvasRoot, 'about')
    const aboutContent = canvasContentFrame(about)
    // An EARLIER copy sits in the clipboard — what ⌘V used to paste instead.
    await selectInFrame(page, aboutContent.locator(`[data-node-id="${ABOUT_H1}"]`).first())
    await page.keyboard.press('Control+c')
    await startToastRecorder(page)

    await selectLooseLayer(page)
    const inspector = page.getByTestId('canvas-layer-inspector')
    await expect(inspector, 'selecting a loose layer left no inspector open').toBeVisible({ timeout: 15_000 })

    // Its paint writes into the layer's own module: the pen drew it with
    // `fill="none"`, so the fill is switched on first, then coloured.
    await withToasts(page, async () => {
      await inspector.getByRole('combobox', { name: 'Fill type' }).click()
      await page.getByRole('option', { name: 'Colour', exact: true }).click()
      await expect.poll(() => read(LAYER_REL), { timeout: 30_000, message: 'switching the fill on never reached the file' }).toContain('fill="#000000"')
      await setFillColour(inspector, '#00ff00')
      await expect.poll(() => read(LAYER_REL), { timeout: 30_000, message: 'the loose layer fill never reached its file' }).toContain('fill="#00ff00"')
    })

    await selectLooseLayer(page)
    await page.keyboard.press('Control+c')
    // The Properties panel opened beside the canvas and narrowed it: bring
    // About back into view before pointing at it.
    await frameForPage(page, canvasRoot, 'about')
    await selectInFrame(page, aboutContent.locator(`[data-node-id="${ABOUT_BODY}"]`).first())
    await page.keyboard.press('Control+v')

    await withToasts(page, () =>
      expect.poll(() => read(ABOUT_REL).match(/<svg /g)?.length ?? 0, { timeout: 30_000, message: 'the loose layer was never pasted into About' }).toBe(1),
    )
    const about2 = read(ABOUT_REL)
    expect(about2).toContain('<path d="M2 2L118 58" />')
    expect(about2.match(/<h1>About<\/h1>/g), 'the stale clipboard entry was pasted instead').toHaveLength(1)
    // A copy, not a move: the layer is still on the board.
    expect(fs.existsSync(path.join(fixture.dir, ...LAYER_REL.split('/')))).toBe(true)
    await expect(aboutContent.locator('svg path')).toHaveCount(1, { timeout: 30_000 })
    expect(await readToastRecorder(page), 'the paste raised a toast').toEqual([])
  })
})

test.describe('a paste whose source is gone says so, in full', () => {
  test.setTimeout(180_000)

  test('a stale clipboard entry refuses by name, and the toast body can be read to the end', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    // What a copy made before the file changed leaves behind: an id and a
    // fingerprint that no element in About answers to any more.
    await page.addInitScript(() => {
      const id = 'pages/About.tsx:40:8'
      window.localStorage.setItem(
        'studio-clipboard-v1',
        JSON.stringify({
          version: 2,
          rootNodeIds: [id],
          nodes: {
            [id]: {
              id,
              moduleId: 'base.text',
              props: { text: 'Gone', tag: 'h2' },
              children: [],
              classIds: [],
              breakpointOverrides: {},
              sourceFingerprint: 'h2#00000000',
              parentId: 'pages/About.tsx:3:4',
            },
          },
          classes: {},
          copiedAt: Date.now(),
        }),
      )
    })
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    // The OS clipboard outlives the page: clear an earlier case's Studio
    // marker, which would otherwise read as "copied in another tab".
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await zoomToPercent(page, canvasRoot, 50)
    const about = await frameForPage(page, canvasRoot, 'about')
    await selectInFrame(page, canvasContentFrame(about).locator(`[data-node-id="${ABOUT_BODY}"]`).first())
    await page.keyboard.press('Control+v')

    const toast = page.locator('[data-toast-kind="warning"]').filter({ hasText: 'Cannot add this to imported code' })
    await expect(toast).toBeVisible({ timeout: 15_000 })
    await expect(toast).toContainText('What you copied (<h2>) is not where it was in your project')
    // The whole sentence is readable — the body is no longer clamped mid-word
    // ("… Copy it…"), so its last words are laid out inside the card.
    const body = toast.locator('p').filter({ hasText: 'What you copied' })
    expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), 'the refusal is still cut off').toBe(true)
    await expect(body).toContainText('Copy it again, then paste.')
    expect(read(ABOUT_REL), 'a refused paste wrote to the page').toBe(ABOUT)
  })
})
