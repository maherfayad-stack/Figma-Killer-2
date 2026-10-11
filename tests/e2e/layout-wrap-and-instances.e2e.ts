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
 * r3-layout — real-mouse proof that design-system instances are laid out,
 * wrapped, framed and nudged by the box they draw:
 *
 *   1. Shift+A on two selected Buttons wraps them in a container that keeps
 *      the spacing (direction, gap and alignment read off their rects): nothing
 *      moves by more than 1px;
 *   2. a second Shift+A (remove auto layout) pins them where they sit and
 *      writes whole pixels, not 222.76px;
 *   3. Ctrl+Alt+G frames two Buttons, and an arrow nudges an absolute Button,
 *      neither refused as "no box of its own".
 *
 * SAFETY — WRITES, so the fixture lives in this run's throwaway workspace copy.
 */
const FIXTURE_PAGE = `import { Button } from '../design-system'

export default function Home() {
  return (
    <main style={{ padding: "40px" }}>
      <div className="stack" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "24px", marginBottom: "40px" }}>
        <Button variant="primary" label="One" />
        <Button variant="primary" label="Second one" />
        <Button variant="primary" label="Third" />
      </div>
      <div className="stage" style={{ position: "relative", width: "320px", height: "200px", background: "#eee" }}>
        <Button variant="primary" label="Free" style={{ position: "absolute", left: "100px", top: "60px" }} />
      </div>
    </main>
  )
}
`
const DESIGN_SYSTEM_INDEX = `export function Button() { return null }
`
const REL = 'pages/Home.tsx'

let fixture: FixtureProject
const readPage = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'Home.tsx'), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-layout-wrap-instances', {
    [REL]: FIXTURE_PAGE,
    'design-system/index.js': DESIGN_SYSTEM_INDEX,
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
}
const box = (element: Locator): Promise<Box> =>
  element.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
const near = (actual: number, expected: number, what: string) =>
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1)

async function open(page: Page): Promise<{ content: FrameLocator; button: (n: number) => Locator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const content = canvasContentFrame(frame)
  // The drawn button of the Nth design-system instance.
  const button = (n: number) =>
    content.locator(`[data-node-id="${sourceNodeId(FIXTURE_PAGE, REL, 'Button', n)}"] button`).first()
  await expect(button(1)).toBeVisible({ timeout: 30_000 })
  await panIntoView(page, canvasRoot, button(2), 120)
  return { content, button }
}

async function pressCentre(page: Page, target: Locator, modifier?: 'Shift'): Promise<void> {
  const rect = await target.boundingBox()
  expect(rect, 'target has no box').not.toBeNull()
  if (modifier) await page.keyboard.down(modifier)
  try {
    await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2)
  } finally {
    if (modifier) await page.keyboard.up(modifier)
  }
}

test.describe('r3-layout', () => {
  test.setTimeout(180_000)

  test('Shift+A on two Buttons keeps their spacing; Shift+A again pins them in whole pixels', async ({ page }) => {
    const { button } = await open(page)
    const before = await Promise.all([1, 2, 3].map((n) => box(button(n))))
    await pressCentre(page, button(1))
    await pressCentre(page, button(2), 'Shift')

    await page.keyboard.press('Shift+A')
    await expect.poll(readPage, { timeout: 30_000 }).toMatch(/<div[^>]*display: "flex"[^>]*>\s*<Button[^>]*label="One"/)
    await expect.poll(() => box(button(3)).then((b) => b.top), { timeout: 15_000 }).toBeLessThan(before[2]!.top + 1.01)
    const added = await Promise.all([1, 2, 3].map((n) => box(button(n))))
    added.forEach((now, i) => {
      near(now.left, before[i]!.left, `button ${i + 1} left`)
      near(now.top, before[i]!.top, `button ${i + 1} top`)
    })

    // The wrapper is selected: Shift+A removes the auto layout, keeping positions.
    await page.keyboard.press('Shift+A')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('position: "absolute"')
    const removed = await Promise.all([1, 2].map((n) => box(button(n))))
    removed.forEach((now, i) => {
      near(now.left, before[i]!.left, `pinned button ${i + 1} left`)
      near(now.top, before[i]!.top, `pinned button ${i + 1} top`)
    })
    const written = readPage()
    expect(written, 'a fractional pixel size was written').not.toMatch(/(?:width|height): "\d+\.\d+px"/)
  })

  test('Ctrl+Alt+G frames two Buttons and an arrow nudges an absolute Button', async ({ page }) => {
    const { button } = await open(page)
    const before = await Promise.all([1, 2].map((n) => box(button(n))))
    await pressCentre(page, button(1))
    await pressCentre(page, button(2), 'Shift')
    await page.keyboard.press('Control+Alt+g')
    await expect.poll(readPage, { timeout: 30_000 }).not.toBe(FIXTURE_PAGE)
    const framed = await Promise.all([1, 2].map((n) => box(button(n))))
    framed.forEach((now, i) => {
      near(now.left, before[i]!.left, `framed button ${i + 1} left`)
      near(now.top, before[i]!.top, `framed button ${i + 1} top`)
    })

    const free = button(4)
    const freeBefore = await box(free)
    await pressCentre(page, free)
    await page.keyboard.press('ArrowRight')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('left: "101px"')
    near((await box(free)).left, freeBefore.left + 1, 'nudged Button left')
  })
})
