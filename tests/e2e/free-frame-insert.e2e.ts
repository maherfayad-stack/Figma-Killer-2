import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * PA-3 — a layer drawn or dropped into a FREE FRAME lands absolute, exactly
 * where the pointer was. The claim is geometry, so it is read from computed
 * layout in a real browser, never from the store: the new element's measured
 * rect, relative to its container's, equals the pointer's offset from the
 * container's painted corner (screen px ÷ the board's zoom), to the pixel.
 *
 *   1. R, a real-mouse drag inside an empty `position: relative` frame (with a
 *      border, so the padding-box maths is in play) — at 100 % and at 50 %.
 *   2. The notch's Div primitive, dragged out and released inside it.
 *   3. A frame with in-flow content stays a flow insert; ⌘/Ctrl held places
 *      the same draw at the pointer instead.
 *
 * SAFETY — writes only to this run's throwaway fixture under the e2e
 * workspace, removed afterwards.
 */

const REL = 'pages/Home.tsx'

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="free" style={{ position: "relative", width: "400px", height: "260px", border: "3px solid #444", background: "#ddd" }}></div>
      <div className="flow" style={{ position: "relative", width: "400px", height: "200px", marginTop: "40px", background: "#bbb" }}>
        <p>in flow</p>
      </div>
    </main>
  )
}
`

const FREE = sourceNodeId(FIXTURE_PAGE, REL, 'div', 1)
const FLOW = sourceNodeId(FIXTURE_PAGE, REL, 'div', 2)

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, ...REL.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-free-frame-insert', {
    [REL]: FIXTURE_PAGE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Opened {
  content: FrameLocator
  container: (id: string) => Locator
}

async function openBoard(page: Page, zoomPercent: number): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  if (zoomPercent !== 100) await zoomToPercent(page, canvasRoot, zoomPercent)
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toHaveCount(1, { timeout: 60_000 })
  const content = canvasContentFrame(frame)
  const container = (id: string) => content.locator(`[data-node-id="${id}"]`).first()
  await expect(container(FREE)).toBeVisible({ timeout: 30_000 })
  await panIntoView(page, canvasRoot, container(FREE), 80)
  return { content, container }
}

/** Screen px per frame px: the container's painted width over its layout width. */
async function zoomOf(container: Locator): Promise<number> {
  const screen = (await container.boundingBox())!.width
  const layout = await container.evaluate((el) => el.getBoundingClientRect().width)
  return screen / layout
}

/** `inner`'s border-box top-left minus `outer`'s, in the frame's own CSS px. */
async function offsetWithin(inner: Locator, outer: Locator): Promise<{ left: number; top: number; width: number; height: number }> {
  const innerRect = await inner.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  const outerRect = await outer.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  return { left: innerRect.left - outerRect.left, top: innerRect.top - outerRect.top, width: innerRect.width, height: innerRect.height }
}

for (const zoomPercent of [100, 50]) {
  test.describe(`at ${zoomPercent}% zoom`, () => {
    test.setTimeout(240_000)

    test('a real-mouse draw into a free frame lands absolute: the measured rect IS the drawn rect', async ({ page }) => {
      const { content, container } = await openBoard(page, zoomPercent)
      const free = container(FREE)
      const zoom = await zoomOf(free)
      const box = (await free.boundingBox())!

      await page.getByTestId('canvas-draw-tool-rectangle').click()
      await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible()
      const startX = box.x + 60 * zoom
      const startY = box.y + 50 * zoom
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      await page.mouse.move(startX + 90 * zoom, startY + 40 * zoom, { steps: 8 })
      await page.mouse.up()

      await expect.poll(readPage, { timeout: 30_000 }).toContain('position: "absolute"')
      const drawn = content.locator(`[data-node-id="${FREE}"] > div[style*="position: absolute"]`).first()
      await expect(drawn).toBeVisible({ timeout: 30_000 })
      const rect = await offsetWithin(drawn, free)
      // The pointer pressed 60 / 50 frame px from the container's border-box corner.
      expect(Math.abs(rect.left - 60)).toBeLessThanOrEqual(1)
      expect(Math.abs(rect.top - 50)).toBeLessThanOrEqual(1)
      expect(Math.abs(rect.width - 90)).toBeLessThanOrEqual(1)
      expect(Math.abs(rect.height - 40)).toBeLessThanOrEqual(1)
    })

    test('a real-mouse drop of the Div primitive into a free frame lands absolute at the pointer', async ({ page }) => {
      const { content, container } = await openBoard(page, zoomPercent)
      const free = container(FREE)
      const zoom = await zoomOf(free)
      const box = (await free.boundingBox())!

      const button = page.getByTestId('canvas-notch-div-btn')
      const from = (await button.boundingBox())!
      const dropX = box.x + 120 * zoom
      const dropY = box.y + 80 * zoom
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
      await page.mouse.move(dropX, dropY, { steps: 14 })
      await page.waitForTimeout(150)
      await page.mouse.up()

      await expect.poll(readPage, { timeout: 30_000 }).toContain('position: "absolute"')
      const dropped = content.locator(`[data-node-id="${FREE}"] > div`).first()
      await expect(dropped).toBeAttached({ timeout: 30_000 })
      const rect = await offsetWithin(dropped, free)
      // The element has no size of its own, so its top-left is the pointer.
      expect(Math.abs(rect.left - 120)).toBeLessThanOrEqual(1)
      expect(Math.abs(rect.top - 80)).toBeLessThanOrEqual(1)
    })
  })
}

test.describe('a frame with in-flow content', () => {
  test.setTimeout(240_000)

  test('a plain draw stays in the flow; Ctrl held places it at the pointer', async ({ page }) => {
    const { content, container } = await openBoard(page, 100)
    const flow = container(FLOW)
    await flow.scrollIntoViewIfNeeded()
    const zoom = await zoomOf(flow)

    const draw = async (withModifier: boolean) => {
      const box = (await flow.boundingBox())!
      await page.getByTestId('canvas-draw-tool-rectangle').click()
      await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible()
      const x = box.x + 200 * zoom
      const y = box.y + 100 * zoom
      if (withModifier) await page.keyboard.down('Control')
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 60 * zoom, y + 30 * zoom, { steps: 6 })
      await page.mouse.up()
      if (withModifier) await page.keyboard.up('Control')
    }

    await draw(false)
    await expect.poll(readPage, { timeout: 30_000 }).toContain('width: "60px"')
    expect(readPage(), 'a plain draw in a frame with flow content must not be placed absolutely').not.toContain('position: "absolute"')

    await draw(true)
    await expect.poll(readPage, { timeout: 30_000 }).toContain('position: "absolute"')
    const placed = content.locator(`[data-node-id="${FLOW}"] > div[style*="position: absolute"]`).first()
    await expect(placed).toBeVisible({ timeout: 30_000 })
    const rect = await offsetWithin(placed, flow)
    expect(Math.abs(rect.left - 200)).toBeLessThanOrEqual(1)
    expect(Math.abs(rect.top - 100)).toBeLessThanOrEqual(1)
  })
})
