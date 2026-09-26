import { expect, test, type Page, type Request } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  clickInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * OD-8 (P3-D2) — a `.map` row's structure is written to the ARRAY the `.map`
 * iterates, in a real browser, asserted on the FILE on disk and on the
 * `/save` requests:
 *
 *   - ⌥↓ on a row moves its element one place down in the array literal —
 *     one write, the comment above the element travelling with it — and ONE
 *     ⌘Z puts the file back byte for byte;
 *   - Delete on a row removes its element; ⌘Z writes it back byte for byte.
 *
 * SAFETY — this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const HOME = 'pages/Home.tsx'

const HOME_PAGE = `const LANES = [
  { id: 'todo', title: 'To do' },
  // work in progress
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
]

export default function Home() {
  return (
    <main style={{ padding: "24px" }}>
      <ul className="lanes">
        {LANES.map((lane) => (
          <li key={lane.id} className="lane">{lane.title}</li>
        ))}
      </ul>
    </main>
  )
}
`

const MOVED = `const LANES = [
  // work in progress
  { id: 'doing', title: 'Doing' },
  { id: 'todo', title: 'To do' },
  { id: 'done', title: 'Done' },
]
`

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-list-rows', {
    [HOME]: HOME_PAGE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
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
const ROW = (k: number) => `${sourceNodeId(HOME_PAGE, HOME, 'li', 1)}#${k}`

async function selectRow(page: Page, k: number) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = await frameForPage(page, canvasRoot, 'home')
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  const row = canvasContentFrame(frame).locator(`[data-node-id="${ROW(k)}"]`).first()
  await panIntoView(page, canvasRoot, row, 80)
  await clickInFrame(page, row)
  const selected = () =>
    page.evaluate(async () => {
      const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
      return useEditorStore.getState().selectedNodeId as string | null
    })
  // A click may select an outer layer first (P2-B, Figma's click-through):
  // Enter goes one level in, Tab to the next sibling — down to row `k`.
  for (let i = 0; i < 8; i += 1) {
    const now = await selected()
    if (now === ROW(k)) break
    await page.keyboard.press(now?.includes('#') ? 'Tab' : 'Enter')
    await page.waitForTimeout(300)
  }
  await expect.poll(selected, { timeout: 20_000 }).toBe(ROW(k))
  return { selected }
}

test.describe('OD-8 — a .map row edits the array', () => {
  test.setTimeout(240_000)

  test('⌥↓ moves the row’s element down the array in one write; ONE ⌘Z restores the file', async ({ page }) => {
    const { selected } = await selectRow(page, 0)
    const saves = recordSaves(page)

    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE.replace(HOME_PAGE.slice(0, HOME_PAGE.indexOf(']\n') + 2), MOVED))
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a row reorder is ONE source write').toHaveLength(1)
    expect(saves[0]!.postDataJSON().edits).toEqual([
      expect.objectContaining({ kind: 'list-item', op: { kind: 'reorder', order: [1, 0, 2] } }),
    ])
    // The selection followed the row to its new index.
    await expect.poll(selected, { timeout: 20_000 }).toBe(ROW(1))

    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })

  test('Delete removes the row’s element from the array; ⌘Z writes it back byte for byte', async ({ page }) => {
    await selectRow(page, 1)

    await page.keyboard.press('Delete')
    await expect
      .poll(() => read(HOME), { timeout: 30_000 })
      .toBe(HOME_PAGE.replace("  // work in progress\n  { id: 'doing', title: 'Doing' },\n", ''))

    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })
})
