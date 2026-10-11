import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WORKSPACE_ROOT } from './helpers/constants'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * SB-4 — selection chrome is parent-document DOM (`docs/programs/board-speed.md`).
 * Real layout, because every claim is about pixels or about what a frame's
 * document was asked to do (`standing-02`: happy-dom lays nothing out).
 *
 *   1. Nothing of the editor's is ever written into a frame: a hover sweep
 *      produces ZERO mutation records in the frame document; a selection
 *      produces only the node's own `data-canvas-selected` marker (and no node,
 *      no style, no stylesheet), and the chrome root is a sibling of the iframe.
 *   2. Rings stay on their element at every zoom, pixel for pixel, and the line
 *      is one SCREEN pixel wide at every zoom (`--px`, counter-scaled).
 *   3. Handles stay the same size on screen at every zoom.
 *   4. A frame's chrome moves with the frame: dragging the frame carries the
 *      ring, with no pass of its own.
 */

const FIXTURE_NAME = '__e2e-parent-chrome'

const FILES: Record<string, string> = {
  'pages/Home.css': `.page { padding: 24px; display: flex; flex-direction: column; gap: 24px; }
.row { display: flex; gap: 16px; }
.box { width: 120px; height: 80px; background: #5c6bc0; }
.title { margin: 0; font-size: 22px; }
`,
  'pages/Home.tsx': `import './Home.css'

export default function Home() {
  return (
    <div className="page">
      <h1 className="title">Parent chrome</h1>
      <div className="row">
        <div className="box box-a" />
        <div className="box box-b" />
        <div className="box box-c" />
      </div>
    </div>
  )
}
`,
}

let fixture: FixtureProject

/** Playwright re-runs `beforeAll` after a failure while the dev server holds the directory (Windows refuses the `rm`): reuse it then. */
function fixtureOrExisting(): FixtureProject {
  try {
    return createAuthoredFixtureProject(FIXTURE_NAME, FILES)
  } catch (err) {
    const dir = path.join(WORKSPACE_ROOT, FIXTURE_NAME)
    if (fs.existsSync(dir)) return { dir, ready: true }
    throw err
  }
}

test.beforeAll(() => {
  fixture = fixtureOrExisting()
})
test.afterAll(() => removeFixtureProject(fixture))

interface Opened {
  canvasRoot: Locator
  frame: Locator
  box: (name: 'a' | 'b' | 'c') => Locator
}

async function open(page: Page): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toHaveCount(1, { timeout: 60_000 })
  const content = canvasContentFrame(frame)
  await expect(content.locator('.box-a')).toBeVisible({ timeout: 30_000 })
  return { canvasRoot, frame, box: (name) => content.locator(`.box-${name}`) }
}

async function canvasScale(page: Page): Promise<number> {
  return page.getByTestId('canvas-transform-layer').evaluate((el) => {
    const match = /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)
    return match ? Number(match[1]) : NaN
  })
}

async function pageBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('no bounding box')
  return box
}

test.describe('SB-4 — parent-side selection chrome', () => {
  test.setTimeout(240_000)

  test('a hover writes nothing into the frame, a selection only its own marker, and the chrome is a sibling of the iframe', async ({ page }) => {
    const { frame, box } = await open(page)
    const iframe = visibleCanvasIframe(frame)
    await iframe.evaluate((element) => {
      const doc = (element as HTMLIFrameElement).contentDocument!
      const state = { records: [] as Array<{ type: string; attribute: string | null }>, observer: null as MutationObserver | null }
      state.observer = new MutationObserver((records) => {
        for (const record of records) state.records.push({ type: record.type, attribute: record.attributeName })
      })
      state.observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
      ;(window as unknown as { __sb4Frame: typeof state }).__sb4Frame = state
    })
    const read = () =>
      page.evaluate(() => {
        const state = (window as unknown as { __sb4Frame: { records: Array<{ type: string; attribute: string | null }>; observer: MutationObserver } }).__sb4Frame
        const taken = [...state.records, ...state.observer.takeRecords().map((r) => ({ type: r.type, attribute: r.attributeName }))]
        state.records.length = 0
        return taken
      })

    // Hover across the three boxes and out again.
    for (const name of ['a', 'b', 'c'] as const) {
      const b = await pageBox(box(name))
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 })
      await page.waitForTimeout(80)
    }
    await page.mouse.move(10, 10)
    await page.waitForTimeout(150)
    expect(await read(), 'a hover wrote into the frame document').toEqual([])

    // A selection (⌘-click: the box itself).
    await selectInFrame(page, box('b'))
    await expect(page.locator('[data-canvas-selection-ring="true"]')).toBeAttached({ timeout: 10_000 })
    await page.waitForTimeout(300)
    const afterSelect = await read()
    const stray = afterSelect.filter((r) => !(r.type === 'attributes' && r.attribute === 'data-canvas-selected'))
    expect(stray, 'a selection wrote more than the selected node\'s own marker into the frame').toEqual([])

    // The chrome root sits beside the iframe, in the frame's viewport box - not in the frame's document.
    const placement = await iframe.evaluate((element) => {
      const root = (element as HTMLIFrameElement).parentElement!.querySelector('[data-canvas-frame-chrome]')
      return { sibling: root !== null && root.parentElement === (element as HTMLIFrameElement).parentElement, inFrame: (element as HTMLIFrameElement).contentDocument!.querySelector('[data-canvas-selection-ring], [data-canvas-hover-ring], [data-canvas-frame-chrome]') !== null }
    })
    expect(placement).toEqual({ sibling: true, inFrame: false })
  })

  test('the ring stays on its element at 35%, 100% and 200%, and is one screen pixel wide at each', async ({ page }) => {
    const { canvasRoot, box } = await open(page)
    for (const pct of [100, 35, 200]) {
      await zoomToPercent(page, canvasRoot, pct)
      await page.waitForTimeout(250)
      await panIntoView(page, canvasRoot, box('b'), 80)
      await page.keyboard.press('Escape')
      await selectInFrame(page, box('b'))
      const ring = page.locator('[data-canvas-selection-ring="true"]').first()
      await expect(ring).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(250)
      const [ringBox, boxBox, scale] = await Promise.all([pageBox(ring), pageBox(box('b')), canvasScale(page)])
      const drift = Math.max(
        Math.abs(ringBox.x - boxBox.x),
        Math.abs(ringBox.y - boxBox.y),
        Math.abs(ringBox.width - boxBox.width),
        Math.abs(ringBox.height - boxBox.height),
      )
      expect(drift, `ring drifted ${drift.toFixed(2)} px from its element at ${pct}% (ring ${JSON.stringify(ringBox)}, element ${JSON.stringify(boxBox)})`).toBeLessThanOrEqual(1.5)
      // The line: a counter-scaled inset shadow whose spread, drawn through the board's scale, is one screen pixel.
      const spread = await ring.evaluate((el) => {
        const match = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(getComputedStyle(el).boxShadow)
        return match ? Number(match[4]) : NaN
      })
      expect(spread * scale, `the ring line is ${(spread * scale).toFixed(2)} screen px at ${pct}%`).toBeGreaterThan(0.9)
      expect(spread * scale).toBeLessThan(1.1)
    }
  })

  test('the handles are the same size on screen at every zoom', async ({ page }) => {
    const { canvasRoot, box } = await open(page)
    const sizes: Array<{ pct: number; width: number }> = []
    for (const pct of [50, 200]) {
      await zoomToPercent(page, canvasRoot, pct)
      await page.waitForTimeout(250)
      await panIntoView(page, canvasRoot, box('b'), 80)
      await selectInFrame(page, box('b'))
      const corner = page.locator('[data-canvas-resize-handle="se"]')
      await expect(corner).toBeVisible({ timeout: 10_000 })
      sizes.push({ pct, width: (await pageBox(corner)).width })
    }
    for (const { pct, width } of sizes) expect(Math.abs(width - 9), `the corner handle is ${width.toFixed(2)} screen px at ${pct}%`).toBeLessThanOrEqual(1)
  })

  test('the chrome moves with its frame: dragging the frame by its header carries the ring', async ({ page }) => {
    const { frame, box } = await open(page)
    await selectInFrame(page, box('b'))
    const ring = page.locator('[data-canvas-selection-ring="true"]').first()
    await expect(ring).toBeVisible({ timeout: 10_000 })
    const header = frame.locator('[data-testid="board-frame-header"]').first()
    await expect(header).toBeVisible()
    const h = await pageBox(header)
    const before = { ring: await pageBox(ring), box: await pageBox(box('b')) }
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(h.x + h.width / 2 + 60, h.y + h.height / 2 + 40, { steps: 8 })
    // Mid-drag, with the button still down: the ring is where the element is.
    const during = { ring: await pageBox(ring), box: await pageBox(box('b')) }
    await page.mouse.up()
    expect(Math.abs(during.box.x - before.box.x - 60), 'the frame did not move with the header').toBeLessThanOrEqual(3)
    expect(Math.abs(during.ring.x - during.box.x), 'the ring lagged its element while the frame moved').toBeLessThanOrEqual(1.5)
    expect(Math.abs(during.ring.y - during.box.y)).toBeLessThanOrEqual(1.5)
  })
})
