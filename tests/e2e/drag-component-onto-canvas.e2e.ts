import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame } from './helpers/canvasIframe'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * The owner's "I can't drag components to the canvas", end to end: a
 * design-system component card dragged out of the Assets panel with a REAL
 * mouse (the gesture is `useCanvasInsertionDrag`'s pointer drag — happy-dom
 * has no layout, no iframe realm and no pointer relay, so no unit test can
 * reach it).
 *
 *   1. **Into a frame** (`speed-06`): the drop line is drawn inside the frame
 *      while dragging, and the release writes one `<Button …/>` into the page
 *      file at that line, which comes back to the canvas as a real node.
 *   2. **Onto the empty board** (P5-G G1, OD-14's free canvas): the drag used
 *      to resolve to nothing there — no preview, and a release that silently
 *      did nothing. It now becomes a loose layer: one module in
 *      `.studio/canvas/`, one placement in `boards.json`, rendered on the
 *      board; the page file is untouched.
 *
 * Every claim is read from the bytes on disk and from computed layout in a
 * real browser, never from the store.
 */

const FIXTURE_PAGE = `import { Button, Chip } from '../design-system'

export default function Home() {
  return (
    <div className="wrap">
      <Button variant="primary" label="Existing button" />
      <Chip label="Existing chip" />
    </div>
  )
}
`

/** The project's own copy of the design system. Only its RESOLVABILITY matters (see design-system-insert.e2e.ts). */
const DESIGN_SYSTEM_INDEX = `export function Button() { return null }
export function Chip() { return null }
`

let fixture: FixtureProject

const rel = (...segments: string[]) => path.join(fixture.dir, ...segments)
const readPage = (): string => fs.readFileSync(rel('pages', 'Home.tsx'), 'utf8')
const layerModules = (): string[] => {
  const dir = rel('.studio', 'canvas')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^cl[a-z0-9]{10}\.tsx$/.test(name)) : []
}
const placements = (): { id: string; x: number; y: number }[] => {
  const boards: { boards: { layers?: { id: string; x: number; y: number }[] }[] } = JSON.parse(
    fs.readFileSync(rel('.studio', 'boards.json'), 'utf8'),
  )
  return boards.boards.flatMap((board) => board.layers ?? [])
}
const count = (text: string, snippet: string) => text.split(snippet).length - 1

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-drag-component', {
    'pages/Home.tsx': FIXTURE_PAGE,
    'design-system/index.js': DESIGN_SYSTEM_INDEX,
    '.studio/meta.json':
      // Static: one design (portal) frame per page — the frame kind every
      // project without its own installed Vite shows, the owner's included.
      JSON.stringify({ displayName: 'Zz Drag Component Fixture', platform: 'web', pagesDir: 'pages', trust: 'static', frameDefaults: { width: 900, height: 600 } }, null, 2) + '\n',
    '.studio/boards.json':
      JSON.stringify(
        { version: 1, boards: [{ id: 'board-1', name: 'Board 1', frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0, width: 900, height: 600 }], notes: [], docs: [] }] },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

/** The Assets panel's Button card, searched for the way a user finds it. */
async function buttonCard(page: Page): Promise<Locator> {
  const assets = page.getByTestId('assets-panel')
  if (!(await assets.isVisible())) await page.getByTestId('panel-rail-assets').click()
  await expect(assets).toBeVisible({ timeout: 10_000 })
  await assets.getByRole('searchbox', { name: 'Search assets' }).fill('Button')
  const card = assets.locator('[data-asset-id="alm.Button"]').first()
  await expect(card, 'the design-system Button is not offered in the Assets panel').toBeVisible({ timeout: 30_000 })
  await card.scrollIntoViewIfNeeded()
  return card
}

/** Press on the card, travel past the drag threshold, and hover `to` long enough for the rAF resolve. Leaves the button DOWN. */
async function dragCardTo(page: Page, card: Locator, to: { x: number; y: number }): Promise<void> {
  const from = (await card.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 14 })
  await page.waitForTimeout(150)
}

/** The drop preview the overlay draws while a drag is in flight, and where it is. */
async function dropPreview(page: Page): Promise<{ position: string | null; label: string; box: { x: number; y: number; width: number; height: number } | null }> {
  const preview = page.locator('[data-position]').first()
  await expect(preview, 'no drop preview is drawn while dragging').toBeAttached({ timeout: 5_000 })
  return {
    position: await preview.getAttribute('data-position'),
    label: (await preview.textContent()) ?? '',
    box: await preview.boundingBox(),
  }
}

/** A client point over EMPTY board next to `frame` — nothing but the board itself is the hit target there. */
async function emptyBoardPoint(page: Page, canvasRoot: Locator, frame: Locator): Promise<{ x: number; y: number }> {
  const f = (await frame.boundingBox())!
  const r = (await canvasRoot.boundingBox())!
  const candidates = [
    { x: f.x - 90, y: f.y + 120 },
    { x: f.x + f.width + 50, y: f.y + 120 },
    { x: f.x + 120, y: f.y + f.height + 50 },
    { x: f.x + 120, y: f.y - 70 },
  ].filter((p) => p.x > r.x + 40 && p.x < r.x + r.width - 40 && p.y > r.y + 40 && p.y < r.y + r.height - 40)
  for (const point of candidates) {
    // The same question the product asks (`isEmptyBoardTarget`): the canvas
    // root or its transform layer, with nothing on top.
    const onBoard = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return hit instanceof HTMLElement && (hit.dataset.studioCanvasRoot === 'true' || hit.dataset.testid === 'canvas-transform-layer')
    }, point)
    if (onBoard) return point
  }
  const hits = await page.evaluate((points) => points.map(({ x, y }) => {
    const hit = document.elementFromPoint(x, y)
    return `${x},${y}: ${hit?.tagName}.${hit?.className} testid=${hit?.getAttribute('data-testid')}`
  }), candidates)
  throw new Error(`emptyBoardPoint: no empty board next to the frame in the current view (frame ${JSON.stringify(f)}, root ${JSON.stringify(r)}; ${hits.join(' | ')})`)
}

test.describe('dragging a component from the Assets panel onto the canvas', () => {
  test.setTimeout(300_000)

  test('into a design frame: the drop line is inside the frame, and the component lands in the page at it', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    const content = canvasContentFrame(frame)
    const chip = content.getByText('Existing chip')
    await expect(chip).toBeVisible({ timeout: 60_000 })
    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)

    const card = await buttonCard(page)
    const chipBox = (await chip.boundingBox())!
    await dragCardTo(page, card, { x: chipBox.x + chipBox.width / 2, y: chipBox.y + chipBox.height - 3 })

    // The drop line is drawn, names what is dropped, and sits inside the frame.
    const preview = await dropPreview(page)
    expect(['before', 'after', 'inside']).toContain(preview.position)
    expect(preview.label).toContain('Drop Button')
    const frameBox = (await frame.getByTestId('board-frame-body').boundingBox())!
    expect(preview.box, 'the drop line has no box').not.toBeNull()
    expect(preview.box!.x).toBeGreaterThanOrEqual(frameBox.x - 1)
    expect(preview.box!.x + preview.box!.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1)
    expect(preview.box!.y).toBeGreaterThanOrEqual(frameBox.y - 1)
    expect(preview.box!.y).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1)
    await page.mouse.up()

    // In source: one more <Button/>, written inside the page's own markup.
    await expect
      .poll(() => count(readPage(), '<Button '), { timeout: 60_000, message: 'no <Button/> reached the page file — the drag did not become an insert' })
      .toBe(2)
    const after = readPage()
    expect(after).toContain('<Button variant="primary" label="Existing button" />')
    expect(after).toContain('<Chip label="Existing chip" />')
    expect(after, 'the import was rewritten').toContain("import { Button, Chip } from '../design-system'")
    expect(count(after, 'import '), 'a second import was written').toBe(1)
    expect(layerModules(), 'a drop into a frame also created a loose layer').toEqual([])

    // On canvas: it came back as a real, source-backed node that renders.
    const buttons = content.locator('[data-module-id="alm.Button"]')
    await expect(buttons, 'the inserted component never reached the canvas').toHaveCount(2, { timeout: 60_000 })
    await expect
      .poll(async () => (await buttons.nth(1).getAttribute('data-node-id')) ?? '', { timeout: 30_000 })
      .toMatch(/^pages\/Home\.tsx:\d+:\d+$/)
    const rendered = (await buttons.nth(1).locator('button.btn').boundingBox())!
    expect(rendered.width).toBeGreaterThan(0)
    expect(rendered.height).toBeGreaterThan(0)
  })

  test('onto the empty board: it becomes a loose layer on the free canvas, and no page changes', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    // 50%: a 900-wide frame leaves empty board around it.
    await zoomToPercent(page, canvasRoot, 50)
    const frame = await frameForPage(page, canvasRoot, 'home')
    await expect(canvasContentFrame(frame).getByText('Existing chip')).toBeVisible({ timeout: 60_000 })
    const pageBefore = readPage()

    const card = await buttonCard(page)
    const point = await emptyBoardPoint(page, canvasRoot, frame)
    await dragCardTo(page, card, point)

    const preview = await dropPreview(page)
    expect(preview.position, 'the empty board offered no drop').toBe('canvas')
    expect(preview.label).toContain('Drop Button on the canvas')
    await page.mouse.up()

    // In source: one layer module holding exactly the component, importing
    // the project's own design system from where the module sits.
    await expect.poll(layerModules, { timeout: 60_000, message: 'no layer module was written to .studio/canvas' }).toHaveLength(1)
    const layerId = layerModules()[0]!.replace(/\.tsx$/, '')
    const moduleText = fs.readFileSync(rel('.studio', 'canvas', `${layerId}.tsx`), 'utf8')
    expect(moduleText).toMatch(/<Button [^>]*label="Label"[^>]*\/>/)
    expect(moduleText).toContain("from '../../design-system'")
    await expect.poll(() => placements().map((layer) => layer.id), { timeout: 30_000 }).toEqual([layerId])
    const placed = placements()[0]!
    const clearOfFrame = placed.x >= 900 || placed.x <= -40 || placed.y >= 620 || placed.y <= -40
    expect(clearOfFrame, `the layer was placed over the frame at ${placed.x},${placed.y}`).toBe(true)
    expect(readPage(), 'dropping on the empty board wrote into a page').toBe(pageBefore)

    // On canvas: the layer renders on the board, at the drop point.
    const rendered = page
      .frameLocator('iframe[data-studio-canvas-surface-frame]')
      .locator(`[data-studio-layer-id="${layerId}"] button.btn`)
    await expect(rendered, 'the loose layer never rendered on the board').toBeVisible({ timeout: 60_000 })
    const box = (await rendered.boundingBox())!
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
    expect(Math.abs(box.x - point.x), 'the layer is not where it was dropped').toBeLessThan(40)
    expect(Math.abs(box.y - point.y), 'the layer is not where it was dropped').toBeLessThan(40)
  })
})
