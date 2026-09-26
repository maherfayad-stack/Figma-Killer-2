import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
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
 * P5-F — the canvas backlog, asserted on COMPUTED layout in a real browser
 * (`standing-02`: happy-dom has no layout, so the unit tests cannot fail on
 * the geometry these gestures are about):
 *
 *   - IX-5d  a free move snaps to EQUAL SPACING and paints its pills;
 *   - IX-22  two absolute layers free-move together, by one delta;
 *   - IX-6g  two selected layers get ONE set of handles on their union, and
 *            a drag scales both;
 *   - IX-6f  double-clicking an edge handle sets Hug;
 *   - IX-25  the rotation zones sit OUTSIDE the corner handles, and a drag
 *            writes the standalone `rotate` (⇧ snaps to 15°).
 *
 * Deltas are FRAME px; the mouse moves them times the measured zoom.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="stage" style={{ position: "relative", width: "640px", height: "320px", background: "#eee" }}>
        <div className="a" style={{ position: "absolute", left: "20px", top: "40px", width: "80px", height: "60px", background: "#999" }}>a</div>
        <div className="b" style={{ position: "absolute", left: "120px", top: "40px", width: "80px", height: "60px", background: "#999" }}>b</div>
        <div className="c" style={{ position: "absolute", left: "300px", top: "40px", width: "80px", height: "60px", background: "#999" }}>c</div>
        <div className="d" style={{ position: "absolute", left: "300px", top: "200px", width: "80px", height: "60px", background: "#bbb" }}>d</div>
      </div>
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
/** `<div>` occurrences in FIXTURE_PAGE, in source order. */
const DIV = { stage: 1, a: 2, b: 3, c: 4, d: 5 } as const

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')
const near = (actual: number, expected: number, tolerance = 1) =>
  expect(Math.abs(actual - expected), `${actual} is not within ${tolerance} of ${expected}`).toBeLessThanOrEqual(tolerance)

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-canvas-snapping-backlog', {
    [REL]: FIXTURE_PAGE,
    // The static tier: the portal frame's chrome is under test, and a live
    // frame would add a second canvas iframe.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** A rect in the FRAME's own px. */
function frameRect(element: Locator): Promise<Box> {
  return element.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })
}

interface Opened {
  content: FrameLocator
  zoom: number
  node: (key: keyof typeof DIV) => Locator
}

async function open(page: Page): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  // 100%: the snap threshold is 8 SCREEN px (IX-5a), so the distances below
  // are chosen for exactly 8 frame px of pull.
  await page.keyboard.press('Shift+0')
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  const node = (key: keyof typeof DIV) =>
    content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', DIV[key])}"]`).first()
  await panIntoView(page, canvasRoot, node('stage'), 80)
  const pageBox = await node('stage').boundingBox()
  const box = await frameRect(node('stage'))
  return { content, zoom: pageBox!.width / box.width, node }
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  expect(box, 'the target has no box').not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

test.describe('P5-F — snapping, multi-select, Hug and rotation (computed layout)', () => {
  test.setTimeout(180_000)

  test('IX-5d — a free move lands on equal spacing and paints its pills', async ({ page }) => {
    const { node, zoom } = await open(page)
    await clickInFrame(page, node('c'))
    // a→b is a 20 px gap. Dragging c left by 77 puts it 3 px from a 20 px gap after b.
    const from = await centre(node('c'))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x - 77 * zoom, from.y, { steps: 12 })
    await page.waitForTimeout(120)
    // The pills are parent-document chrome in the frame's drag layer.
    await expect(page.locator('[data-canvas-snap-spacing]').first()).toBeVisible()
    await expect(page.locator('[data-canvas-snap-spacing-label]').first()).toHaveText('20')
    await page.mouse.up()
    await expect.poll(readPage, { timeout: 30_000 }).toContain('left: "220px"')
    near((await frameRect(node('c'))).left - (await frameRect(node('b'))).right, 20)
  })

  test('IX-22 — two absolute layers move together, by one delta', async ({ page }) => {
    const { node, zoom } = await open(page)
    await clickInFrame(page, node('a'))
    await page.keyboard.down('Shift')
    await clickInFrame(page, node('b'))
    await page.keyboard.up('Shift')
    const beforeA = await frameRect(node('a'))
    const beforeB = await frameRect(node('b'))
    const from = await centre(node('a'))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // Straight down 111 px: top 151, bottom 211 — 9 and 11 px from the nearest
    // peer edges (the stage's centre 160, d's top 200), so nothing snaps.
    await page.mouse.move(from.x, from.y + 111 * zoom, { steps: 12 })
    await page.waitForTimeout(120)
    await page.mouse.up()
    await expect.poll(readPage, { timeout: 30_000 }).toMatch(/className="a"[^>]*top: "151px"/)
    expect(readPage()).toMatch(/className="b"[^>]*top: "151px"/)
    near((await frameRect(node('a'))).top, beforeA.top + 111)
    near((await frameRect(node('b'))).top, beforeB.top + 111)
    near((await frameRect(node('b'))).left, beforeB.left)
  })

  test('IX-6g — two selected layers get ONE handle set on their union, and a drag scales both', async ({ page }) => {
    const { content, node, zoom } = await open(page)
    await clickInFrame(page, node('a'))
    await page.keyboard.down('Shift')
    await clickInFrame(page, node('b'))
    await page.keyboard.up('Shift')
    const group = content.locator('[data-canvas-resize-group]')
    await expect(group).toBeAttached({ timeout: 15_000 })
    const a = await frameRect(node('a'))
    const b = await frameRect(node('b'))
    const union = await frameRect(group)
    near(union.left, a.left)
    near(union.right, b.right)
    near(union.top, a.top)
    near(union.bottom, a.bottom)

    // Union 180 wide → 270: every member ×1.5 about the union's left edge.
    const handle = await centre(content.locator('[data-canvas-resize-group] [data-canvas-resize-handle="e"]'))
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    await page.mouse.move(handle.x + 90 * zoom, handle.y, { steps: 10 })
    await page.waitForTimeout(120)
    await page.mouse.up()
    await expect.poll(readPage, { timeout: 30_000 }).toMatch(/className="b"[^>]*left: "170px"/)
    near((await frameRect(node('a'))).width, 120)
    near((await frameRect(node('b'))).width, 120)
    near((await frameRect(node('b'))).left, a.left + 150)
  })

  test('IX-6f — double-clicking an edge handle hugs that axis', async ({ page }) => {
    const { content, node } = await open(page)
    await clickInFrame(page, node('d'))
    const handle = content.locator('[data-canvas-resize-handle="e"]')
    await expect(handle).toBeVisible({ timeout: 15_000 })
    await handle.dblclick()
    await expect.poll(readPage, { timeout: 30_000 }).toMatch(/className="d"[^>]*width: "fit-content"/)
    // "d" hugs a single letter: far narrower than the 80 px it was.
    expect((await frameRect(node('d'))).width).toBeLessThan(40)
  })

  test('IX-25 — the rotation zones sit outside the corners, and a drag writes `rotate`', async ({ page }) => {
    const { content, node } = await open(page)
    await clickInFrame(page, node('d'))
    const zone = content.locator('[data-canvas-rotate-handle="se"]')
    const corner = content.locator('[data-canvas-resize-handle="se"]')
    await expect(corner).toBeVisible({ timeout: 15_000 })
    const zoneBox = await frameRect(zone)
    const cornerBox = await frameRect(corner)
    // Just outside the corner handle, down and to the right, never over it.
    expect(zoneBox.left).toBeGreaterThanOrEqual(cornerBox.right - 1)
    expect(zoneBox.top).toBeGreaterThanOrEqual(cornerBox.bottom - 1)

    const before = await frameRect(node('d'))
    const c = { x: (before.left + before.right) / 2, y: (before.top + before.bottom) / 2 }
    const start = await centre(zone)
    const pageCentre = await centre(node('d'))
    // Swing the pointer a quarter turn about the element's centre, with ⇧.
    const rx = start.x - pageCentre.x
    const ry = start.y - pageCentre.y
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    await page.mouse.move(pageCentre.x - ry, pageCentre.y + rx, { steps: 16 })
    await page.waitForTimeout(120)
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect.poll(readPage, { timeout: 30_000 }).toMatch(/className="d"[^>]*rotate: "90deg"/)
    expect(readPage()).not.toMatch(/className="d"[^>]*transform:/)
    const rotated = await node('d').evaluate((el) => getComputedStyle(el).rotate)
    expect(rotated).toBe('90deg')
    // Rotated about its own centre: the covered box is centred where it was.
    const after = await frameRect(node('d'))
    near((after.left + after.right) / 2, c.x)
    near((after.top + after.bottom) / 2, c.y)
  })
})
