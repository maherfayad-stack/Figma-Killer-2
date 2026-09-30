import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Frame, type Locator, type Page } from '@playwright/test'
import { canvasContentFrame, liveBridgeIframe, settleCanvasFrameMode } from './helpers/canvasIframe'
import { giveFixtureARealVite } from './helpers/liveAnimatedFixture'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * Press-and-drag moves the layer the press MEANS — in a portal frame and in a
 * real Tier 2 (bridge) frame.
 *
 * The owner, verbatim: "I can't drag and drop components that have a click
 * state, because the state triggers first. Same with containers: when I click
 * and drag, it selects children before going to the next step."
 *
 * What this measures, every assertion on the real outcome (the source on disk,
 * computed style after layout, the frame's own DOM), never on a store flag:
 *
 *  - A component with a PRESSED state (`.toggle:active { background: red }`)
 *    shows its resting style under a held press on a design frame, so pressing
 *    it to pick it up is not "the click state firing".
 *  - Pressing a real `<button>` and dragging MOVES something — it used to be
 *    impossible (the form-control suppression cancelled the press and the drag
 *    trigger read that as "someone else's gesture").
 *  - What moves is the layer at the selection DEPTH: the top-level card, not
 *    the button under the pointer (`canvasPressTarget.ts`).
 *  - With a container selected, pressing a CHILD and dragging moves the
 *    container.
 *  - On a live frame the component's own `onClick` never runs under the
 *    press — its text stays "Off".
 */

const PAGE_ID = 'press'
const PAGE_REL = 'pages/Press.jsx'

const PAGE_SOURCE = `import { useState } from 'react'
import './Press.css'

export default function Press() {
  const [on, setOn] = useState(false)
  return (
    <main className="screen">
      <section className="card">
        <h2 className="card-title">Card title</h2>
        <button className="toggle" onClick={() => setOn(!on)}>{on ? 'On' : 'Off'}</button>
      </section>
      <section className="list">
        <p className="row">Row one</p>
        <p className="row">Row two</p>
      </section>
      <footer className="foot">Footer</footer>
    </main>
  )
}
`

/** Resting blue; PRESSED red and visibly smaller — the "click state". */
const PAGE_CSS = `.screen { display: flex; flex-direction: column; gap: 24px; padding: 24px; }
.card { display: flex; flex-direction: column; gap: 12px; padding: 16px; background: rgb(240, 240, 240); }
.card-title { margin: 0; font-size: 20px; }
.toggle { padding: 12px 20px; background: rgb(0, 0, 255); color: rgb(255, 255, 255); border: 0; }
.toggle:active { background: rgb(255, 0, 0); padding: 2px 4px; }
.list { display: flex; flex-direction: column; gap: 8px; padding: 16px; background: rgb(250, 250, 250); }
.row { margin: 0; }
.foot { padding: 16px; }
`

const RESTING_BLUE = 'rgb(0, 0, 255)'

function writePressFixture(name: string, trust: 'static' | 'run-project'): FixtureProject {
  const fixture = createAuthoredFixtureProject(name, {
    'package.json': JSON.stringify(
      {
        name: name.replace(/_/g, ''),
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite' },
        dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
        devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '^5.0.0' },
      },
      null,
      2,
    ),
    '.studio/meta.json': JSON.stringify(
      { displayName: `Zz ${name}`, platform: 'web', pagesDir: 'pages', trust, frameDefaults: { width: 480, height: 640 } },
      null,
      2,
    ),
    '.studio/boards.json': JSON.stringify(
      {
        version: 1,
        boards: [
          {
            id: `${name}-board`,
            name: 'Press',
            frames: [{ id: `${name}-frame`, pageId: PAGE_ID, x: 0, y: 0, width: 480 }],
            notes: [],
            docs: [],
            guides: [],
          },
        ],
      },
      null,
      2,
    ),
    [PAGE_REL]: PAGE_SOURCE,
    'pages/Press.css': PAGE_CSS,
  })
  if (trust === 'run-project') giveFixtureARealVite(fixture)
  return fixture
}

/** The editor's selected node id, read from its own store (the dev bundle serves it as a module). */
async function selectedNodeId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
    return useEditorStore.getState().selectedNodeId as string | null
  })
}

function readPage(fixture: FixtureProject): string {
  return fs.readFileSync(path.join(fixture.dir, ...PAGE_REL.split('/')), 'utf8')
}

/** Poll the source until `predicate` holds — a structural write is async (save → writeback). */
async function waitForSource(fixture: FixtureProject, predicate: (source: string) => boolean, message: string): Promise<string> {
  let source = readPage(fixture)
  await expect
    .poll(() => {
      source = readPage(fixture)
      return predicate(source)
    }, { message, timeout: 30_000 })
    .toBe(true)
  return source
}

/** `a` appears before `b` in the source. */
function before(source: string, a: string, b: string): boolean {
  const ia = source.indexOf(a)
  const ib = source.indexOf(b)
  return ia >= 0 && ib >= 0 && ia < ib
}

async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  if (!box) throw new Error('drag target has no bounding box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Press on `from`, travel well past the activation distance, release just inside `to`'s bottom edge (an "after" slot). */
async function pressDragBelow(page: Page, from: Locator, to: Locator): Promise<void> {
  const start = await centerOf(from)
  const box = await to.boundingBox()
  if (!box) throw new Error('drop target has no bounding box')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3, { steps: 16 })
  await page.waitForTimeout(400)
  await page.mouse.up()
}

/** Press on `from` and release just inside `to`'s TOP edge (a "before" slot). */
async function pressDragAbove(page: Page, from: Locator, to: Locator): Promise<void> {
  const start = await centerOf(from)
  const box = await to.boundingBox()
  if (!box) throw new Error('drop target has no bounding box')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y - 10, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2, box.y + 3, { steps: 16 })
  await page.waitForTimeout(400)
  await page.mouse.up()
}

/** The computed background of `target` while the primary button is held on it, then released without moving. */
async function backgroundUnderHeldPress(page: Page, target: Locator): Promise<string> {
  const start = await centerOf(target)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.waitForTimeout(150)
  const background = await target.evaluate((el) => getComputedStyle(el).backgroundColor)
  await page.mouse.up()
  return background
}

test.describe('press-and-drag moves the layer the press means', () => {
  test.setTimeout(300_000)

  test.describe('a portal (design) frame', () => {
    let fixture: FixtureProject

    test.beforeEach(() => {
      fixture = writePressFixture('__e2e-press-drag-portal', 'static')
    })

    test.afterEach(() => removeFixtureProject(fixture))

    test('the pressed state never shows, a press selects the top-level card, and press-drag on the button moves the CARD', async ({ page }) => {
      const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
      const boardFrame = await frameForPage(page, canvasRoot, PAGE_ID)
      const content = canvasContentFrame(boardFrame)
      const toggle = content.locator('.toggle').first()
      await expect(toggle).toBeVisible({ timeout: 30_000 })
      const cardId = await content.locator('.card').first().getAttribute('data-node-id')
      expect(cardId, 'the card is not a canvas node').toBeTruthy()

      // 1. A held press is the editor's: `.toggle:active` never matches.
      expect(await backgroundUnderHeldPress(page, toggle)).toBe(RESTING_BLUE)

      // 2. That press was a click: it selected the TOP-LEVEL card — not the
      //    button (a real <button> used to select itself on pointerdown).
      const ring = content.locator('[data-canvas-selection-ring="true"]')
      await expect(ring).toHaveCount(1, { timeout: 15_000 })
      await expect(ring.first()).toHaveAttribute('data-canvas-overlay-node-id', cardId!)

      // 3. Press the BUTTON and drag it below the footer: the card moves, with
      //    the button still inside it.
      await pressDragBelow(page, toggle, content.locator('.foot').first())
      const source = await waitForSource(
        fixture,
        (s) => before(s, 'className="foot"', 'className="card"'),
        'pressing the button and dragging it below the footer did not move the card there',
      )
      expect(before(source, 'className="card"', 'className="toggle"'), 'the button left its card').toBe(true)
      expect(before(source, 'className="card-title"', 'className="toggle"'), 'the card was reordered inside, not moved').toBe(true)
    })

    test('with a container selected, pressing its CHILD and dragging moves the container', async ({ page }) => {
      const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
      const boardFrame = await frameForPage(page, canvasRoot, PAGE_ID)
      const content = canvasContentFrame(boardFrame)
      const row = content.locator('.row').first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      const listId = await content.locator('.list').first().getAttribute('data-node-id')

      // A plain click on a row selects the list it sits in (the top level).
      const rowCenter = await centerOf(row)
      await page.mouse.click(rowCenter.x, rowCenter.y)
      const ring = content.locator('[data-canvas-selection-ring="true"]')
      await expect(ring.first()).toHaveAttribute('data-canvas-overlay-node-id', listId!, { timeout: 15_000 })

      // Press the ROW and drag above the card: the LIST moves, rows intact.
      await pressDragAbove(page, row, content.locator('.card').first())
      const source = await waitForSource(
        fixture,
        (s) => before(s, 'className="list"', 'className="card"'),
        'pressing a row of the selected list and dragging it above the card did not move the list',
      )
      const listStart = source.indexOf('className="list"')
      const cardStart = source.indexOf('className="card"')
      const rowsInList = source.slice(listStart, cardStart).split('className="row"').length - 1
      expect(rowsInList, 'a row was dragged out of the list instead of the list moving').toBe(2)
      // The selection stayed on what moved.
      await expect(ring.first()).toHaveAttribute('data-canvas-overlay-node-id', /./, { timeout: 15_000 })
    })
  })

  /**
   * The owner: "when clicking on empty place in the canvas, deselect
   * everything." A CLICK on the empty board clears every selection; a PAN
   * that starts on the empty board (Space held) never does.
   */
  test.describe('the empty board', () => {
    let fixture: FixtureProject

    test.beforeEach(() => {
      fixture = writePressFixture('__e2e-press-drag-board', 'static')
    })

    test.afterEach(() => removeFixtureProject(fixture))

    /** A point on the canvas where the empty board itself is the top-most element. */
    async function emptyBoardPoint(page: Page, canvasRoot: Locator): Promise<{ x: number; y: number }> {
      const box = await canvasRoot.boundingBox()
      if (!box) throw new Error('the canvas root has no box')
      const point = await page.evaluate((b) => {
        for (let fy = 0.9; fy >= 0.1; fy -= 0.1) {
          for (let fx = 0.95; fx >= 0.05; fx -= 0.05) {
            const x = b.x + b.width * fx
            const y = b.y + b.height * fy
            const hit = document.elementFromPoint(x, y) as HTMLElement | null
            if (hit?.dataset.studioCanvasRoot === 'true' || hit?.dataset.testid === 'canvas-transform-layer') return { x, y }
          }
        }
        return null
      }, box)
      if (!point) throw new Error('no empty board point on screen')
      return point
    }

    test('a click on the empty board deselects everything; a Space-pan from it does not', async ({ page }) => {
      const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
      const boardFrame = await frameForPage(page, canvasRoot, PAGE_ID)
      const content = canvasContentFrame(boardFrame)
      const row = content.locator('.row').first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      const ring = content.locator('[data-canvas-selection-ring="true"]')

      // Select something, then pan with Space held from the empty board: a pan
      // is not a click, and the selection survives it.
      const rowCenter = await centerOf(row)
      await page.mouse.click(rowCenter.x, rowCenter.y)
      await expect.poll(() => selectedNodeId(page), { timeout: 15_000 }).not.toBeNull()
      const empty = await emptyBoardPoint(page, canvasRoot)
      await page.mouse.move(empty.x, empty.y)
      await page.keyboard.down('Space')
      await page.mouse.down()
      await page.mouse.move(empty.x - 40, empty.y - 30, { steps: 6 })
      await page.mouse.up()
      await page.keyboard.up('Space')
      await page.waitForTimeout(300)
      expect(await selectedNodeId(page), 'a Space-pan from the empty board cleared the selection').not.toBeNull()

      // A plain click on the empty board: nothing selected, no ring drawn.
      const again = await emptyBoardPoint(page, canvasRoot)
      await page.mouse.click(again.x, again.y)
      await expect.poll(() => selectedNodeId(page), { timeout: 15_000 }).toBeNull()
      await expect(ring).toHaveCount(0, { timeout: 15_000 })

      // At a far-out zoom too (the pan above moved the row).
      const rowNow = await centerOf(row)
      await page.mouse.click(rowNow.x, rowNow.y)
      await expect.poll(() => selectedNodeId(page), { timeout: 15_000 }).not.toBeNull()
      await page.mouse.move(again.x, again.y)
      await page.keyboard.down('ControlOrMeta')
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.wheel(0, 200)
        await page.waitForTimeout(120)
      }
      await page.keyboard.up('ControlOrMeta')
      await page.waitForTimeout(400)
      const far = await emptyBoardPoint(page, canvasRoot)
      await page.mouse.click(far.x, far.y)
      await expect.poll(() => selectedNodeId(page), { timeout: 15_000 }).toBeNull()
    })
  })

  /**
   * The owner's own case: a design-system `<Button>` (an `alm.*` node — a
   * `display: contents` host around the real `<button>` the library renders),
   * SELECTED, pressed and dragged. It moved only from Layers: the press landed
   * on a real `<button>`, which the canvas cancels so it cannot focus, and the
   * drag trigger read that cancellation as "not mine".
   */
  test.describe('a design-system component', () => {
    const DS_REL = 'pages/Home.tsx'
    const DS_PAGE = `import { Button } from '../design-system'

export default function Home() {
  return (
    <main style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <h1 className="title">Buttons</h1>
      <Button variant="primary" label="First" />
      <Button variant="secondary" label="Second" />
      <p className="note">After</p>
    </main>
  )
}
`
    let fixture: FixtureProject

    test.beforeEach(() => {
      fixture = createAuthoredFixtureProject('__e2e-press-drag-ds', {
        [DS_REL]: DS_PAGE,
        // Only that `Button` RESOLVES inside `design-system/` matters (`design-system-insert.e2e.ts`).
        'design-system/index.js': 'export function Button() { return null }\n',
        '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
      })
    })

    test.afterEach(() => removeFixtureProject(fixture))

    const readDsPage = () => fs.readFileSync(path.join(fixture.dir, ...DS_REL.split('/')), 'utf8')

    test('select an ALM Button, press it and drag it below its next sibling: the source order changes in ONE save', async ({ page }) => {
      const saves: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request.url())
      })
      const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
      const boardFrame = await frameForPage(page, canvasRoot, 'home')
      const content = canvasContentFrame(boardFrame)
      const firstId = sourceNodeId(DS_PAGE, DS_REL, 'Button', 1)
      const secondId = sourceNodeId(DS_PAGE, DS_REL, 'Button', 2)
      // The design-system host is `display: contents` — press what it renders.
      const first = content.locator(`[data-node-id="${firstId}"] button`).first()
      const second = content.locator(`[data-node-id="${secondId}"] button`).first()
      await expect(first).toBeVisible({ timeout: 30_000 })

      // Select it the way the owner did: a plain click (it is a top-level layer).
      const center = await centerOf(first)
      await page.mouse.click(center.x, center.y)
      await expect.poll(() => selectedNodeId(page), { timeout: 15_000 }).toBe(firstId)

      // The library's pressed state (`.btn:active` shrinks the padding) never
      // shows under a held press on a design frame.
      const resting = await first.evaluate((el) => getComputedStyle(el).paddingTop)
      await page.mouse.move(center.x, center.y)
      await page.mouse.down()
      await page.waitForTimeout(150)
      expect(await first.evaluate((el) => getComputedStyle(el).paddingTop), 'the button showed its pressed state').toBe(resting)
      await page.mouse.up()

      const savesBefore = saves.length
      await pressDragBelow(page, first, second)
      await expect
        .poll(() => before(readDsPage(), 'label="Second"', 'label="First"'), {
          message: 'pressing the selected design-system Button and dragging it below the next one did not reorder the source',
          timeout: 30_000,
        })
        .toBe(true)
      await page.waitForTimeout(1500)
      expect(saves.length - savesBefore, 'the move was not exactly one save').toBe(1)
      expect(before(readDsPage(), 'label="First"', 'className="note"'), 'the Button left its container').toBe(true)
      // What moved stays selected.
      await expect.poll(() => selectedNodeId(page), { timeout: 15_000 }).not.toBeNull()
    })
  })

  test.describe('a live (Tier 2 bridge) frame', () => {
    let fixture: FixtureProject

    test.beforeAll(() => {
      fixture = writePressFixture('__e2e-press-drag-live', 'run-project')
    })

    test.afterEach(async ({ page }) => {
      if (page.url() === 'about:blank') return
      await page.request
        .post('/admin/api/studio/dev-server/stop', { data: { dir: fixture.dir }, headers: { Origin: new URL(page.url()).origin } })
        .catch(() => undefined)
    })

    test.afterAll(() => removeFixtureProject(fixture))

    test('the component’s own click and pressed state never fire, and press-drag on its button moves the card', async ({ page }) => {
      const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
      const boardFrame = await frameForPage(page, canvasRoot, PAGE_ID)
      const mode = await settleCanvasFrameMode(page, boardFrame, fixture.dir, 180_000)
      expect(mode, "the fixture's dev server never booted, so there is no live frame (see liveAnimatedFixture.ts)").toBe('live')
      const handle = await liveBridgeIframe(boardFrame).elementHandle()
      const live: Frame | null = (await handle?.contentFrame()) ?? null
      if (!live) throw new Error('the live bridge iframe has no content frame')
      const toggle = live.locator('.toggle').first()
      await expect(toggle).toHaveText('Off', { timeout: 60_000 })

      // A held press on a design frame is the editor's — no pressed state.
      expect(await backgroundUnderHeldPress(page, toggle)).toBe(RESTING_BLUE)
      // …and the component's own onClick never ran.
      await expect(toggle).toHaveText('Off')

      await pressDragBelow(page, toggle, live.locator('.foot').first())
      const source = await waitForSource(
        fixture,
        (s) => before(s, 'className="foot"', 'className="card"'),
        'pressing the button in a LIVE frame and dragging it below the footer did not move the card there',
      )
      expect(before(source, 'className="card-title"', 'className="toggle"'), 'the button left its card').toBe(true)
      await expect(toggle, 'the press-drag ran the component’s own click').toHaveText('Off')
    })
  })
})
