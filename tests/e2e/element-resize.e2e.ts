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
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P2-D — "resize that obeys CSS", asserted on COMPUTED layout in a real
 * browser (`standing-02`: happy-dom has no layout, so the unit tests in
 * `src/__tests__/canvas/elementResizeDrag.test.tsx` cannot fail on the thing
 * this spec is named after).
 *
 * Every case drags a real handle with the real mouse, then measures the
 * element's rendered box and its computed CSS inside the frame:
 *
 *   - border-box: the box grows by exactly the drag;
 *   - content-box (IX-6a): the box grows by exactly the drag — during the drag
 *     too — and the source gets the CSS width, not the rect width;
 *   - a `flex: 1` item (IX-6b): the dragged width is the width it renders at,
 *     not the one flexbox gives it back;
 *   - an absolute element (IX-6d): the W / N handles keep the opposite edge.
 *
 * The pointer deltas are FRAME px; the mouse moves them times the measured
 * zoom, so the spec holds at whatever zoom the board opened at.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="bb" style={{ boxSizing: "border-box", width: "200px", height: "80px", padding: "12px", border: "2px solid black", marginBottom: "40px" }}>BB</div>
      <div className="cb" style={{ boxSizing: "content-box", width: "200px", height: "80px", padding: "12px", border: "2px solid black", marginBottom: "40px" }}>CB</div>
      <div className="row" style={{ display: "flex", width: "320px", gap: "8px", marginBottom: "40px" }}>
        <div className="grow" style={{ flex: "1 1 0", height: "40px", background: "#ccc" }}>grow</div>
        <div className="fixed" style={{ width: "100px", height: "40px", background: "#aaa" }}>fixed</div>
      </div>
      <div className="stage" style={{ position: "relative", width: "320px", height: "200px", background: "#eee" }}>
        <div className="abs" style={{ position: "absolute", left: "100px", top: "60px", width: "120px", height: "50px", background: "#999" }}>abs</div>
      </div>
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
/** `<div>` occurrences in FIXTURE_PAGE, in source order. */
const DIV = { bb: 1, cb: 2, row: 3, grow: 4, fixed: 5, stage: 6, abs: 7 } as const

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-element-resize', {
    [REL]: FIXTURE_PAGE,
    // Pinned to the static tier: the portal frame's handles are under test,
    // and a live frame would add a second canvas iframe.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Measured {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  cssWidth: string
  cssHeight: string
  cssLeft: string
  cssTop: string
}

/** The element's rendered box and computed CSS, in the frame's own px. */
function measure(element: Locator): Promise<Measured> {
  return element.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      cssWidth: cs.width,
      cssHeight: cs.height,
      cssLeft: cs.left,
      cssTop: cs.top,
    }
  })
}

async function openAndSelect(page: Page, divIndex: number): Promise<{ content: FrameLocator; element: Locator; zoom: number }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 60_000 })
  const content = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
  const element = content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', divIndex)}"]`).first()
  await panIntoView(page, canvasRoot, element, 80)
  await clickInFrame(page, element)
  await expect(content.locator('[data-canvas-resize-handle="e"]')).toBeVisible({ timeout: 15_000 })
  // Screen px per frame px: the canvas zoom is a transform on the iframe.
  const pageBox = await element.boundingBox()
  const frameBox = await measure(element)
  return { content, element, zoom: pageBox!.width / frameBox.width }
}

/**
 * Press the centre of `handle`, move by (`dx`, `dy`) FRAME px in steps, and
 * hand back control BEFORE releasing so a case can measure mid-drag.
 */
async function dragHandle(page: Page, content: FrameLocator, handle: string, dx: number, dy: number, zoom: number) {
  const box = await content.locator(`[data-canvas-resize-handle="${handle}"]`).boundingBox()
  expect(box, `the ${handle} handle has no box`).not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx * zoom, y + dy * zoom, { steps: 10 })
  // One animation frame for the coalesced preview write.
  await page.waitForTimeout(100)
  return { release: () => page.mouse.up() }
}

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

test.describe('P2-D — resize obeys CSS (computed layout)', () => {
  test.setTimeout(180_000)

  test('border-box: the box grows by exactly the drag', async ({ page }) => {
    const { content, element, zoom } = await openAndSelect(page, DIV.bb)
    const before = await measure(element)
    const drag = await dragHandle(page, content, 'e', 40, 0, zoom)
    await drag.release()
    await expect.poll(() => measure(element).then((m) => Math.round(m.width))).toBe(Math.round(before.width + 40))
    await expect.poll(readPage, { timeout: 30_000 }).toContain('width: "240px"')
  })

  test('content-box (IX-6a): the box grows by the drag, mid-drag and after, and the source gets the CSS width', async ({ page }) => {
    const { content, element, zoom } = await openAndSelect(page, DIV.cb)
    const before = await measure(element)
    // 200 wide + 2×12 padding + 2×2 border.
    near(before.width, 228)
    const drag = await dragHandle(page, content, 'e', 40, 0, zoom)
    // The preview — the old drag jumped by padding + border on the first frame.
    near((await measure(element)).width, before.width + 40)
    await drag.release()
    await expect.poll(readPage, { timeout: 30_000 }).toContain('width: "240px"')
    const after = await measure(element)
    near(after.width, before.width + 40)
    expect(after.cssWidth).toBe('240px')
    near(after.left, before.left)

    // One drag is one undo entry and one source write.
    await page.keyboard.press('Control+z')
    await expect.poll(readPage, { timeout: 30_000 }).toBe(FIXTURE_PAGE)
  })

  test('a `flex: 1` item (IX-6b) renders at the dragged width, not the one flexbox hands back', async ({ page }) => {
    const { content, element, zoom } = await openAndSelect(page, DIV.grow)
    const before = await measure(element)
    // 320 - 8 gap - 100 fixed.
    near(before.width, 212)
    const drag = await dragHandle(page, content, 'e', -40, 0, zoom)
    near((await measure(element)).width, before.width - 40)
    await drag.release()
    await expect.poll(readPage, { timeout: 30_000 }).toContain('width: "172px"')
    // The Fill marker went with it, or the width would be dead.
    expect(readPage()).not.toMatch(/className="grow" style=\{\{[^}]*flex:/)
    const after = await measure(element)
    near(after.width, 172)
    expect(after.cssWidth).toBe('172px')
  })

  test('an absolute element (IX-6d): W moves `left` and N moves `top`, the opposite edges stay', async ({ page }) => {
    const { content, element, zoom } = await openAndSelect(page, DIV.abs)
    const before = await measure(element)
    const west = await dragHandle(page, content, 'w', -30, 0, zoom)
    await west.release()
    await expect.poll(readPage, { timeout: 30_000 }).toContain('left: "70px"')
    const afterWest = await measure(element)
    near(afterWest.right, before.right)
    near(afterWest.left, before.left - 30)
    near(afterWest.width, before.width + 30)
    // The click that ends the drag lands on the handle; it must not select the
    // page body the overlay sits in.
    await expect(page.getByTestId(`dom-tree-item-${sourceNodeId(FIXTURE_PAGE, REL, 'div', DIV.abs)}`)).toHaveAttribute(
      'aria-selected',
      'true',
    )

    const north = await dragHandle(page, content, 'n', 0, 10, zoom)
    await north.release()
    await expect.poll(readPage, { timeout: 30_000 }).toContain('top: "70px"')
    const afterNorth = await measure(element)
    near(afterNorth.bottom, before.bottom)
    near(afterNorth.top, before.top + 10)
    near(afterNorth.height, before.height - 10)
  })
})
