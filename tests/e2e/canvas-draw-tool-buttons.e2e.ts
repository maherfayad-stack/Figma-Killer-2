import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
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
 * The draw and vector tools are reachable from VISIBLE controls, not only from
 * letters an author has to already know — and what those controls arm really
 * draws, in the file and on the canvas.
 *
 * Why this spec exists: P5-E's armed rectangle / ellipse tools and P5-D's pen
 * and vector edit mode all shipped keyboard- or double-click-only, with no
 * button anywhere, and the owner reported having "no access to them at all".
 * Their own specs (`canvas-tools-and-handles`, `studio-vector`) press the keys,
 * so they stayed green while the tools were invisible. This one goes through
 * the chrome:
 *
 *   1. The notch's Rectangle button arms the tool (pressed, crosshair layer);
 *      a drag inside the frame writes ONE box of the drawn size into the
 *      source, it renders at that size, and the button un-presses.
 *   2. The notch's Pen button arms the pen; three clicks and ⏎ write ONE new
 *      inline `<svg>` into the source, and the frame renders it.
 *   3. Selecting a literal `<svg>` shows "Edit points" on the selection
 *      toolbar, and it opens vector edit mode's anchors.
 *
 * SAFETY — writes only to this run's throwaway fixture under the e2e
 * workspace, removed afterwards.
 */

const REL = 'pages/Home.tsx'
const ICON_D = 'M4 4h16v16H4z'

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <svg className="icon" width="96" height="96" viewBox="0 0 24 24" fill="none">
        <path d="${ICON_D}" stroke="black" strokeWidth={2} />
      </svg>
      <div className="stage" style={{ position: "relative", width: "320px", height: "200px", marginTop: "40px", background: "#ddd" }}>stage</div>
    </main>
  )
}
`

const ICON_SVG = sourceNodeId(FIXTURE_PAGE, REL, 'svg', 1)
const STAGE = sourceNodeId(FIXTURE_PAGE, REL, 'div', 1)

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, ...REL.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-canvas-draw-tool-buttons', {
    [REL]: FIXTURE_PAGE,
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

interface Opened {
  canvasRoot: Locator
  frame: Locator
  stage: Locator
  /** Screen px per frame px. */
  zoom: number
}

async function openBoard(page: Page): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toHaveCount(1, { timeout: 60_000 })
  const stage = canvasContentFrame(frame).locator(`[data-node-id="${STAGE}"]`).first()
  await expect(stage).toBeVisible({ timeout: 30_000 })
  await panIntoView(page, canvasRoot, stage, 80)
  const pageWidth = (await stage.boundingBox())!.width
  const frameWidth = await stage.evaluate((el) => el.getBoundingClientRect().width)
  return { canvasRoot, frame, stage, zoom: pageWidth / frameWidth }
}

const svgCountInSource = () => (readPage().match(/<svg/g) ?? []).length

test.describe('draw and vector tools are reachable from the chrome', () => {
  test.setTimeout(180_000)

  test('the notch Rectangle button arms the tool; a drag writes ONE box of the drawn size', async ({ page }) => {
    const { frame, stage, zoom } = await openBoard(page)
    const saves = recordSaves(page)
    const button = page.getByTestId('canvas-draw-tool-rectangle')
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible()

    const stageBox = (await stage.boundingBox())!
    const x = stageBox.x + stageBox.width - 100 * zoom
    const y = stageBox.y + stageBox.height - 40 * zoom
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 80 * zoom, y + 30 * zoom, { steps: 8 })
    await expect(page.locator('[data-canvas-drawn-rect]')).toBeVisible()
    await page.mouse.up()

    await expect.poll(readPage, { timeout: 30_000 }).toContain('width: "80px"')
    expect(readPage()).toContain('height: "30px"')
    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1)
    // The tool put itself away, and the button says so.
    await expect(page.locator('[data-canvas-draw-layer]')).toHaveCount(0)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    // The canvas result: the drawn box renders at the drawn size, frame px.
    const drawn = canvasContentFrame(frame).locator('div[style*="width: 80px"][style*="height: 30px"]').first()
    await expect(drawn).toBeVisible({ timeout: 30_000 })
    const size = await drawn.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return { width: Math.round(rect.width), height: Math.round(rect.height) }
    })
    expect(size).toEqual({ width: 80, height: 30 })
  })

  test('the notch Pen button arms the pen; three clicks and ⏎ write ONE new <svg> the frame renders', async ({ page }) => {
    const { frame, stage, zoom } = await openBoard(page)
    const saves = recordSaves(page)
    const content = canvasContentFrame(frame)
    const svgsBefore = await content.locator('svg').count()
    const button = page.getByTestId('canvas-draw-tool-pen')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-canvas-draw-layer="pen"]')).toBeVisible()

    const box = (await stage.boundingBox())!
    await page.mouse.click(box.x + 20 * zoom, box.y + 20 * zoom)
    await page.mouse.click(box.x + 120 * zoom, box.y + 20 * zoom)
    await page.mouse.click(box.x + 120 * zoom, box.y + 60 * zoom)
    await page.keyboard.press('Enter')

    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1)
    await expect.poll(svgCountInSource, { timeout: 10_000 }).toBe(2)
    expect(readPage()).toContain('stroke="currentColor"')
    await expect(page.locator('[data-canvas-draw-layer]')).toHaveCount(0)
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    // The canvas result: the frame renders one more svg, with a drawn path.
    await expect(content.locator('svg')).toHaveCount(svgsBefore + 1, { timeout: 30_000 })
    const drawnPath = content.locator(`svg:not([data-node-id="${ICON_SVG}"]) path`).first()
    await expect(drawnPath).toBeAttached()
    const pathBox = await drawnPath.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    expect(pathBox.width).toBeGreaterThan(50)
    expect(pathBox.height).toBeGreaterThan(20)
  })

  test('selecting a literal <svg> offers "Edit points", which opens vector edit mode', async ({ page }) => {
    const { canvasRoot, frame } = await openBoard(page)
    const icon = canvasContentFrame(frame).locator(`[data-node-id="${ICON_SVG}"]`).first()
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await panIntoView(page, canvasRoot, icon, 80)
    await clickInFrame(page, icon)
    await expect(page.getByTestId(`dom-tree-item-${ICON_SVG}`)).toHaveAttribute('aria-selected', 'true')

    const editPoints = page.getByTestId('canvas-selection-edit-points')
    await expect(editPoints).toBeVisible({ timeout: 10_000 })
    await editPoints.click()
    await expect(page.locator('[data-board-vector-layer="edit"]')).toBeAttached({ timeout: 10_000 })
    await expect(page.locator('[data-vector-anchors]')).toBeAttached()
    // Nothing was written by entering the mode.
    expect(readPage()).toBe(FIXTURE_PAGE)
  })
})
