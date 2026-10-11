import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
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
 * Round-3 canvas audit fixes, asserted with a REAL mouse against computed layout:
 *
 *   - a cross-frame drop lands between the siblings it was released between;
 *   - an insert between design-system instances lands between them;
 *   - draw / notch drop / Text tool in an absolute-children screen lands at the pointer;
 *   - the Text tool opens inline edit with the caret;
 *   - Enter / Shift+Enter walk the tree one level;
 *   - a press-drag on a frame's empty background starts the in-frame marquee.
 *
 * SAFETY - only this run's throwaway fixture under the e2e workspace is written.
 */

const DS_INDEX = `export function Button() { return null }\n`

const HOME = `import { Button } from '../design-system'

export default function Home() {
  return (
    <main style={{ position: "relative", width: "100%", minHeight: "700px", background: "#fff" }}>
      <div style={{ position: "absolute", top: "0px", left: "0px", right: "0px", height: "40px" }}>
        <p>status</p>
      </div>
      <div className="banner" style={{ position: "absolute", top: "124px", left: "0px", right: "0px", display: "flex", flexDirection: "column", gap: "16px", padding: "16px" }}>
        <h1>Title</h1>
        <div className="form" style={{ display: "flex", flexDirection: "column", gap: "16px", width: "100%" }}>
          <p>first</p>
          <Button label="One" size="default" variant="primary" style={{ width: "223px" }} />
          <Button label="Two" size="default" variant="primary" style={{ width: "223px" }} />
          <Button label="Three" size="default" variant="primary" style={{ width: "223px" }} />
        </div>
      </div>
      <Button label="Tab" size="default" variant="primary" style={{ position: "absolute", bottom: "10px" }} />
    </main>
  )
}
`

const OTHER = `export default function Other() {
  return (
    <main style={{ padding: "24px" }}>
      <div className="stack" style={{ display: "flex", flexDirection: "column", gap: "24px", padding: "16px" }}>
        <p>alpha</p>
        <p>beta</p>
        <p>gamma</p>
      </div>
    </main>
  )
}
`

test.use({ viewport: { width: 1600, height: 1000 } })

let fixture: FixtureProject
const readFile = (rel: string): string => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-r3-canvas-fixes', {
    'pages/Home.tsx': HOME,
    'pages/Other.tsx': OTHER,
    'design-system/index.js': DS_INDEX,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openBoard(page: Page): Promise<{ canvasRoot: Locator; frame: (pageId: string) => Locator; content: (pageId: string) => FrameLocator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const frame = (pageId: string) => page.locator(`[data-page-id="${pageId}"]`).first()
  const content = (pageId: string) => canvasContentFrame(frame(pageId))
  return { canvasRoot, frame, content }
}

async function openHome(page: Page): Promise<{ canvasRoot: Locator; home: FrameLocator; homeFrame: Locator }> {
  const { canvasRoot, frame, content } = await openBoard(page)
  const homeFrame = frame('home')
  await panIntoView(page, canvasRoot, homeFrame)
  await expect(visibleCanvasIframe(homeFrame)).toHaveCount(1, { timeout: 60_000 })
  await expect(content('home').locator('[data-node-id="pages/Home.tsx:14:12"]')).toBeAttached({ timeout: 30_000 })
  return { canvasRoot, home: content('home'), homeFrame }
}

/** The union box of a node, however the node is hosted (a `display: contents` call site measures as its children). */
async function visualBox(node: Locator): Promise<{ left: number; top: number; right: number; bottom: number }> {
  return node.evaluate((el) => {
    const union = (e: Element, depth: number): { left: number; top: number; right: number; bottom: number } | null => {
      const r = e.getBoundingClientRect()
      if (r.width || r.height) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      if (depth > 4) return null
      let out: { left: number; top: number; right: number; bottom: number } | null = null
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
    // frame viewport px -> editor client px
    const frameEl = el.ownerDocument.defaultView!.frameElement as HTMLIFrameElement
    const fr = frameEl.getBoundingClientRect()
    const s = frameEl.clientWidth > 0 ? fr.width / frameEl.clientWidth : 1
    return { left: fr.left + box.left * s, top: fr.top + box.top * s, right: fr.left + box.right * s, bottom: fr.top + box.bottom * s }
  })
}

test.describe('insert between design-system instances', () => {
  test.setTimeout(240_000)

  test('a notch Div released on the lower half of an instance lands right after it, not at the column end', async ({ page }) => {
    const { home } = await openHome(page)
    const two = await visualBox(home.locator('[data-node-id="pages/Home.tsx:14:12"]'))
    const button = page.getByTestId('canvas-notch-div-btn')
    const from = (await button.boundingBox())!
    const dropX = (two.left + two.right) / 2
    const dropY = two.bottom - (two.bottom - two.top) * 0.2
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
    await page.mouse.move(dropX, dropY, { steps: 14 })
    await page.waitForTimeout(200)
    await page.mouse.up()
    await expect.poll(() => readFile('pages/Home.tsx'), { timeout: 30_000 }).not.toBe(HOME)
    const src = readFile('pages/Home.tsx')
    const iTwo = src.indexOf('label="Two"')
    const iNew = src.indexOf('<div', src.indexOf('className="form"') + 20)
    const iThree = src.indexOf('label="Three"')
    expect(iNew, src).toBeGreaterThan(iTwo)
    expect(iNew, src).toBeLessThan(iThree)
  })
})

const MAIN = 'pages/Home.tsx:5:6'

/** A point `frameX`, `frameY` frame-px into `main`, in editor client px. */
async function mainPoint(home: FrameLocator, frameX: number, frameY: number): Promise<{ x: number; y: number }> {
  const mainNode = home.locator(`[data-node-id="${MAIN}"]`)
  const main = await visualBox(mainNode)
  const scale = await mainNode.evaluate((el) => {
    const f = el.ownerDocument.defaultView!.frameElement as HTMLIFrameElement
    return f.getBoundingClientRect().width / f.clientWidth
  })
  return { x: main.left + frameX * scale, y: main.top + frameY * scale }
}

async function selectedNodeIds(content: FrameLocator): Promise<string[]> {
  return content.locator('body').evaluate((body) =>
    Array.from(body.querySelectorAll('[data-canvas-selected="true"]')).map((e) => e.getAttribute('data-node-id') ?? ''),
  )
}

test.describe('absolute-children screen (the SMS shape)', () => {
  test.setTimeout(240_000)

  test('a rectangle drawn in the empty part of the screen lands absolute at the pointer', async ({ page }) => {
    const { home } = await openHome(page)
    const at = await mainPoint(home, 200, 560)
    await page.getByTestId('canvas-draw-tool-rectangle').click()
    await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible()
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 60, at.y + 30, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => readFile('pages/Home.tsx'), { timeout: 30_000 }).not.toBe(HOME)
    const drawn = home.locator(`[data-node-id="${MAIN}"] > div[style*="background"]`).first()
    await expect(drawn).toBeVisible({ timeout: 30_000 })
    const rect = await drawn.evaluate((el, id) => {
      const r = el.getBoundingClientRect()
      const m = el.ownerDocument.querySelector(`[data-node-id="${id}"]`)!.getBoundingClientRect()
      return { left: r.left - m.left, top: r.top - m.top }
    }, MAIN)
    expect(Math.abs(rect.left - 200)).toBeLessThanOrEqual(2)
    expect(Math.abs(rect.top - 560)).toBeLessThanOrEqual(2)
  })

  test('the notch Div released in the empty part of the screen lands absolute at the pointer', async ({ page }) => {
    const { home } = await openHome(page)
    const at = await mainPoint(home, 300, 600)
    const button = page.getByTestId('canvas-notch-div-btn')
    const from = (await button.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
    await page.mouse.move(at.x, at.y, { steps: 14 })
    await page.waitForTimeout(200)
    await page.mouse.up()
    await expect.poll(() => readFile('pages/Home.tsx'), { timeout: 30_000 }).not.toBe(HOME)
    expect(readFile('pages/Home.tsx')).toMatch(/left: "(29|30)\d(\.\d+)?px"/)
  })
})

test.describe('the Text tool', () => {
  test.setTimeout(240_000)

  test('a text drawn in a frame opens inline edit with the caret, and typed text is written', async ({ page }) => {
    const { canvasRoot, home } = await openHome(page)
    const at = await mainPoint(home, 200, 560)
    await canvasRoot.focus()
    await page.keyboard.press('t')
    await expect(page.locator('[data-canvas-draw-layer="text"]')).toBeVisible()
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 80, at.y + 30, { steps: 6 })
    await page.mouse.up()
    const editable = home.locator('[contenteditable="true"]')
    await expect(editable, 'the new text never entered inline edit').toBeVisible({ timeout: 30_000 })
    await expect.poll(() => editable.evaluate((el) => el.ownerDocument.activeElement === el), { timeout: 5_000 }).toBe(true)
    await page.keyboard.type('Hello world')
    await page.keyboard.press('Escape')
    await expect.poll(() => readFile('pages/Home.tsx'), { timeout: 30_000 }).toContain('Hello world')
  })
})

test.describe('keyboard walks the tree one level', () => {
  test.setTimeout(240_000)

  test('Shift+Enter selects the parent and Enter the children', async ({ page }) => {
    const { home } = await openHome(page)
    await selectInFrame(page, home.locator('[data-node-id="pages/Home.tsx:12:12"]'))
    await expect.poll(() => selectedNodeIds(home), { timeout: 10_000 }).toContain('pages/Home.tsx:12:12')
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => selectedNodeIds(home), { timeout: 10_000 }).toEqual(['pages/Home.tsx:11:10'])
    await page.keyboard.press('Shift+Enter')
    await expect.poll(() => selectedNodeIds(home), { timeout: 10_000 }).toEqual(['pages/Home.tsx:9:8'])
    await page.keyboard.press('Enter')
    await expect.poll(() => selectedNodeIds(home), { timeout: 10_000 }).toEqual(['pages/Home.tsx:10:10', 'pages/Home.tsx:11:10'])
  })
})

test.describe('in-frame marquee', () => {
  test.setTimeout(240_000)

  test('a press-drag on the frame background sweeps and selects the layers it touches', async ({ page }) => {
    const { home } = await openHome(page)
    const from = await mainPoint(home, 700, 640)
    const banner = await visualBox(home.locator('[data-node-id="pages/Home.tsx:9:8"]'))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x - 40, from.y - 60, { steps: 6 })
    await expect(home.locator('[data-canvas-in-frame-marquee="true"]')).toBeAttached({ timeout: 5_000 })
    await page.mouse.move((banner.left + banner.right) / 2, banner.bottom - 20, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => selectedNodeIds(home), { timeout: 10_000 }).toContain('pages/Home.tsx:9:8')
  })
})

test.describe('cross-frame drop', () => {
  test.setTimeout(300_000)

  test('a layer dragged into another frame lands between the siblings it was released between, with the line shown', async ({ page }) => {
    const { canvasRoot, frame, content } = await openBoard(page)
    await zoomToPercent(page, canvasRoot, 35)
    // Centre the pair: both frames must be on screen at once for a cross-frame drag.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [a, b, root] = await Promise.all([frame('home').boundingBox(), frame('other').boundingBox(), canvasRoot.boundingBox()])
      if (!a || !b || !root) break
      const dx = (Math.min(a.x, b.x) + Math.max(a.x + a.width, b.x + b.width)) / 2 - (root.x + root.width / 2)
      const dy = (a.y + a.height / 2) - (root.y + root.height / 2)
      if (Math.abs(dx) < 30 && Math.abs(dy) < 30) break
      await page.mouse.move(root.x + root.width / 2, root.y + root.height / 2)
      await page.mouse.wheel(dx, dy)
      await page.waitForTimeout(200)
    }
    await expect(visibleCanvasIframe(frame('home'))).toHaveCount(1, { timeout: 60_000 })
    await expect(visibleCanvasIframe(frame('other'))).toHaveCount(1, { timeout: 60_000 })
    const other = content('other')
    const home = content('home')
    const gamma = other.locator('[data-node-id="pages/Other.tsx:7:10"]')
    const g = await visualBox(gamma)
    await selectInFrame(page, gamma)
    await expect.poll(() => selectedNodeIds(other), { timeout: 10_000 }).toContain('pages/Other.tsx:7:10')
    // Release in the 16px gap between "first" and the first Button of Home's form.
    const first = await visualBox(home.locator('[data-node-id="pages/Home.tsx:12:12"]'))
    const one = await visualBox(home.locator('[data-node-id="pages/Home.tsx:13:12"]'))
    const dropX = (first.left + first.right) / 2 + 40
    const dropY = (first.bottom + one.top) / 2
    await page.mouse.move((g.left + g.right) / 2, (g.top + g.bottom) / 2)
    await page.mouse.down()
    await page.mouse.move((g.left + g.right) / 2 + 30, (g.top + g.bottom) / 2 - 30, { steps: 5 })
    await page.mouse.move(dropX, dropY, { steps: 20 })
    await page.waitForTimeout(250)
    console.log('DROPDOM', JSON.stringify(await home.locator('body').evaluate((body) => Array.from(body.querySelectorAll('[data-studio-canvas-overlay-root] *')).map((e) => e.tagName + ' ' + Array.from(e.attributes).map((a) => a.name + '=' + a.value.slice(0, 40)).join(' ') + ' d=' + (e as HTMLElement).style.display).slice(0, 40))))
    const otherDom = await other.locator('body').evaluate((body) => Array.from(body.querySelectorAll('[data-position], [data-canvas-drag-ghost]')).map((e) => e.tagName + ' ' + e.getAttribute('data-position')))
    console.log('OTHERDOM', JSON.stringify(otherDom))
    // The insertion line is the drop layer's "line" bar in the destination frame, 2px thick.
    const lineThickness = await home.locator('body').evaluate((body) => {
      const lines = Array.from(body.querySelectorAll('[data-position="after"], [data-position="before"]'))
      return lines.map((l) => Math.min(l.getBoundingClientRect().width, l.getBoundingClientRect().height))
    })
    expect(lineThickness.length, 'no insertion line while hovering between siblings').toBeGreaterThan(0)
    await page.mouse.up()
    await expect.poll(() => readFile('pages/Home.tsx'), { timeout: 30_000 }).toContain('gamma')
    const src = readFile('pages/Home.tsx')
    const iFirst = src.indexOf('<p>first</p>')
    const iGamma = src.indexOf('gamma')
    const iOne = src.indexOf('label="One"')
    expect(iGamma, src).toBeGreaterThan(iFirst)
    expect(iGamma, src).toBeLessThan(iOne)
  })
})
