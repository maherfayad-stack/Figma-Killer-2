import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  readZoomPercent,
  removeFixtureProject,
  sourceNodeId,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * P2-E — snapping and measuring, in a real browser, asserted on COMPUTED
 * position and on the file (`standing-02`: happy-dom has no layout, so
 * `src/__tests__/canvas/snappingAndMeasuring.test.tsx` and the IX-6e cases in
 * `elementResizeDrag.test.tsx` can only pin the arithmetic).
 *
 *   - IX-5a  a free move snaps at the same SCREEN distance at 50% and 100%:
 *            5 screen px short lands exactly on the peer, 12 screen px short
 *            stays where the pointer put it — at both zooms;
 *   - IX-6e  a resize handle's edge snaps the same way, at both zooms;
 *   - IX-24  a before/after drop outlines the container it lands in;
 *   - IX-19  Alt with nothing hovered measures the selection to its parent;
 *   - OD-15  a click on a Layers row, then →, nudges the layer.
 *
 * Every drag is a real mouse drag; its screen delta is computed from the
 * zoom MEASURED off the element (screen px per frame px), so a zoom that
 * settled at 49% instead of 50% still aims where it means to.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

// Geometry, in frame px. `stage`'s padding box is 640 × 340 (its centre is
// x 320), its content box starts at 20. `mover` and `peer` are the SAME width,
// so every one of their x edges lines up at once — a snap is one delta no
// matter which pair of edges wins it. Nothing else is within 16 frame px
// (8 screen px at 50%) of where the cases below aim.
const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="stage" style={{ position: "relative", width: "600px", height: "300px", padding: "20px", background: "#eee" }}>
        <div className="mover" style={{ position: "absolute", left: "60px", top: "40px", width: "100px", height: "40px", background: "#999" }}>M</div>
        <div className="peer" style={{ position: "absolute", left: "400px", top: "180px", width: "100px", height: "60px", background: "#555" }}>P</div>
      </div>
      <div className="row" style={{ display: "flex", gap: "8px", marginTop: "40px", padding: "8px", background: "#ddd" }}>
        <div className="r1" style={{ width: "80px", height: "40px", background: "#c33" }}>one</div>
        <div className="r2" style={{ width: "80px", height: "40px", background: "#3c3" }}>two</div>
      </div>
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
/** `<div>` occurrences in FIXTURE_PAGE, in source order. */
const DIV = { stage: 1, mover: 2, peer: 3, row: 4, r1: 5, r2: 6 } as const
const PEER_LEFT = 400
const MOVER_LEFT = 60
const MOVER_RIGHT = 160
const PEER_RIGHT = 500

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')
const nodeId = (div: number) => sourceNodeId(FIXTURE_PAGE, REL, 'div', div)

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-snapping-and-measuring', {
    [REL]: FIXTURE_PAGE,
    // Static tier: one portal frame, so the one canvas iframe is the one under test.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Board {
  canvasRoot: Locator
  content: FrameLocator
}

async function openBoard(page: Page, zoomPct: number): Promise<Board> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  if (zoomPct !== 100) await zoomToPercent(page, canvasRoot, zoomPct)
  expect(Math.abs((await readZoomPercent(page)) - zoomPct)).toBeLessThanOrEqual(1)
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, content: canvasContentFrame(frame) }
}

/** Pan `element` to the middle, click it, and return the screen px per frame px it is drawn at. */
async function select(page: Page, board: Board, element: Locator): Promise<number> {
  await panIntoView(page, board.canvasRoot, element, 80)
  await clickInFrame(page, element)
  const screen = await element.boundingBox()
  const frameWidth = await element.evaluate((el) => el.getBoundingClientRect().width)
  return screen!.width / frameWidth
}

function cssLeft(element: Locator): Promise<string> {
  return element.evaluate((el) => getComputedStyle(el).left)
}

/** A real mouse drag from the centre of `from` by (`dx`, `dy`) SCREEN px, in steps. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 })
  await page.waitForTimeout(100)
  await page.mouse.up()
}

async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  expect(box, 'drag target has no box').not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

test.describe('P2-E — snapping feels the same at every zoom', () => {
  test.setTimeout(240_000)

  for (const zoomPct of [50, 100]) {
    test(`free move at ${zoomPct}%: 5 screen px short snaps onto the peer (IX-5a)`, async ({ page }) => {
      const board = await openBoard(page, zoomPct)
      const mover = board.content.locator(`[data-node-id="${nodeId(DIV.mover)}"]`).first()
      const zoom = await select(page, board, mover)
      // Aim the mover's left edge 5 SCREEN px short of the peer's.
      const frameDx = PEER_LEFT - MOVER_LEFT - 5 / zoom
      await dragBy(page, await centreOf(mover), frameDx * zoom, 0)
      await expect.poll(readPage, { timeout: 30_000 }).toContain(`left: "${PEER_LEFT}px"`)
      expect(await cssLeft(mover)).toBe(`${PEER_LEFT}px`)
    })

    test(`free move at ${zoomPct}%: 12 screen px short stays where it was dropped (IX-5a)`, async ({ page }) => {
      const board = await openBoard(page, zoomPct)
      const mover = board.content.locator(`[data-node-id="${nodeId(DIV.mover)}"]`).first()
      const zoom = await select(page, board, mover)
      const frameDx = PEER_LEFT - MOVER_LEFT - 12 / zoom
      await dragBy(page, await centreOf(mover), frameDx * zoom, 0)
      await expect.poll(readPage, { timeout: 30_000 }).not.toBe(FIXTURE_PAGE)
      const left = Number.parseFloat(await cssLeft(mover))
      // Where the pointer put it — within a pixel of rounding — and NOT on the peer.
      expect(Math.abs(left - (MOVER_LEFT + frameDx))).toBeLessThanOrEqual(1)
      expect(left).not.toBe(PEER_LEFT)
    })

    test(`resize at ${zoomPct}%: the E edge snaps onto the peer's right edge (IX-6e)`, async ({ page }) => {
      const board = await openBoard(page, zoomPct)
      const mover = board.content.locator(`[data-node-id="${nodeId(DIV.mover)}"]`).first()
      const zoom = await select(page, board, mover)
      const handle = board.content.locator('[data-canvas-resize-handle="e"]')
      await expect(handle).toBeVisible({ timeout: 15_000 })
      const frameDx = PEER_RIGHT - MOVER_RIGHT - 5 / zoom
      await dragBy(page, await centreOf(handle), frameDx * zoom, 0)
      await expect.poll(readPage, { timeout: 30_000 }).toContain(`width: "${PEER_RIGHT - MOVER_LEFT}px"`)
      const right = await mover.evaluate((el) => el.getBoundingClientRect().right)
      const peerRight = await board.content
        .locator(`[data-node-id="${nodeId(DIV.peer)}"]`)
        .first()
        .evaluate((el) => el.getBoundingClientRect().right)
      expect(Math.abs(right - peerRight)).toBeLessThanOrEqual(0.5)
    })
  }
})

test.describe('P2-E — drop context and measuring', () => {
  test.setTimeout(240_000)

  test('a before/after drop outlines the row it lands in (IX-24)', async ({ page }) => {
    const board = await openBoard(page, 100)
    const r1 = board.content.locator(`[data-node-id="${nodeId(DIV.r1)}"]`).first()
    const r2 = board.content.locator(`[data-node-id="${nodeId(DIV.r2)}"]`).first()
    const row = board.content.locator(`[data-node-id="${nodeId(DIV.row)}"]`).first()
    await select(page, board, r1)
    const from = await centreOf(r1)
    const r2Box = (await r2.boundingBox())!
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // Into r2's trailing half: an AFTER drop inside `row`.
    await page.mouse.move(r2Box.x + r2Box.width * 0.85, r2Box.y + r2Box.height / 2, { steps: 12 })
    await page.waitForTimeout(150)

    const outline = page.locator('[data-canvas-drop-parent="true"]')
    await expect(outline).toBeVisible()
    const [outlineBox, rowBox] = await Promise.all([outline.boundingBox(), row.boundingBox()])
    for (const side of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(outlineBox![side] - rowBox![side]), `outline ${side}`).toBeLessThanOrEqual(2)
    }

    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(outline).toBeHidden()
  })

  test('Alt with nothing hovered measures the selection to its parent (IX-19)', async ({ page }) => {
    const board = await openBoard(page, 100)
    const mover = board.content.locator(`[data-node-id="${nodeId(DIV.mover)}"]`).first()
    await select(page, board, mover)
    // Off every node: empty board, outside the frame.
    const rootBox = (await board.canvasRoot.boundingBox())!
    const frameBox = (await page.locator('[data-page-id]').first().boundingBox())!
    const emptyX = Math.min(rootBox.x + rootBox.width - 10, frameBox.x + frameBox.width + 40)
    await page.mouse.move(emptyX, rootBox.y + rootBox.height - 20)
    await page.waitForTimeout(150)

    await page.keyboard.down('Alt')
    const labels = board.content.locator('[data-canvas-measure-label][data-measure-kind="distance"]')
    // `stage`'s border box is the padding box (no border): 640 × 340.
    await expect.poll(async () => (await labels.allTextContents()).filter(Boolean).sort()).toEqual(['260', '40', '480', '60'])
    await page.keyboard.up('Alt')
  })

  test('click a Layers row, then →: the layer nudges (OD-15)', async ({ page }) => {
    const board = await openBoard(page, 100)
    const mover = board.content.locator(`[data-node-id="${nodeId(DIV.mover)}"]`).first()
    // Select the peer on the canvas first, so the Layers tree reveals its
    // container (and with it, the mover's row) — then pick the mover in Layers.
    await select(page, board, board.content.locator(`[data-node-id="${nodeId(DIV.peer)}"]`).first())
    const moverRow = page.getByTestId(`dom-tree-item-${nodeId(DIV.mover)}`)
    await moverRow.click()
    await expect(moverRow).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('ArrowRight')
    await expect.poll(readPage, { timeout: 30_000 }).toContain(`left: "${MOVER_LEFT + 1}px"`)
    expect(await cssLeft(mover)).toBe(`${MOVER_LEFT + 1}px`)
  })
})
