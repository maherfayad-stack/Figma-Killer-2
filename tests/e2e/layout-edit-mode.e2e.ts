import { expect, test, type Page, type Request } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  selectInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * G-8 — "Edit layout": on a Next App Router project, a structural gesture on
 * the layout is refused until the user opts in to editing THAT layout file, in
 * a real browser, asserted on the files on disk and on the `/save` requests:
 *
 *   - Delete on the layout's footer is refused with a dialog whose remedy is
 *     "Edit layout (2 routes)" — nothing is written;
 *   - taking the remedy starts the mode (a toolbar chip says so), re-runs the
 *     Delete, and `app/layout.tsx` loses the footer — no other file changes;
 *   - ONE ⌘Z restores the layout byte for byte, and the mode stays on;
 *   - "Done" on the chip ends the mode and the same Delete is refused again.
 *
 * SAFETY — this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const LAYOUT = 'app/layout.tsx'
const HOME = 'app/page.tsx'
const CLASSES = 'app/classes/page.tsx'

const LAYOUT_SOURCE = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell" style={{ padding: "16px" }}>
      <nav className="menu">
        <a href="/">Studio</a>
        <a href="/classes">Classes</a>
      </nav>
      {children}
      <footer className="hours">Open Tue to Sat</footer>
    </div>
  )
}
`

const HOME_SOURCE = `export default function Home() {
  return (
    <main>
      <h1>Wheel and kiln</h1>
    </main>
  )
}
`

const CLASSES_SOURCE = `export default function Classes() {
  return (
    <main>
      <h1>Evening classes</h1>
    </main>
  )
}
`

const NEXT_APP_PROFILE = {
  probeVersion: 2,
  framework: 'next-app',
  appRoot: '',
  pagesDir: 'app',
  routeStyle: 'file-router',
  entryFiles: [],
  packageManager: 'npm',
  styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
  componentPackages: [],
  designSystems: [],
  colorScheme: { mechanism: 'none' },
  aliases: {},
  warnings: [],
}

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-layout-edit', {
    'package.json': JSON.stringify({ name: 'kiln', private: true, dependencies: { next: '14.2.0', react: '18.3.1', 'react-dom': '18.3.1' } }, null, 2) + '\n',
    'next.config.js': 'module.exports = {}\n',
    [LAYOUT]: LAYOUT_SOURCE,
    [HOME]: HOME_SOURCE,
    [CLASSES]: CLASSES_SOURCE,
    // What `probeProject` records for this shape at import time (`githubImportRoutes.ts`): the load
    // reads the framework from here and never re-probes, so a hand-made project has to say it.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'app', trust: 'static', profile: NEXT_APP_PROFILE }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

function recordSaves(page: Page): Request[] {
  const saves: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request)
  })
  return saves
}

const QUIET_MS = 2_000
const FOOTER = sourceNodeId(LAYOUT_SOURCE, LAYOUT, 'footer', 1)

async function selectFooter(page: Page) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = await frameForPage(page, canvasRoot, '/')
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const footer = canvasContentFrame(frame).locator(`[data-node-id="${FOOTER}"]`).first()
  await panIntoView(page, canvasRoot, footer, 80)
  await selectInFrame(page, footer)
  // The footer is a layout node: selecting it is what shows the layout notice (the production bundle has no `/src` to read the store from).
  await expect(page.getByTestId('layout-notice')).toBeVisible({ timeout: 20_000 })
}

test.describe('G-8 — Edit layout', () => {
  test.setTimeout(240_000)

  test('a Delete on the layout is refused until "Edit layout" is chosen; then it writes the layout file, ⌘Z restores it, and Done ends the mode', async ({ page }) => {
    await selectFooter(page)
    const saves = recordSaves(page)

    // Refused: a dialog with the remedy, nothing written.
    await page.keyboard.press('Delete')
    const refusal = page.getByText('Deleted markup from a layout file')
    await expect(refusal).toBeVisible({ timeout: 20_000 })
    const edit = page.getByTestId('constraint-action-edit-layout')
    await expect(edit).toHaveText('Edit layout (2 routes)')
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a refused gesture writes nothing').toHaveLength(0)
    expect(read(LAYOUT)).toBe(LAYOUT_SOURCE)

    // The remedy starts the mode and runs the Delete: one write, to the layout file alone.
    await edit.click()
    await expect(page.getByTestId('layout-edit-chip')).toContainText('Editing layout app/layout.tsx · 2 routes')
    await expect
      .poll(() => read(LAYOUT), { timeout: 30_000 })
      .toBe(LAYOUT_SOURCE.replace('      <footer className="hours">Open Tue to Sat</footer>\n', ''))
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'the replayed Delete is ONE source write').toHaveLength(1)
    expect(saves[0]!.postDataJSON().edits).toEqual([expect.objectContaining({ kind: 'delete', nodeId: FOOTER })])
    expect(read(HOME)).toBe(HOME_SOURCE)
    expect(read(CLASSES)).toBe(CLASSES_SOURCE)

    // ONE ⌘Z puts the layout back byte for byte, and the mode stays on.
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(LAYOUT), { timeout: 30_000 }).toBe(LAYOUT_SOURCE)
    await expect(page.getByTestId('layout-edit-chip')).toBeVisible()

    // Done ends the mode; the same Delete is refused again.
    await page.getByTestId('layout-edit-chip').click()
    await expect(page.getByTestId('layout-edit-chip')).toBeHidden()
    const writesBefore = saves.length
    await selectFooter2(page)
    await page.keyboard.press('Delete')
    await expect(page.getByText('Deleted markup from a layout file')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(QUIET_MS)
    expect(saves).toHaveLength(writesBefore)
    expect(read(LAYOUT)).toBe(LAYOUT_SOURCE)
  })
})

/** Select the footer again on the board that is already open (the fixture was re-read after the undo). */
async function selectFooter2(page: Page) {
  const canvasRoot = page.getByTestId('canvas-root')
  const frame = page.locator('[data-page-id="/"]').first()
  const footer = canvasContentFrame(frame).locator(`[data-node-id="${FOOTER}"]`).first()
  await panIntoView(page, canvasRoot, footer, 80)
  await selectInFrame(page, footer)
  await expect(page.getByTestId('layout-notice')).toBeVisible({ timeout: 20_000 })
}
