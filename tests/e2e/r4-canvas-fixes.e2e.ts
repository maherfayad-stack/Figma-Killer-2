import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import { zoomToPercent } from './helpers/studioFixtureProject'

/**
 * Round-4 canvas audit fixes, each replayed with a REAL mouse and keyboard and
 * asserted on computed layout and on the bytes on disk (never on the store):
 *
 *   N1  a drop onto a void element (`<input>`) never writes children into it;
 *   N3  a press on an absolute instance does not move it, and a nudge writes
 *       the authored offset +-1;
 *   N2  Space + drag on a selected element pans the board, never moves it.
 *
 * The fixture mirrors the audit's SMS screen: a relative page whose layers are
 * absolutely placed by a CSS MODULE class, a code row of `<input>`s, design
 * system Buttons, and a TabBar instance pinned with an inline `bottom`.
 *
 * SAFETY - only this run's throwaway fixture under the e2e workspace is written.
 */

const REL = 'pages/Home.tsx'
const HOME = `import { Button, TabBar } from '../design-system'
import styles from './Home.module.css'

export default function Home() {
  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <p>status</p>
      </div>
      <div className={styles.banner}>
        <h1 className={styles.title}>Verify</h1>
        <div className={styles.form}>
          <div className={styles.codeInputs}>
            <input className={styles.codeInput} type="text" maxLength={1} aria-label="digit 1" />
            <input className={styles.codeInput} type="text" maxLength={1} aria-label="digit 2" />
            <input className={styles.codeInput} type="text" maxLength={1} aria-label="digit 3" />
          </div>
          <p className={styles.note}>resend</p>
          <p className={styles.long}>
            One page, so the board has one frame. The point of this project is not what it renders — it is
            that Studio classifies it as a Vite project.
          </p>
          <button className={styles.action} type="button">
            Nothing happens
          </button>
          <Button label="One" size="default" variant="primary" style={{ width: "223px" }} />
          <Button label="Two" size="default" variant="primary" style={{ width: "223px" }} />
        </div>
      </div>
      <TabBar items={[
        { icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 4h16v16H4z" fill="currentColor" /></svg>, label: "Home" },
        { icon: <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 4h16v16H4z" fill="currentColor" /></svg>, label: "Explore" },
      ]} platform="ios" value={0} style={{ position: "absolute", bottom: "10px" }} />
    </main>
  )
}
`
const CSS = `.page { position: relative; box-sizing: border-box; width: 100%; min-height: 600px; background: #fff; }
.header { position: absolute; inset: 0 0 auto 0; z-index: 1; height: 60px; }
.banner { position: absolute; inset: 124px 0 auto 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; padding: 16px; overflow: hidden; background: #fafafa; }
.page p { margin: 0; }
.title { margin: 0; }
.form { display: flex; flex-direction: column; gap: 16px; width: 100%; }
.codeInputs { display: flex; gap: 8px; }
.codeInput { width: 44px; height: 48px; box-sizing: border-box; }
.note { margin: 0; }
.action { width: 160px; padding: 10px 14px; font: inherit; text-align: center; border: 1px solid #888; }
.long { margin: 0; max-width: 300px; line-height: 1.5; text-align: center; padding: 6px 10px; }
`
const DS_INDEX = `export function Button() { return null }\nexport function TabBar() { return null }\n`

const ID = {
  main: sourceNodeId(HOME, REL, 'main'),
  banner: sourceNodeId(HOME, REL, 'div', 2),
  input1: sourceNodeId(HOME, REL, 'input', 1),
  tabBar: sourceNodeId(HOME, REL, 'TabBar'),
}

test.use({ viewport: { width: 1600, height: 1000 } })

let fixture: FixtureProject
const readFile = (rel: string): string => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-r4-canvas-fixes', {
    [REL]: HOME,
    'pages/Home.module.css': CSS,
    'design-system/index.js': DS_INDEX,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Opened {
  canvasRoot: Locator
  home: FrameLocator
  homeFrame: Locator
  node: (id: string) => Locator
}

async function openHome(page: Page, zoomPercent = 100): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  if (zoomPercent !== 100) await zoomToPercent(page, canvasRoot, zoomPercent)
  const homeFrame = page.locator('[data-page-id="home"]').first()
  await panIntoView(page, canvasRoot, homeFrame)
  await expect(visibleCanvasIframe(homeFrame)).toHaveCount(1, { timeout: 60_000 })
  const home = canvasContentFrame(homeFrame)
  const node = (id: string) => home.locator(`[data-node-id="${id}"]`).first()
  await expect(node(ID.input1)).toBeAttached({ timeout: 30_000 })
  return { canvasRoot, home, homeFrame, node }
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** The union box of a node in editor client px (a `display: contents` host measures as its children). */
async function visualBox(node: Locator): Promise<Box> {
  return node.evaluate((el) => {
    const union = (e: Element, depth: number): Box | null => {
      const r = e.getBoundingClientRect()
      if (r.width || r.height) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      if (depth > 4) return null
      let out: Box | null = null
      for (const c of Array.from(e.children)) {
        const b = union(c, depth + 1)
        if (!b) continue
        out = out
          ? { left: Math.min(out.left, b.left), top: Math.min(out.top, b.top), right: Math.max(out.right, b.right), bottom: Math.max(out.bottom, b.bottom) }
          : b
      }
      return out
    }
    const box = union(el, 0)
    if (!box) throw new Error('node has no visual box')
    const frameEl = el.ownerDocument.defaultView!.frameElement as HTMLIFrameElement
    const fr = frameEl.getBoundingClientRect()
    const s = frameEl.clientWidth > 0 ? fr.width / frameEl.clientWidth : 1
    return { left: fr.left + box.left * s, top: fr.top + box.top * s, right: fr.left + box.right * s, bottom: fr.top + box.bottom * s }
  })
}

const centre = (b: Box) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 })

async function dragNotchTo(page: Page, buttonTestId: string, to: { x: number; y: number }): Promise<void> {
  const from = (await page.getByTestId(buttonTestId).boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 14 })
  await page.waitForTimeout(200)
}

test.describe('N1: a void element never receives children', () => {
  test.setTimeout(240_000)

  test('the notch Div released over an <input> lands beside it, never inside', async ({ page }) => {
    const { node } = await openHome(page)
    const at = centre(await visualBox(node(ID.input1)))
    await dragNotchTo(page, 'canvas-notch-div-btn', at)
    await page.mouse.up()
    await expect.poll(() => readFile(REL), { timeout: 30_000 }).not.toBe(HOME)
    const src = readFile(REL)
    expect(src, 'children were written into a void <input>').not.toContain('</input>')
    expect(src.match(/<input /g)?.length).toBe(3)
    // The new div sits in the code row, as a sibling of the inputs.
    const row = src.slice(src.indexOf('className={styles.codeInputs}'), src.indexOf('className={styles.note}'))
    expect(row).toMatch(/<div\b/)
  })
})

test.describe('N3: an absolute instance does not shift on press, and nudges by one', () => {
  test.setTimeout(240_000)

  test('a plain press keeps the instance in place and ArrowUp writes bottom 11px', async ({ page }) => {
    const { node } = await openHome(page)
    const before = await visualBox(node(ID.tabBar))
    const at = centre(before)
    await page.keyboard.down('ControlOrMeta')
    await page.mouse.click(at.x, at.y)
    await page.keyboard.up('ControlOrMeta')
    await page.waitForTimeout(400)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.waitForTimeout(250)
    const held = await visualBox(node(ID.tabBar))
    await page.mouse.up()
    await page.waitForTimeout(400)
    const after = await visualBox(node(ID.tabBar))
    expect(Math.abs(held.top - before.top), 'the instance jumped while pressed').toBeLessThanOrEqual(0.5)
    expect(Math.abs(after.top - before.top), 'the instance jumped after the press').toBeLessThanOrEqual(0.5)
    expect(readFile(REL), 'a press alone wrote to disk').toBe(HOME)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => readFile(REL), { timeout: 30_000 }).toContain('bottom: "11px"')
    await expect.poll(async () => (await visualBox(node(ID.tabBar))).top, { timeout: 10_000 }).toBeCloseTo(before.top - 1, 0)
  })
})

test.describe('N2: Space + drag pans, it never moves the selection', () => {
  test.setTimeout(240_000)

  test('Space + drag starting on a selected absolute layer pans the board and writes nothing', async ({ page }) => {
    const { node, homeFrame } = await openHome(page)
    await selectInFrame(page, node(ID.banner))
    await page.waitForTimeout(400)
    const at = centre(await visualBox(node(ID.banner)))
    const frameBefore = (await homeFrame.boundingBox())!
    await page.keyboard.down('Space')
    await page.waitForTimeout(150)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 80, at.y + 50, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    await page.waitForTimeout(500)
    const frameAfter = (await homeFrame.boundingBox())!
    expect(readFile(REL), 'Space-drag moved the layer in source').toBe(HOME)
    expect(Math.abs(frameAfter.x - frameBefore.x - 80), 'the board did not pan').toBeLessThanOrEqual(3)
    expect(Math.abs(frameAfter.y - frameBefore.y - 50)).toBeLessThanOrEqual(3)
    expect(readFile(REL), 'Space-drag moved the layer in source').toBe(HOME)
  })
})

/** Every glyph run under `node`, as editor-relative frame px rects: one per text node line box. */
async function glyphRects(node: Locator): Promise<Box[]> {
  return node.evaluate((el) => {
    const out: { left: number; top: number; right: number; bottom: number }[] = []
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent || !t.textContent.trim()) continue
      const range = el.ownerDocument.createRange()
      range.selectNodeContents(t)
      for (const r of Array.from(range.getClientRects())) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
    return out
  })
}

const unionOf = (rects: Box[]): Box => ({
  left: Math.min(...rects.map((r) => r.left)),
  top: Math.min(...rects.map((r) => r.top)),
  right: Math.max(...rects.map((r) => r.right)),
  bottom: Math.max(...rects.map((r) => r.bottom)),
})

test.describe('O3: entering inline edit never moves a glyph', () => {
  test.setTimeout(240_000)

  for (const [label, id] of [
    ['a plain <h1>', sourceNodeId(HOME, REL, 'h1')],
    ['a plain <p>', sourceNodeId(HOME, REL, 'p', 2)],
    ['a wrapped, centred, padded multi-line <p>', sourceNodeId(HOME, REL, 'p', 3)],
    ['a native <button> label', sourceNodeId(HOME, REL, 'button')],
  ] as const) {
    test(`${label}: glyph rects are identical before, during and while typing`, async ({ page }) => {
      const { node, home } = await openHome(page)
      const before = unionOf(await glyphRects(node(id)))
      const at = centre(await visualBox(node(id)))
      const editable = home.locator('[contenteditable]:not([contenteditable="false"])')
      await page.mouse.dblclick(at.x, at.y)
      await expect(editable.first(), 'inline edit never started').toBeAttached({ timeout: 15_000 })
      await page.waitForTimeout(400)
      const during = unionOf(await glyphRects(editable.first()))
      for (const key of ['left', 'top', 'right', 'bottom'] as const) {
        expect(Math.abs(during[key] - before[key]), `${label}: the ${key} edge of the text moved when editing began`).toBeLessThanOrEqual(0.5)
      }
      await page.keyboard.press('End')
      await page.keyboard.type('x')
      await page.waitForTimeout(300)
      const typed = unionOf(await glyphRects(editable.first()))
      // A typed letter widens the line (a centred line grows both ways), so only the vertical position is invariant.
      expect(Math.abs(typed.top - before.top), `${label}: text moved vertically while typing`).toBeLessThanOrEqual(0.5)
    })
  }
})

/** A client point whose hit test is the empty board itself (the canvas root), scanned rather than guessed. */
async function findEmptyBoardPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const root = document.querySelector('[data-studio-canvas-root="true"]')
    if (!(root instanceof HTMLElement)) return null
    const r = root.getBoundingClientRect()
    for (let iy = 1; iy < 24; iy += 1) {
      for (let ix = 1; ix < 24; ix += 1) {
        const x = r.left + (r.width * ix) / 24
        const y = r.top + (r.height * iy) / 24
        if (document.elementFromPoint(x, y) === root) return { x, y }
      }
    }
    return null
  })
  expect(point, 'no empty board point on screen').not.toBeNull()
  return point!
}

const selectedInFrames = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).reduce((count, frame) => {
      const doc = frame.contentDocument
      return count + (doc ? doc.querySelectorAll('[data-canvas-selected="true"], [data-canvas-selection-ring="true"]').length : 0)
    }, 0),
  )

test.describe('D1: a plain click on the empty board clears the selection', () => {
  test.setTimeout(240_000)

  test('after selecting a layer in a frame', async ({ page }) => {
    const { node, canvasRoot } = await openHome(page)
    await selectInFrame(page, node(ID.banner))
    await expect.poll(() => selectedInFrames(page), { timeout: 10_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(600)
    const at = await findEmptyBoardPoint(page)
    await page.mouse.click(at.x, at.y)
    await expect.poll(() => selectedInFrames(page), { timeout: 10_000, message: 'a ring is still drawn after the board click' }).toBe(0)
    await expect(page.getByTestId('right-sidebar')).not.toHaveAttribute('data-expanded', 'true', { timeout: 10_000 })
    void canvasRoot
  })

  test('after selecting a layer, with the Layers panel focused before the click', async ({ page }) => {
    const { node } = await openHome(page)
    await selectInFrame(page, node(ID.banner))
    await page.waitForTimeout(600)
    await page.getByText('Container').first().click()
    await page.waitForTimeout(300)
    const at = await findEmptyBoardPoint(page)
    await page.mouse.click(at.x, at.y)
    await expect.poll(() => selectedInFrames(page), { timeout: 10_000 }).toBe(0)
  })

  test('after selecting a poster frame (zoomed out)', async ({ page }) => {
    const { canvasRoot, homeFrame } = await openHome(page)
    await zoomToPercent(page, canvasRoot, 25)
    await page.waitForTimeout(800)
    const box = (await homeFrame.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByTestId('right-sidebar'), 'the poster press selected nothing to clear').toHaveAttribute('data-expanded', 'true', { timeout: 10_000 })
    await page.waitForTimeout(600)
    const at = await findEmptyBoardPoint(page)
    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('right-sidebar')).not.toHaveAttribute('data-expanded', 'true', { timeout: 10_000 })
    await expect.poll(() => selectedInFrames(page), { timeout: 10_000 }).toBe(0)
  })
})

/** A point `frameX`, `frameY` frame-px into `main`, in editor client px. */
async function mainPoint(node: (id: string) => Locator, frameX: number, frameY: number): Promise<{ x: number; y: number }> {
  const main = node(ID.main)
  const box = await visualBox(main)
  const scale = await main.evaluate((el) => {
    const f = el.ownerDocument.defaultView!.frameElement as HTMLIFrameElement
    return f.getBoundingClientRect().width / f.clientWidth
  })
  return { x: box.left + frameX * scale, y: box.top + frameY * scale }
}

/** The offset of `el` inside `main` in frame px, from computed layout. */
async function offsetInMain(el: Locator, main: Locator): Promise<{ left: number; top: number; width: number; height: number }> {
  const m = await main.evaluate((e) => {
    const r = e.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  return el.evaluate((e, base) => {
    const r = e.getBoundingClientRect()
    return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height }
  }, m)
}

for (const zoomPercent of [100, 45]) {
test.describe(`#4 at ${zoomPercent}%: an insert in an all-absolute frame lands at the pointer`, () => {
  test.setTimeout(240_000)

  test('R-tool draw in the empty part of the screen is written absolute and renders where it was drawn', async ({ page }) => {
    const { node, canvasRoot } = await openHome(page, zoomPercent)
    const at = await mainPoint(node, 42, 700)
    await canvasRoot.focus()
    await page.keyboard.press('r')
    await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible()
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 60, at.y + 30, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => readFile(REL), { timeout: 30_000 }).not.toBe(HOME)
    expect(readFile(REL), 'the drawn rectangle was written with no position').toMatch(/position: ?["']absolute["']/)
    const drawn = node(ID.main).locator(':scope > div[style*="background"]').first()
    await expect(drawn).toBeVisible({ timeout: 30_000 })
    const rect = await offsetInMain(drawn, node(ID.main))
    expect(Math.abs(rect.left - 42)).toBeLessThanOrEqual(2)
    expect(Math.abs(rect.top - 700)).toBeLessThanOrEqual(2)
  })

  test('the notch Div released in the empty part of the screen lands absolute at the pointer', async ({ page }) => {
    const { node } = await openHome(page, zoomPercent)
    const at = await mainPoint(node, 300, 700)
    await dragNotchTo(page, 'canvas-notch-div-btn', at)
    await page.mouse.up()
    await expect.poll(() => readFile(REL), { timeout: 30_000 }).not.toBe(HOME)
    const src = readFile(REL)
    expect(src).toMatch(/position: ?["']absolute["']/)
    expect(src).toMatch(/left: ?["'](29\d|30\d)(\.\d+)?px["']/)
  })

  test('the Text tool drag lands the text at the pointer', async ({ page }) => {
    const { node, canvasRoot, home } = await openHome(page, zoomPercent)
    const at = await mainPoint(node, 42, 700)
    await canvasRoot.focus()
    await page.keyboard.press('t')
    await expect(page.locator('[data-canvas-draw-layer="text"]')).toBeVisible()
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 80, at.y + 30, { steps: 6 })
    await page.mouse.up()
    const editable = home.locator('[contenteditable]:not([contenteditable="false"])')
    await expect(editable.first()).toBeVisible({ timeout: 30_000 })
    const rect = await offsetInMain(editable.first(), node(ID.main))
    expect(Math.abs(rect.left - 42)).toBeLessThanOrEqual(2)
    expect(Math.abs(rect.top - 700)).toBeLessThanOrEqual(2)
  })
})
}
