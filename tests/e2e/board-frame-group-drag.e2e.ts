import { expect, test, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  removeFixtureProject,
  zoomToPercent,
  readZoomPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * O13 — dragging one of several selected frames moves ALL of them, as one.
 *
 * Real mouse only: click the first frame's header, shift-click the second to
 * extend the selection, then drag one selected header. Asserts on the frames'
 * measured rects (both moved by the same delta, the unselected one did not),
 * that the selection survived the press, that `.studio/boards.json` goes from
 * the old positions to the new ones in ONE step (no write ever shows one
 * frame moved and the other not), and that a single Ctrl+Z puts both back.
 *
 * SAFETY — authors its own throwaway fixture under this run's workspace copy.
 */

let fixture: FixtureProject

const PAGE = (name: string) => `export default function ${name}() {
  return (
    <main style={{ minHeight: "200px", background: "#eef" }}>
      <p>${name}</p>
    </main>
  )
}
`

const START = {
  alpha: { x: 0, y: 0 },
  bravo: { x: 450, y: 0 },
  charlie: { x: 900, y: 0 },
} as const

function readPositions(): Record<string, { x: number; y: number }> {
  const file = path.join(fixture.dir, '.studio', 'boards.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    boards: Array<{ frames: Array<{ pageId: string; x: number; y: number }> }>
  }
  return Object.fromEntries(parsed.boards[0]!.frames.map((f) => [f.pageId, { x: f.x, y: f.y }]))
}

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-board-frame-group-drag', {
    'pages/Alpha.tsx': PAGE('Alpha'),
    'pages/Bravo.tsx': PAGE('Bravo'),
    'pages/Charlie.tsx': PAGE('Charlie'),
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
    '.studio/boards.json':
      JSON.stringify(
        {
          version: 1,
          boards: [
            {
              id: 'board-1',
              name: 'Board 1',
              frames: (['alpha', 'bravo', 'charlie'] as const).map((pageId) => ({
                id: `f-${pageId}`,
                pageId,
                x: START[pageId].x,
                y: START[pageId].y,
                width: 393,
                height: 300,
              })),
              notes: [],
              docs: [],
              layers: [],
            },
          ],
        },
        null,
        2,
      ) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

const header = (page: Page, pageId: string) =>
  page.locator(`[data-page-id="${pageId}"]`).first().getByTestId('board-frame-header')

async function frameRect(page: Page, pageId: string) {
  return page
    .locator(`[data-page-id="${pageId}"]`)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y }
    })
}

test('dragging a selected frame moves the whole selection; one write; one undo', async ({ page }) => {
  test.setTimeout(180_000)
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  await expect(page.locator('[data-page-id="charlie"]').first()).toBeAttached({ timeout: 60_000 })
  await zoomToPercent(page, canvasRoot, 40)
  const zoom = (await readZoomPercent(page)) / 100
  await page.waitForTimeout(500)

  // Select alpha, extend with bravo: real clicks on the headers.
  const alphaBox = (await header(page, 'alpha').boundingBox())!
  await page.mouse.click(alphaBox.x + alphaBox.width / 2, alphaBox.y + alphaBox.height / 2)
  const bravoBox = (await header(page, 'bravo').boundingBox())!
  await page.keyboard.down('Shift')
  await page.mouse.click(bravoBox.x + bravoBox.width / 2, bravoBox.y + bravoBox.height / 2)
  await page.keyboard.up('Shift')
  await expect(page.locator('[data-page-id][data-selected="true"]')).toHaveCount(2)

  const before = {
    alpha: await frameRect(page, 'alpha'),
    bravo: await frameRect(page, 'bravo'),
    charlie: await frameRect(page, 'charlie'),
  }

  // Press the already-selected alpha header and drag it.
  const pressBox = (await header(page, 'alpha').boundingBox())!
  const sx = pressBox.x + pressBox.width / 2
  const sy = pressBox.y + pressBox.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(sx + (80 * step) / 8, sy + (48 * step) / 8)
  await page.mouse.up()

  // The selection survived the press and both selected frames moved together.
  await expect(page.locator('[data-page-id][data-selected="true"]')).toHaveCount(2)
  const after = {
    alpha: await frameRect(page, 'alpha'),
    bravo: await frameRect(page, 'bravo'),
    charlie: await frameRect(page, 'charlie'),
  }
  const dx = (name: keyof typeof before) => after[name].x - before[name].x
  const dy = (name: keyof typeof before) => after[name].y - before[name].y
  expect(Math.abs(dx('alpha') - 80)).toBeLessThanOrEqual(8) // snapping may nudge a few px
  expect(Math.abs(dx('bravo') - dx('alpha'))).toBeLessThanOrEqual(0.5)
  expect(Math.abs(dy('bravo') - dy('alpha'))).toBeLessThanOrEqual(0.5)
  expect([dx('charlie'), dy('charlie')]).toEqual([0, 0])

  // boards.json: old positions until the debounced save, then BOTH new, never one without the other.
  const seen: Array<ReturnType<typeof readPositions>> = []
  await expect
    .poll(
      () => {
        const positions = readPositions()
        seen.push(positions)
        return positions.alpha!.x !== START.alpha.x
      },
      { timeout: 30_000, intervals: [25] },
    )
    .toBe(true)
  for (const positions of seen) {
    const alphaMoved = positions.alpha!.x !== START.alpha.x || positions.alpha!.y !== START.alpha.y
    const bravoMoved = positions.bravo!.x !== START.bravo.x || positions.bravo!.y !== START.bravo.y
    expect(alphaMoved, `a write showed one frame moved without the other: ${JSON.stringify(positions)}`).toBe(bravoMoved)
  }
  const saved = readPositions()
  expect(Math.abs(saved.alpha!.x - START.alpha.x - dx('alpha') / zoom)).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.bravo!.x - START.bravo.x - dx('bravo') / zoom)).toBeLessThanOrEqual(1)
  expect(Math.abs(saved.bravo!.y - START.bravo.y - dy('bravo') / zoom)).toBeLessThanOrEqual(1)
  expect(saved.charlie).toEqual(START.charlie)

  // One undo takes the whole move back.
  await canvasRoot.focus()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => Math.abs((await frameRect(page, 'alpha')).x - before.alpha.x), { timeout: 10_000 }).toBeLessThan(1)
  expect(Math.abs((await frameRect(page, 'bravo')).x - before.bravo.x)).toBeLessThan(1)
  expect(Math.abs((await frameRect(page, 'bravo')).y - before.bravo.y)).toBeLessThan(1)
  await expect.poll(() => readPositions().bravo, { timeout: 30_000 }).toEqual(START.bravo)
  expect(readPositions().alpha).toEqual(START.alpha)
})
