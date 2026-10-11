import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  selectInFrame,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * O5 — "Fill" is the REMAINING space of the parent, never the whole parent.
 *
 * Replays the owner's steps with the real mouse and keyboard: select a layer,
 * open its Height / Width options menu, choose "Fill container". Asserts on
 * COMPUTED layout (the siblings after the Fill layer stay inside the shell) and
 * on the bytes the source ends up with.
 *
 *   - flex column parent: Fill height writes `flex: 1 1 0`, clears the height,
 *     the footer stays inside the shell and the layer takes exactly the
 *     leftover space;
 *   - flex row parent with a gap: Fill width does the same on the other axis
 *     and the trailing sibling stays inside the row;
 *   - block parent: there is no "remaining space" in block flow, so Fill height
 *     is OFFERED DISABLED with its one remedy and nothing is written. (Old code
 *     wrote `height: 100%`, which made the layer the whole shell and pushed the
 *     footer below it.)
 *
 * SAFETY — this spec WRITES, so every case authors its own throwaway fixture.
 */

const REL = 'pages/Home.tsx'

function pageSource(shellStyle: string): string {
  return `export default function Home() {
  return (
    <main className="shell" style={{ ${shellStyle} }}>
      <div className="head" style={{ height: "60px", background: "#fcc" }}>Head</div>
      <div className="body" style={{ padding: "8px", background: "#cfc" }}>Body</div>
      <div className="foot" style={{ height: "60px", background: "#ccf" }}>Foot</div>
    </main>
  )
}
`
}

const DIV = { head: 1, body: 2, foot: 3 } as const

let fixture: FixtureProject
let source = ''
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')

function author(shellStyle: string) {
  source = pageSource(shellStyle)
  fixture = createAuthoredFixtureProject('__e2e-fill-sizing', {
    [REL]: source,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
}

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

const rectOf = (element: Locator): Promise<Rect> =>
  element.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
  })

/** Open the board, select the `body` layer by a real ctrl-click on its padding, and return the node lookup. */
async function selectBody(page: Page) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  const node = (index: number) => content.locator(`[data-node-id="${sourceNodeId(source, REL, 'div', index)}"]`).first()
  const shell = content.locator('main').first()
  // Measured by position under <main>: an edit may reflow the source, and a node id is a source position.
  await panIntoView(page, canvasRoot, node(DIV.body), 80)
  await selectInFrame(page, node(DIV.body))
  await expect(page.getByTestId(`dom-tree-item-${sourceNodeId(source, REL, 'div', DIV.body)}`)).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const named = (index: number) => shell.locator('> div').nth(index - 1)
  return { node: named, shell }
}

async function openSizeMenu(page: Page, axis: 'width' | 'height') {
  await page.getByTestId(`css-size-input-${axis}-chevron`).click()
}

const bodyLine = () => readPage().split(/\r?\n/).find((line) => line.includes('className="body"')) ?? ''

test.describe('O5 — Fill takes the remaining space and never pushes siblings out', () => {
  test.setTimeout(180_000)

  test('flex column: Fill height shares the leftover; the footer stays inside the shell', async ({ page }) => {
    author('display: "flex", flexDirection: "column", height: "600px", padding: "20px", boxSizing: "border-box", background: "#eee"')
    const { node, shell } = await selectBody(page)

    await openSizeMenu(page, 'height')
    await page.getByRole('menuitemradio', { name: 'Fill container' }).click()

    await expect.poll(bodyLine, { timeout: 30_000 }).toContain('flex')
    const line = bodyLine()
    expect(line).toMatch(/flex: "1 1 0"/)
    expect(line).not.toMatch(/height: "100%"/)
    expect(line).not.toMatch(/\bheight:/)

    const [shellBox, head, body, foot] = await Promise.all([
      rectOf(shell),
      rectOf(node(DIV.head)),
      rectOf(node(DIV.body)),
      rectOf(node(DIV.foot)),
    ])
    expect(foot.bottom, 'footer must stay inside the shell').toBeLessThanOrEqual(shellBox.bottom + 1)
    expect(foot.top).toBeGreaterThanOrEqual(body.bottom - 1)
    // shell 600 - padding 40 - head 60 - foot 60 = 440 left over
    expect(Math.abs(body.height - 440)).toBeLessThanOrEqual(1)
    expect(Math.abs(body.top - head.bottom)).toBeLessThanOrEqual(1)
  })

  test('flex row with a gap: Fill width shares the leftover; the last sibling stays inside the row', async ({ page }) => {
    author('display: "flex", gap: "20px", width: "600px", padding: "20px", boxSizing: "border-box", background: "#eee"')
    const { node, shell } = await selectBody(page)

    await openSizeMenu(page, 'width')
    await page.getByRole('menuitemradio', { name: 'Fill container' }).click()

    await expect.poll(bodyLine, { timeout: 30_000 }).toContain('flex')
    const line = bodyLine()
    expect(line).toMatch(/flex: "1 1 0"/)
    expect(line).toMatch(/minWidth: "0"/)
    expect(line).not.toMatch(/width: "100%"/)

    const [shellBox, body, foot] = await Promise.all([rectOf(shell), rectOf(node(DIV.body)), rectOf(node(DIV.foot))])
    expect(foot.right, 'the trailing sibling must stay inside the row').toBeLessThanOrEqual(shellBox.right + 1)
    expect(foot.left).toBeGreaterThanOrEqual(body.right + 19)
    expect(body.width).toBeGreaterThan(0)
  })

  test('block parent: Fill height is offered disabled with its remedy and writes nothing', async ({ page }) => {
    author('height: "600px", padding: "20px", boxSizing: "border-box", background: "#eee"')
    const { node, shell } = await selectBody(page)
    const before = readPage()

    await openSizeMenu(page, 'height')
    const fill = page.getByRole('menuitemradio', { name: 'Fill container' })
    await expect(fill).toBeDisabled()
    await fill.click({ force: true }).catch(() => undefined)
    await page.keyboard.press('Escape')

    const [shellBox, body, foot] = await Promise.all([rectOf(shell), rectOf(node(DIV.body)), rectOf(node(DIV.foot))])
    expect(foot.bottom, 'footer must stay inside the shell').toBeLessThanOrEqual(shellBox.bottom + 1)
    expect(foot.top).toBeGreaterThanOrEqual(body.bottom - 1)
    await page.waitForTimeout(1500)
    expect(readPage(), 'a refused Fill must not touch the source').toBe(before)
  })
})
