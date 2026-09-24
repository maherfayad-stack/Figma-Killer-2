import { expect, test, type FrameLocator, type Locator, type Page, type Request } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  readToastRecorder,
  removeFixtureProject,
  sourceNodeId,
  startToastRecorder,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P5-E "tools and handles", in a real browser — asserted on COMPUTED layout
 * inside the frame and on the FILE on disk (`standing-02`: happy-dom has no
 * layout, so the unit tests only answer who claims what):
 *
 *   - IX-17: dragging a flex container's TOP padding band grows its computed
 *     `padding-top` by the drag and writes ONE `paddingTop` to the source;
 *     ⌥-drag writes all four sides.
 *   - IX-12: R arms the rectangle tool; a DRAG inside the frame inserts a
 *     `<div>` whose computed size is the drawn size (in frame px, whatever the
 *     zoom), in one source write, and the tool puts itself away.
 *   - IX-20: ⌥A on an absolute layer writes `left: "0px"` and it lands on its
 *     containing block's padding edge.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="row" style={{ display: "flex", gap: "8px", padding: "10px", width: "400px", background: "#eee" }}>
        <div className="a" style={{ width: "60px", height: "40px", background: "#c33" }}>A</div>
        <div className="b" style={{ width: "60px", height: "40px", background: "#3c3" }}>B</div>
      </div>
      <div className="stage" style={{ position: "relative", width: "320px", height: "200px", marginTop: "40px", background: "#ddd" }}>
        <div className="abs" style={{ position: "absolute", left: "100px", top: "60px", width: "120px", height: "50px", background: "#999" }}>abs</div>
      </div>
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
/** `<div>` occurrences in FIXTURE_PAGE, in source order. */
const DIV = { row: 1, a: 2, b: 3, stage: 4, abs: 5 } as const

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-canvas-tools-and-handles', {
    [REL]: FIXTURE_PAGE,
    // Static tier: one portal frame (the handles live in the in-frame overlay).
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

function computed(element: Locator) {
  return element.evaluate((el) => {
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      cssLeft: cs.left,
    }
  })
}

interface Opened {
  canvasRoot: Locator
  content: FrameLocator
  element: Locator
  /** Screen px per frame px. */
  zoom: number
}

async function openAndSelect(page: Page, divIndex: number): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 60_000 })
  const content = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
  const element = content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', divIndex)}"]`).first()
  await panIntoView(page, canvasRoot, element, 80)
  await clickInFrame(page, element)
  await expect(page.getByTestId(`dom-tree-item-${sourceNodeId(FIXTURE_PAGE, REL, 'div', divIndex)}`)).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const pageBox = await element.boundingBox()
  const frameBox = await computed(element)
  return { canvasRoot, content, element, zoom: pageBox!.width / frameBox.width }
}

/** Long enough for the autosave's trailing debounce to have fired a second save, if one were coming. */
const QUIET_MS = 2_000

test.describe('P5-E — tools and handles (computed layout + file bytes)', () => {
  test.setTimeout(180_000)

  test('IX-17: dragging the top padding band of a flex row grows padding-top by the drag, in ONE write', async ({ page }) => {
    const { content, element, zoom } = await openAndSelect(page, DIV.row)
    const band = content.locator('[data-canvas-spacing-band][data-spacing-kind="padding"][data-spacing-axis="row"]').first()
    await expect(band).toBeVisible({ timeout: 15_000 })
    const before = await computed(element)
    expect(before.paddingTop).toBe('10px')
    const saves = recordSaves(page)

    const box = (await band.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + 14 * zoom, { steps: 8 })
    await page.waitForTimeout(100)
    // Mid-drag: the frame shows the padding; the file does not have it yet.
    await expect.poll(() => computed(element).then((c) => c.paddingTop)).toBe('24px')
    expect(readPage()).toBe(FIXTURE_PAGE)
    await page.mouse.up()

    await expect.poll(readPage, { timeout: 30_000 }).toContain('paddingTop: "24px"')
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a padding drag must be exactly one source write').toHaveLength(1)
    const after = await computed(element)
    expect(after.paddingTop).toBe('24px')
    // The other sides are untouched, and the box grew by exactly the drag.
    expect(after.paddingBottom).toBe('10px')
    expect(Math.abs(after.height - before.height - 14)).toBeLessThanOrEqual(1)
  })

  test('IX-17: ⌥-dragging a padding band writes all four sides', async ({ page }) => {
    const { content, element, zoom } = await openAndSelect(page, DIV.row)
    // The RIGHT band (left, then right, in DOM order): the row's left edge can
    // sit under the ruler / Explorer at this viewport size.
    const band = content.locator('[data-canvas-spacing-band][data-spacing-kind="padding"][data-spacing-axis="column"]').nth(1)
    await expect(band).toBeVisible({ timeout: 15_000 })
    const box = (await band.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    // ⌥ pressed DURING the drag, as a hand does it: the drag claims the key,
    // so the Alt-hover ladder never opens over the band being dragged.
    await page.keyboard.down('Alt')
    // The right band grows as it is pulled left.
    await page.mouse.move(x - 6 * zoom, y, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('paddingLeft: "16px"')
    const source = readPage()
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom']) expect(source).toContain(`${side}: "16px"`)
    const after = await computed(element)
    expect([after.paddingTop, after.paddingRight, after.paddingBottom, after.paddingLeft]).toEqual(['16px', '16px', '16px', '16px'])
  })

  test('IX-12: R arms the rectangle tool; a drag in the frame inserts a box of the DRAWN size', async ({ page }) => {
    const { canvasRoot, content, zoom } = await openAndSelect(page, DIV.b)
    await startToastRecorder(page)
    const consoleLines: string[] = []
    page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
    const saves = recordSaves(page)
    await canvasRoot.focus()
    await page.keyboard.press('r')
    await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible()

    // Draw inside the stage, 80 × 30 frame px — from its right-hand part, which
    // stays clear of the ruler and the Explorer at this viewport size.
    const stage = content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', DIV.stage)}"]`).first()
    const stageBox = (await stage.boundingBox())!
    const x = stageBox.x + stageBox.width - 100 * zoom
    const y = stageBox.y + stageBox.height - 40 * zoom
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 80 * zoom, y + 30 * zoom, { steps: 8 })
    // Mid-drag: the rectangle being drawn is on screen.
    await expect(page.locator('[data-canvas-drawn-rect]')).toBeVisible()
    await page.mouse.up()

    try {
      await expect.poll(readPage, { timeout: 30_000 }).toContain('width: "80px"')
    } catch (err) {
      // Say WHY nothing landed: a refusal is a toast, a crash is a console error.
      const toasts = JSON.stringify(await readToastRecorder(page))
      const console = consoleLines.filter((line) => !line.startsWith('debug')).slice(-15).join(' | ')
      throw new Error(`no drawn box in the source. Toasts: ${toasts}. Console: ${console}`, { cause: err })
    }
    const source = readPage()
    expect(source).toContain('height: "30px"')
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'one draw must be exactly one source write').toHaveLength(1)
    // The tool put itself away.
    await expect(page.locator('[data-canvas-draw-layer]')).toHaveCount(0)
    // The drawn box renders at the drawn size (frame px), whatever the zoom.
    const drawn = content.locator('div[style*="width: 80px"][style*="height: 30px"]').first()
    await expect(drawn).toBeVisible({ timeout: 30_000 })
    const size = await computed(drawn)
    expect(Math.round(size.width)).toBe(80)
    expect(Math.round(size.height)).toBe(30)
  })

  test('IX-20: ⌥A puts an absolute layer on its containing block’s left edge', async ({ page }) => {
    const { content, element } = await openAndSelect(page, DIV.abs)
    const stage = content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', DIV.stage)}"]`).first()
    await page.keyboard.press('Alt+a')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('left: "0px"')
    const [abs, container] = await Promise.all([computed(element), computed(stage)])
    expect(abs.cssLeft).toBe('0px')
    expect(Math.abs(abs.left - container.left)).toBeLessThanOrEqual(1)
  })
})
