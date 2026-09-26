import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame } from './helpers/canvasIframe'

/**
 * P3-B — real-browser proof that ordinary React renders, and that the one shape
 * Studio still cannot read is named instead of drawn as a blank frame.
 *
 * - WB-3: `<li>Opening act</li>` shows its text, and double-click editing it
 *   writes exactly that `<li>` (the file bytes are asserted).
 * - WB-4 / WB-26: a `memo()` component and a `<React.Fragment>` child render
 *   their own markup, not an "Unknown module" / package placeholder.
 * - WB-5: a page whose default export is `lazy(…)` says so in its frame.
 *
 * SAFETY — this spec WRITES, so its fixture lives under this run's throwaway
 * copy of `studio-workspace/` and is removed afterwards.
 */

const HOME = `import React, { memo } from 'react'

const Headliner = memo(function Headliner() {
  return <strong className="headliner">Night owls</strong>
})

export default function Home() {
  return (
    <main>
      <ul className="acts">
        <li className="act">Opening act</li>
      </ul>
      <React.Fragment>
        <h2 className="stage">Main stage</h2>
      </React.Fragment>
      <Headliner />
    </main>
  )
}
`

const LATER = `import { lazy } from 'react'
export default lazy(() => import('./Home'))
`

let fixture: FixtureProject

const homePath = () => path.join(fixture.dir, 'pages', 'Home.tsx')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-ordinary-react-renders', {
    'pages/Home.tsx': HOME,
    'pages/Later.tsx': LATER,
    // Pinned to the static tier: what is under test is the PARSED board.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

test.describe('P3-B — ordinary React renders', () => {
  test.setTimeout(180_000)

  test('text in an <li>, a memo() component and a React.Fragment child all render their own markup', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = await frameForPage(page, canvasRoot, 'home')
    const content = canvasContentFrame(frame)

    // By node id, not class: a class with no stylesheet rule never reaches the
    // DOM (`studio-import.md`, board-27f), and this fixture ships no CSS.
    const byId = (tag: string) => content.locator(`[data-node-id="${sourceNodeId(HOME, 'pages/Home.tsx', tag, 1)}"]`).first()
    await expect(byId('li')).toHaveText('Opening act', { timeout: 30_000 })
    await expect(byId('h2')).toHaveText('Main stage')
    // The memo() component's own markup, inlined under its instance.
    await expect(content.locator('strong', { hasText: 'Night owls' })).toHaveCount(1)
    await expect(content.getByText(/unknown module/i)).toHaveCount(0)
  })

  test('double-click editing the <li> text writes exactly that <li>', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    const content = canvasContentFrame(frame)
    const item = content.locator(`[data-node-id="${sourceNodeId(HOME, 'pages/Home.tsx', 'li', 1)}"]`).first()
    await panIntoView(page, canvasRoot, item, 80)
    const box = await item.boundingBox()
    expect(box, 'the <li> has no bounding box').not.toBeNull()
    await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(content.locator('[contenteditable]'), 'double-clicking the <li> did not open inline editing').toHaveCount(1, {
      timeout: 15_000,
    })
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText('Closing act')
    await page.keyboard.press('Control+Enter')

    const expected = HOME.replace('<li className="act">Opening act</li>', '<li className="act">{"Closing act"}</li>')
    await expect
      .poll(() => fs.readFileSync(homePath(), 'utf8'), { message: 'the <li> text edit never reached the file', timeout: 30_000 })
      .toBe(expected)
  })

  test('a page whose default export is lazy(…) names that shape instead of drawing a blank frame', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = await frameForPage(page, canvasRoot, 'later')
    const hint = frame.getByTestId('canvas-empty-page-hint')
    await expect(hint).toContainText('lazy()', { timeout: 30_000 })
    await expect(hint).not.toContainText('This page is empty')
  })
})
