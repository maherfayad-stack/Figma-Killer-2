import { expect, test, type FrameLocator, type Locator, type Page, type Request } from '@playwright/test'
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
 * P2-C "arrow keys" (IX-1), in a real browser: with a layer selected, an
 * arrow moves it — asserted on the FILE on disk, on the SAVE requests the
 * editor sent, and on the element's COMPUTED position inside the frame
 * (`standing-02`: happy-dom has no layout, so the unit test
 * `src/__tests__/canvas/nodeArrowKeys.test.tsx` answers only who claims what).
 *
 *   - an absolute layer: a HELD arrow previews every repeat, then writes ONCE
 *     on release — one `/admin/api/studio/save`, and one ⌘Z takes it all back;
 *   - a right-anchored absolute layer keeps its anchor (no `left` appears);
 *   - a layout child reorders one place along its row; a held arrow is still
 *     one place and one write; a cross-axis arrow writes nothing.
 *
 * Playwright's `keyboard.down` on a key that is already down sends
 * `repeat: true`, which is exactly what a held key's auto-repeat looks like.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="row" style={{ display: "flex", gap: "8px", marginBottom: "40px" }}>
        <div className="a" style={{ width: "60px", height: "40px", background: "#c33" }}>A</div>
        <div className="b" style={{ width: "60px", height: "40px", background: "#3c3" }}>B</div>
        <div className="c" style={{ width: "60px", height: "40px", background: "#33c" }}>C</div>
        <div className="d" style={{ width: "60px", height: "40px", background: "#cc3" }}>D</div>
      </div>
      <div className="stage" style={{ position: "relative", width: "320px", height: "200px", background: "#eee" }}>
        <div className="abs" style={{ position: "absolute", left: "100px", top: "60px", width: "120px", height: "50px", background: "#999" }}>abs</div>
        <div className="anchored" style={{ position: "absolute", right: "20px", bottom: "20px", width: "40px", height: "30px", background: "#555" }}>R</div>
      </div>
      <div className="grid" style={{ display: "grid", gridTemplateColumns: "40px 40px 40px", gap: "4px", marginTop: "40px" }}>
        <div className="g0" style={{ height: "30px", background: "#ddd" }}>G0</div>
        <div className="g1" style={{ height: "30px", background: "#ddd" }}>G1</div>
        <div className="g2" style={{ height: "30px", background: "#ddd" }}>G2</div>
        <div className="g3" style={{ height: "30px", background: "#ddd" }}>G3</div>
        <div className="g4" style={{ height: "30px", background: "#ddd" }}>G4</div>
        <div className="g5" style={{ height: "30px", background: "#ddd" }}>G5</div>
      </div>
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
/** `<div>` occurrences in FIXTURE_PAGE, in source order. */
const DIV = { row: 1, a: 2, b: 3, c: 4, d: 5, stage: 6, abs: 7, anchored: 8, grid: 9, g0: 10, g1: 11 } as const

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-node-arrow-keys', {
    [REL]: FIXTURE_PAGE,
    // Static tier: one portal frame, so the one canvas iframe is the one under test.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

/** Every source write the editor sends — a value edit and a structural edit both ride this route. */
function recordSaves(page: Page): Request[] {
  const saves: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request)
  })
  return saves
}

interface Position {
  left: number
  top: number
  cssLeft: string
  cssTop: string
  cssRight: string
}

function position(element: Locator): Promise<Position> {
  return element.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { left: rect.left, top: rect.top, cssLeft: cs.left, cssTop: cs.top, cssRight: cs.right }
  })
}

async function openAndSelect(page: Page, divIndex: number): Promise<{ content: FrameLocator; element: Locator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  const element = content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', divIndex)}"]`).first()
  await panIntoView(page, canvasRoot, element, 80)
  await clickInFrame(page, element)
  await expect(page.getByTestId(`dom-tree-item-${sourceNodeId(FIXTURE_PAGE, REL, 'div', divIndex)}`)).toHaveAttribute(
    'aria-selected',
    'true',
  )
  return { content, element }
}

/** Hold `key` for `presses` keydowns (the first real, the rest auto-repeats), about 30 a second. */
async function holdKey(page: Page, key: string, presses: number): Promise<void> {
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.down(key)
    await page.waitForTimeout(35)
  }
}

/** Long enough for the autosave's trailing debounce to have fired a second save, if one were coming. */
const QUIET_MS = 2_000

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

test.describe('P2-C — arrow keys move the selected layer', () => {
  test.setTimeout(180_000)

  test('a held → on an absolute layer: previewed per repeat, ONE source write, ONE undo entry', async ({ page }) => {
    const { element } = await openAndSelect(page, DIV.abs)
    const saves = recordSaves(page)
    const before = await position(element)
    expect(before.cssLeft).toBe('100px')

    await holdKey(page, 'ArrowRight', 6)
    // Mid-hold: the frame shows the move; the file and the wire do not have it.
    await expect.poll(() => position(element).then((p) => p.cssLeft)).toBe('106px')
    expect(readPage()).toBe(FIXTURE_PAGE)
    expect(saves).toHaveLength(0)

    await page.keyboard.up('ArrowRight')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('left: "106px"')
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a held arrow must be exactly one source write').toHaveLength(1)
    const after = await position(element)
    expect(after.cssLeft).toBe('106px')
    near(after.left, before.left + 6)
    near(after.top, before.top)

    // One entry: a single ⌘Z takes the whole hold back, file and canvas.
    await page.keyboard.press('Control+z')
    await expect.poll(readPage, { timeout: 30_000 }).toBe(FIXTURE_PAGE)
    await expect.poll(() => position(element).then((p) => p.cssLeft)).toBe('100px')
  })

  test('⇧↓ steps 10 px', async ({ page }) => {
    const { element } = await openAndSelect(page, DIV.abs)
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('top: "70px"')
    expect((await position(element)).cssTop).toBe('70px')
  })

  test('a right-anchored layer moves `right` and gains no `left` (canvas-23)', async ({ page }) => {
    const { element } = await openAndSelect(page, DIV.anchored)
    const before = await position(element)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('right: "21px"')
    const line = readPage().split('\n').find((text) => text.includes('className="anchored"'))!
    expect(line).not.toContain('left:')
    near((await position(element)).left, before.left - 1)
  })

  test('a layout child reorders one place; a held key is one move and one write; a cross-axis arrow writes nothing', async ({ page }) => {
    const { content } = await openAndSelect(page, DIV.a)
    const saves = recordSaves(page)
    const boxA = content.getByText('A', { exact: true })
    const beforeB = await content.getByText('B', { exact: true }).boundingBox()

    await holdKey(page, 'ArrowRight', 4)
    await page.keyboard.up('ArrowRight')
    await expect
      .poll(readPage, { timeout: 30_000 })
      .toMatch(/className="b"[\s\S]*className="a"[\s\S]*className="c"/)
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a held reorder must be exactly one source write').toHaveLength(1)
    // A now renders where B was.
    await expect.poll(async () => Math.abs((await boxA.boundingBox())!.x - beforeB!.x)).toBeLessThanOrEqual(2)

    // ↓ is across a row's axis: claimed, and nothing moves.
    await clickInFrame(page, boxA)
    const written = readPage()
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(QUIET_MS)
    expect(readPage()).toBe(written)
    expect(saves).toHaveLength(1)
  })
})

/** ⇧-click adds to the canvas selection (P2-B, OD-3). */
async function shiftClickInFrame(page: Page, target: Locator): Promise<void> {
  await page.keyboard.down('Shift')
  await clickInFrame(page, target)
  await page.keyboard.up('Shift')
}

/** The source order of the elements whose `className` is one of `names`. */
function sourceOrder(names: readonly string[]): string[] {
  const text = readPage()
  return [...names].sort((x, y) => text.indexOf(`className="${x}"`) - text.indexOf(`className="${y}"`))
}

test.describe('P2-C2 (OD-16) — arrows move a whole multi-selection as one gesture', () => {
  test.setTimeout(180_000)

  test('two absolute layers: a held → nudges both, ONE source write, ONE ⌘Z', async ({ page }) => {
    const { content, element: abs } = await openAndSelect(page, DIV.abs)
    const anchored = content.getByText('R', { exact: true })
    await shiftClickInFrame(page, anchored)
    const saves = recordSaves(page)
    const beforeAbs = await position(abs)
    const beforeAnchored = await position(anchored)

    await holdKey(page, 'ArrowRight', 4)
    await page.keyboard.up('ArrowRight')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('left: "104px"')
    expect(readPage()).toContain('right: "16px"')
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a held arrow over two layers must be exactly one source write').toHaveLength(1)
    near((await position(abs)).left, beforeAbs.left + 4)
    near((await position(anchored)).left, beforeAnchored.left + 4)

    await page.keyboard.press('Control+z')
    await expect.poll(readPage, { timeout: 30_000 }).toBe(FIXTURE_PAGE)
  })

  test('two separated row children step → together in ONE write, keeping their order', async ({ page }) => {
    const { content } = await openAndSelect(page, DIV.a)
    await shiftClickInFrame(page, content.getByText('C', { exact: true }))
    const saves = recordSaves(page)
    const beforeB = await content.getByText('B', { exact: true }).boundingBox()
    const beforeD = await content.getByText('D', { exact: true }).boundingBox()

    await page.keyboard.press('ArrowRight')
    await expect.poll(() => sourceOrder(['a', 'b', 'c', 'd']), { timeout: 30_000 }).toEqual(['b', 'a', 'd', 'c'])
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'both moves ride one /save batch').toHaveLength(1)
    // A renders where B was, C where D was.
    await expect.poll(async () => Math.abs((await content.getByText('A', { exact: true }).boundingBox())!.x - beforeB!.x)).toBeLessThanOrEqual(2)
    await expect.poll(async () => Math.abs((await content.getByText('C', { exact: true }).boundingBox())!.x - beforeD!.x)).toBeLessThanOrEqual(2)

    await page.keyboard.press('Control+z')
    await expect.poll(readPage, { timeout: 30_000 }).toBe(FIXTURE_PAGE)
    expect(saves).toHaveLength(2)
  })

  test('a grid child: ↓ moves it one whole row (the column count), ← / → one cell', async ({ page }) => {
    const { content } = await openAndSelect(page, DIV.g1)
    const saves = recordSaves(page)
    const cellG4 = await content.getByText('G4', { exact: true }).boundingBox()

    await page.keyboard.press('ArrowDown')
    const names = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5']
    await expect.poll(() => sourceOrder(names), { timeout: 30_000 }).toEqual(['g0', 'g2', 'g3', 'g4', 'g1', 'g5'])
    await page.waitForTimeout(QUIET_MS)
    expect(saves).toHaveLength(1)
    // G1 now renders in the cell below where it was: G4's old cell.
    const moved = content.getByText('G1', { exact: true })
    await expect.poll(async () => {
      const box = (await moved.boundingBox())!
      return Math.max(Math.abs(box.x - cellG4!.x), Math.abs(box.y - cellG4!.y))
    }).toBeLessThanOrEqual(2)

    await page.keyboard.press('ArrowRight')
    await expect.poll(() => sourceOrder(names), { timeout: 30_000 }).toEqual(['g0', 'g2', 'g3', 'g4', 'g5', 'g1'])
  })
})
