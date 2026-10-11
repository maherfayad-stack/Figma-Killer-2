import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * PA-7 / PA-8 — "Add auto layout" (⇧A) and "Remove auto layout, keep
 * positions" (⇧A again), asserted on COMPUTED layout in a real browser
 * (`standing-02`: happy-dom has no layout, so the unit tests can only say what
 * is WRITTEN, never that nothing moved).
 *
 *   - a free frame (absolute children) becomes a flex row, its children return
 *     to flow in visual order, and none of them moves by more than 1px;
 *   - a block container of stacked layers becomes a flex column, margins and
 *     all, and none of them moves by more than 1px;
 *   - ⇧A on that auto layout pins every child where it sits: nothing moves;
 *   - ⌘Z takes the whole add back, file and canvas.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="free" style={{ position: "relative", width: "360px", height: "120px", background: "#eee", marginBottom: "40px" }}>
        <div className="f0" style={{ position: "absolute", left: "20px", top: "20px", width: "90px", height: "40px", background: "#c33" }}>F0</div>
        <div className="f1" style={{ position: "absolute", left: "130px", top: "20px", width: "90px", height: "40px", background: "#3c3" }}>F1</div>
        <div className="f2" style={{ position: "absolute", left: "240px", top: "20px", width: "90px", height: "40px", background: "#33c" }}>F2</div>
      </div>
      <div className="shuffled" style={{ position: "relative", width: "360px", height: "120px", background: "#eee", marginBottom: "40px" }}>
        <div className="s1" style={{ position: "absolute", left: "130px", top: "20px", width: "90px", height: "40px", background: "#3c3" }}>S1</div>
        <div className="s0" style={{ position: "absolute", left: "20px", top: "20px", width: "90px", height: "40px", background: "#c33" }}>S0</div>
        <div className="s2" style={{ position: "absolute", left: "240px", top: "20px", width: "90px", height: "40px", background: "#33c" }}>S2</div>
      </div>
      <div className="flow" style={{ width: "300px", padding: "12px", background: "#dde" }}>
        <div className="w0" style={{ height: "30px", marginBottom: "10px", background: "#fcc" }}>W0</div>
        <div className="w1" style={{ height: "30px", marginBottom: "10px", background: "#cfc" }}>W1</div>
        <div className="w2" style={{ height: "30px", background: "#ccf" }}>W2</div>
      </div>
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
/** `<div>` occurrences in FIXTURE_PAGE, in source order. */
const DIV = { free: 1, f0: 2, f1: 3, f2: 4, shuffled: 5, s1: 6, s0: 7, s2: 8, flow: 9, w0: 10, w1: 11, w2: 12 } as const

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-auto-layout-convert', {
    [REL]: FIXTURE_PAGE,
    // Static tier: one portal frame, so the one canvas iframe is the one under test.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Box {
  left: number
  top: number
  width: number
  height: number
  position: string
  display: string
}

function box(element: Locator): Promise<Box> {
  return element.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, position: cs.position, display: cs.display }
  })
}

/** A className's style declarations as a sorted list: the order the keys sit in does not matter to what renders. */
function declarationsOf(source: string, className: string): string[] {
  const line = source.split(/\r?\n/).find((text) => text.includes(`className="${className}"`)) ?? ''
  const style = /style=\{\{(.*)\}\}/.exec(line)?.[1] ?? ''
  return style.split(/,\s*(?=[a-zA-Z]+:)/).map((entry) => entry.trim()).sort()
}

const near = (actual: number, expected: number, what: string) =>
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1)

function expectNothingMoved(after: Box[], before: Box[], names: string[]) {
  after.forEach((now, index) => {
    near(now.left, before[index]!.left, `${names[index]} left`)
    near(now.top, before[index]!.top, `${names[index]} top`)
    near(now.width, before[index]!.width, `${names[index]} width`)
    near(now.height, before[index]!.height, `${names[index]} height`)
  })
}

async function openAndSelect(page: Page, divIndex: number): Promise<{ content: FrameLocator; node: (index: number) => Locator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  const node = (index: number) => content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'div', index)}"]`).first()
  await panIntoView(page, canvasRoot, node(divIndex), 80)
  // Ctrl-click deep-selects what is under the cursor, so a CONTAINER is pressed on its own empty corner.
  const target = await node(divIndex).boundingBox()
  expect(target, 'container has no box').not.toBeNull()
  await page.keyboard.down('ControlOrMeta')
  try {
    await page.mouse.click(target!.x + 4, target!.y + 4)
  } finally {
    await page.keyboard.up('ControlOrMeta')
  }
  await expect(page.getByTestId(`dom-tree-item-${sourceNodeId(FIXTURE_PAGE, REL, 'div', divIndex)}`)).toHaveAttribute(
    'aria-selected',
    'true',
  )
  return { content, node }
}

test.describe('PA-7 / PA-8 — add and remove auto layout', () => {
  test.setTimeout(180_000)

  test('a free frame becomes a row; the children do not move; ⇧A again pins them; ⌘Z takes the add back', async ({ page }) => {
    const { node } = await openAndSelect(page, DIV.free)
    const kids = [DIV.f0, DIV.f1, DIV.f2]
    const before = await Promise.all(kids.map((index) => box(node(index))))
    expect(before.every((entry) => entry.position === 'absolute')).toBe(true)

    await page.keyboard.press('Shift+A')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('display: "flex"')
    await expect.poll(() => box(node(DIV.free)).then((entry) => entry.display)).toBe('flex')
    const added = await Promise.all(kids.map((index) => box(node(index))))
    expect(added.every((entry) => entry.position === 'static')).toBe(true)
    expectNothingMoved(added, before, ['f0', 'f1', 'f2'])
    // The frame keeps its size.
    const frameBox = await box(node(DIV.free))
    near(frameBox.width, 360, 'frame width')
    near(frameBox.height, 120, 'frame height')

    // ⇧A on an auto layout pins every child where it sits.
    const frameBefore = frameBox
    await page.keyboard.press('Shift+A')
    await expect.poll(() => box(node(DIV.free)).then((entry) => entry.display)).toBe('block')
    const removed = await Promise.all(kids.map((index) => box(node(index))))
    expect(removed.every((entry) => entry.position === 'absolute')).toBe(true)
    expectNothingMoved(removed, before, ['f0', 'f1', 'f2'])
    const frameAfter = await box(node(DIV.free))
    near(frameAfter.height, frameBefore.height, 'frame height after removing')
    near(frameAfter.top, frameBefore.top, 'frame top after removing')

    // ⌘Z, twice: the removal, then the add. The file is the original again.
    await page.keyboard.press('Control+z')
    await expect.poll(() => box(node(DIV.free)).then((entry) => entry.display)).toBe('flex')
    await page.keyboard.press('Control+z')
    // The same declarations are back (a removed key returns at the END of its
    // style object, so the bytes differ in order only).
    await expect.poll(() => declarationsOf(readPage(), 'f0'), { timeout: 30_000 }).toEqual(declarationsOf(FIXTURE_PAGE, 'f0'))
    for (const name of ['free', 'f1', 'f2']) expect(declarationsOf(readPage(), name)).toEqual(declarationsOf(FIXTURE_PAGE, name))
    const restored = await Promise.all(kids.map((index) => box(node(index))))
    expectNothingMoved(restored, before, ['f0', 'f1', 'f2'])
  })

  test('absolute children in a different source order flow in visual order, still in place', async ({ page }) => {
    const { node } = await openAndSelect(page, DIV.shuffled)
    const kids = [DIV.s0, DIV.s1, DIV.s2]
    const before = await Promise.all(kids.map((index) => box(node(index))))

    await page.keyboard.press('Shift+A')
    await expect.poll(readPage, { timeout: 30_000 }).toMatch(/className="s0"[\s\S]*className="s1"[\s\S]*className="s2"/)
    await expect.poll(() => box(node(DIV.shuffled)).then((entry) => entry.display), { timeout: 30_000 }).toBe('flex')
    // Ids are line:col of the element: the file now lists s0, s1, s2 in that order.
    const content = canvasContentFrame(page.locator('[data-page-id]').first())
    const reordered = readPage()
    const after = await Promise.all(
      [DIV.s1, DIV.s0, DIV.s2].map((index) =>
        box(content.locator(`[data-node-id="${sourceNodeId(reordered, REL, 'div', index)}"]`).first()),
      ),
    )
    expectNothingMoved(after, before, ['s0', 's1', 's2'])
  })

  test('a block container of stacked layers becomes a column, margins and padding included, and nothing moves', async ({ page }) => {
    const { node } = await openAndSelect(page, DIV.flow)
    const kids = [DIV.w0, DIV.w1, DIV.w2]
    const before = await Promise.all(kids.map((index) => box(node(index))))
    const frameBefore = await box(node(DIV.flow))

    await page.keyboard.press('Shift+A')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('display: "flex"')
    await expect.poll(() => box(node(DIV.flow)).then((entry) => entry.display)).toBe('flex')
    const after = await Promise.all(kids.map((index) => box(node(index))))
    expectNothingMoved(after, before, ['w0', 'w1', 'w2'])
    const frameAfter = await box(node(DIV.flow))
    near(frameAfter.height, frameBefore.height, 'container height')
    near(frameAfter.width, frameBefore.width, 'container width')
  })
})
