import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * W2-3 leftovers, measured with a real mouse against computed layout:
 *
 *   1. An insertion drag shows the ELEMENT under the pointer (Figma's ghost):
 *      its measured rect is the element's own size times the canvas zoom, at
 *      half opacity, top-left on the pointer, and it follows the pointer.
 *   2. A drop between siblings lands at the exact index the pointer is at -
 *      in a column and a row, with a gap and with margins, over the seam and
 *      over the near half of a sibling, at 100 % and 41 % zoom.
 *   3. The board's loose layers are listed in the explorer's Canvas section:
 *      selectable, renamable (written to boards.json) and reorderable (written
 *      as z, front first).
 *
 * SAFETY - writes only to this run's throwaway fixtures under the e2e workspace.
 */

const LABELS = ['Label 1', 'Label 2', 'Label 3', 'Label 4']

const NEWLINE = '\n'

const labelRun =(tag: 'p' | 'span', style: string) =>
  LABELS.map((text) => `        <${tag} style={{ ${style} }}>${text}</${tag}>`).join('\n')

/**
 * One container per layout under test, so each drop starts from a pristine
 * list of four (a drop is never undone mid-test).
 */
const CONTAINERS = [
  { name: 'colGapSeam', css: 'flexDirection: "column", gap: "20px"', tag: 'p', item: 'margin: 0, height: "40px", background: "#cde"' },
  { name: 'colGapUpper3', css: 'flexDirection: "column", gap: "20px"', tag: 'p', item: 'margin: 0, height: "40px", background: "#cde"' },
  { name: 'colMarginSeam', css: 'flexDirection: "column"', tag: 'p', item: 'margin: "0 0 14px 0", height: "40px", background: "#cde"' },
  { name: 'colMarginLower2', css: 'flexDirection: "column"', tag: 'p', item: 'margin: "0 0 14px 0", height: "40px", background: "#cde"' },
  { name: 'rowMarginSeam', css: 'flexDirection: "row"', tag: 'span', item: 'margin: "0 16px 0 0", width: "100px", height: "40px", background: "#cde"' },
  { name: 'rowTightSeam', css: 'flexDirection: "row"', tag: 'span', item: 'margin: 0, width: "100px", height: "40px", background: "#cde"' },
  { name: 'rowTightLeft3', css: 'flexDirection: "row"', tag: 'span', item: 'margin: 0, width: "100px", height: "40px", background: "#cde"' },
] as const
type BoxName = (typeof CONTAINERS)[number]['name']

const FIXTURE_PAGE = `export default function Home() {
  return (
    <main style={{ padding: "30px", width: "560px", fontFamily: "sans-serif", background: "#fff" }}>
${CONTAINERS.map(
  (box) => `      <div style={{ display: "flex", ${box.css}, padding: "10px", marginBottom: "24px", background: "#eee" }}>
${labelRun(box.tag, box.item)}
      </div>`,
).join(NEWLINE)}
    </main>
  )
}
`

const REL = 'pages/Home.tsx'
const LAYER_IDS = ['clalpha00001', 'clbravo00002', 'clcharlie003'] as const

const layerModule = (label: string, color: string) => `/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
export default function CanvasLayer() {
  return (
    <div style={{ width: "80px", height: "40px", background: "${color}" }}>${label}</div>
  )
}
`

let fixture: FixtureProject
const readBoards = (): { boards: { layers?: { id: string; x: number; y: number; z?: number; name?: string }[] }[] } =>
  JSON.parse(fs.readFileSync(path.join(fixture.dir, '.studio', 'boards.json'), 'utf8'))

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-board-layers-leftovers', {
    [REL]: FIXTURE_PAGE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static', frameDefaults: { width: 700, height: 1500 } }, null, 2) + '\n',
    '.studio/canvas/clalpha00001.tsx': layerModule('A', 'tomato'),
    '.studio/canvas/clbravo00002.tsx': layerModule('B', 'seagreen'),
    '.studio/canvas/clcharlie003.tsx': layerModule('C', 'royalblue'),
    '.studio/boards.json':
      JSON.stringify(
        {
          version: 1,
          boards: [
            {
              id: 'board-1',
              name: 'Board 1',
              frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0, width: 700, height: 1500 }],
              notes: [],
              docs: [],
              layers: [
                { id: LAYER_IDS[0], x: -400, y: 0, z: 1 },
                { id: LAYER_IDS[1], x: -400, y: 100, z: 2 },
                { id: LAYER_IDS[2], x: -400, y: 200, z: 3 },
              ],
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

interface Opened {
  canvasRoot: Locator
  content: FrameLocator
  container: (name: BoxName) => Locator
}

async function openBoard(page: Page, zoomPercent: number): Promise<Opened> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const frame = page.locator('[data-page-id]').first()
  if (zoomPercent !== 100) await zoomToPercent(page, canvasRoot, zoomPercent)
  await panIntoView(page, canvasRoot, frame, 80)
  await expect(visibleCanvasIframe(frame)).toHaveCount(1, { timeout: 60_000 })
  const content = canvasContentFrame(frame)
  // By position among <main>'s children: a drop shifts every later source line, so a node id would not survive the first insert.
  const container = (name: BoxName) => content.locator('main > div').nth(CONTAINERS.findIndex((box) => box.name === name))
  await expect(container('colGapSeam')).toBeVisible({ timeout: 30_000 })
  return { canvasRoot, content, container }
}

/** Screen px per frame px, from the container's painted width over its layout width. */
async function zoomOf(container: Locator): Promise<number> {
  const screen = (await container.boundingBox())!.width
  const layout = await container.evaluate((el) => (el as HTMLElement).offsetWidth)
  return screen / layout
}

/** The container's children in DOM order: their label, or `(new)` for the empty Div a drop makes (the canvas paints its own placeholder text in it). */
const childTexts = (container: Locator): Promise<string[]> =>
  container.evaluate((el) =>
    Array.from(el.children).map((child) => {
      const text = (child.textContent ?? '').trim()
      return text.startsWith('Label ') ? text : '(new)'
    }),
  )

async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('no bounding box')
  return rect
}

/** Press the notch Div button, travel past the threshold, then aim at `to` in several steps. Returns once settled over it, button still down. */
async function dragDivOnto(page: Page, to: { x: number; y: number }): Promise<void> {
  const button = await box(page.getByTestId('canvas-notch-div-btn'))
  const fromX = button.x + button.width / 2
  const fromY = button.y + button.height / 2
  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move(fromX + 20, fromY + 20, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 16 })
  await page.waitForTimeout(250)
}

interface Scenario {
  name: string
  container: BoxName
  /** Where the pointer goes, from the measured children (screen px). */
  aim: (children: Array<{ x: number; y: number; width: number; height: number }>) => { x: number; y: number }
  /** The order after the drop. */
  expected: string[]
}

const BETWEEN_2_AND_3 = ['Label 1', 'Label 2', '(new)', 'Label 3', 'Label 4']
const verticalSeam = (c: Array<{ x: number; y: number; width: number; height: number }>) => ({
  x: c[1]!.x + c[1]!.width / 2,
  y: (c[1]!.y + c[1]!.height + c[2]!.y) / 2,
})
const horizontalSeam = (c: Array<{ x: number; y: number; width: number; height: number }>) => ({
  x: (c[1]!.x + c[1]!.width + c[2]!.x) / 2,
  y: c[1]!.y + c[1]!.height / 2,
})

const SCENARIOS: Scenario[] = [
  { name: 'column with a gap: the gap between Label 2 and Label 3', container: 'colGapSeam', aim: verticalSeam, expected: BETWEEN_2_AND_3 },
  { name: 'column with margins: the margin between Label 2 and Label 3', container: 'colMarginSeam', aim: verticalSeam, expected: BETWEEN_2_AND_3 },
  {
    name: 'column: the upper part of Label 3 lands BEFORE Label 3',
    container: 'colGapUpper3',
    aim: (c) => ({ x: c[2]!.x + c[2]!.width / 2, y: c[2]!.y + c[2]!.height * 0.42 }),
    expected: BETWEEN_2_AND_3,
  },
  {
    name: 'column: the lower part of Label 2 lands AFTER Label 2',
    container: 'colMarginLower2',
    aim: (c) => ({ x: c[1]!.x + c[1]!.width / 2, y: c[1]!.y + c[1]!.height * 0.58 }),
    expected: BETWEEN_2_AND_3,
  },
  { name: 'row with margins: the margin between Label 2 and Label 3', container: 'rowMarginSeam', aim: horizontalSeam, expected: BETWEEN_2_AND_3 },
  { name: 'row without gaps: the seam between Label 2 and Label 3', container: 'rowTightSeam', aim: horizontalSeam, expected: BETWEEN_2_AND_3 },
  {
    name: 'row: the left part of Label 3 lands BEFORE Label 3',
    container: 'rowTightLeft3',
    aim: (c) => ({ x: c[2]!.x + c[2]!.width * 0.42, y: c[2]!.y + c[2]!.height / 2 }),
    expected: BETWEEN_2_AND_3,
  },
]

for (const zoomPercent of [100, 41]) {
  test.describe(`a drop between siblings at ${zoomPercent}% zoom`, () => {
    test.setTimeout(420_000)

    test(`lands at the exact index the pointer is at, in ${SCENARIOS.length} layouts`, async ({ page }) => {
      const { container } = await openBoard(page, zoomPercent)
      for (const scenario of SCENARIOS) {
        const target = container(scenario.container)
        await target.scrollIntoViewIfNeeded()
        await panIntoView(page, page.getByTestId('canvas-root'), target, 200)
        expect(await childTexts(target), `${scenario.name}: precondition`).toEqual(LABELS)
        const children = await Promise.all(
          Array.from({ length: 4 }, (_, i) => box(target.locator(':scope > *').nth(i))),
        )
        const aim = scenario.aim(children)

        await dragDivOnto(page, aim)
        // The drop line says where; it is also the contract: capture it before release.
        const lineBox = await page.locator('[data-position="gap"], [data-position="before"], [data-position="after"]').first().boundingBox()
        // An insert adds source lines, so every LATER container gets a new node id once the board has
        // re-read the file. The next drop must start after that (a second structural write against
        // the stale ids is refused as "no longer on the board"), so remember what to wait for.
        const nextName = CONTAINERS[CONTAINERS.findIndex((box) => box.name === scenario.container) + 1]?.name
        const next = nextName ? container(nextName) : null
        const nextIdBefore = next ? await next.getAttribute('data-node-id') : null
        await page.mouse.up()

        await expect
          .poll(() => childTexts(target), { timeout: 30_000, message: `${scenario.name}: the new element is not at index 2` })
          .toEqual(scenario.expected)
        expect(lineBox, `${scenario.name}: no drop line was shown while the pointer was over the container`).not.toBeNull()
        if (next) await expect.poll(() => next.getAttribute('data-node-id'), { timeout: 30_000 }).not.toBe(nextIdBefore)
      }
    })
  })
}

test.describe('the insertion ghost', () => {
  test.setTimeout(300_000)

  for (const zoomPercent of [100, 41]) {
    test(`is the element at its own size x the zoom, half opaque, on the pointer, at ${zoomPercent}%`, async ({ page }) => {
      const { container } = await openBoard(page, zoomPercent)
      const target = container('colGapSeam')
      const zoom = await zoomOf(target)
      const children = await box(target.locator(':scope > *').nth(1))

      await dragDivOnto(page, { x: children.x + 40, y: children.y + 10 })
      const ghostBody = page.locator('[data-insertion-ghost-body]')
      await expect(ghostBody).toHaveCount(1)

      const first = await box(ghostBody)
      // The notch Div is a 100 x 100 box: the ghost is that box at the canvas zoom.
      expect(Math.abs(first.width - 100 * zoom)).toBeLessThanOrEqual(1)
      expect(Math.abs(first.height - 100 * zoom)).toBeLessThanOrEqual(1)
      expect(Number(await ghostBody.evaluate((el) => getComputedStyle(el).opacity))).toBeCloseTo(0.5, 2)
      // Top-left on the pointer.
      expect(Math.abs(first.x - (children.x + 40))).toBeLessThanOrEqual(2)
      expect(Math.abs(first.y - (children.y + 10))).toBeLessThanOrEqual(2)

      // It follows the pointer without being remounted.
      await ghostBody.evaluate((el) => el.setAttribute('data-probe', 'same-element'))
      await page.mouse.move(children.x + 160, children.y + 70, { steps: 8 })
      await page.waitForTimeout(150)
      const moved = await box(ghostBody)
      expect(Math.abs(moved.x - (children.x + 160))).toBeLessThanOrEqual(2)
      expect(Math.abs(moved.y - (children.y + 70))).toBeLessThanOrEqual(2)
      expect(await ghostBody.getAttribute('data-probe'), 'the ghost was re-created instead of moved').toBe('same-element')
      await page.mouse.up()
    })
  }

  test('a project image is drawn at its natural size x the zoom', async ({ page }) => {
    fs.mkdirSync(path.join(fixture.dir, 'public'), { recursive: true })
    fs.writeFileSync(path.join(fixture.dir, 'public', 'ghost-cat.png'), solidPng(64, 48))
    const { container } = await openBoard(page, 41)
    const zoom = await zoomOf(container('colGapSeam'))

    await page.getByTestId('panel-rail-assets').click()
    const assets = page.getByTestId('assets-panel')
    await expect(assets).toBeVisible({ timeout: 10_000 })
    await assets.getByRole('searchbox', { name: 'Search assets' }).fill('ghost-cat')
    const card = assets.locator('[data-testid="assets-image-card"][data-asset-path="public/ghost-cat.png"]')
    await expect(card).toBeVisible({ timeout: 30_000 })
    // The card's own thumbnail must have decoded - the ghost takes its size from it.
    await expect.poll(() => card.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(64)

    const from = await box(card)
    const to = await box(container('colGapSeam').locator(':scope > *').nth(1))
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
    await page.mouse.move(to.x + 30, to.y + 6, { steps: 14 })
    await page.waitForTimeout(250)

    const ghost = await box(page.locator('[data-insertion-ghost-body]'))
    expect(Math.abs(ghost.width - 64 * zoom)).toBeLessThanOrEqual(1)
    expect(Math.abs(ghost.height - 48 * zoom)).toBeLessThanOrEqual(1)
    await page.mouse.up()
  })
})

test.describe('board layers in the Layers panel', () => {
  test.setTimeout(300_000)

  const rows = (page: Page) => page.getByTestId('canvas-layer-row')

  test('every loose layer has a row; a click selects, a double-click renames, a drag reorders', async ({ page }) => {
    await openBoard(page, 100)
    const section = page.getByTestId('studio-canvas-layers')
    await expect(section, 'the Layers panel has no Canvas section for the board layers').toBeVisible({ timeout: 30_000 })
    await expect(rows(page)).toHaveCount(LAYER_IDS.length)
    // Front first: the layer with the highest z is the first row.
    await expect(rows(page).nth(0)).toHaveAttribute('data-canvas-layer-id', LAYER_IDS[2])
    await expect(rows(page).nth(2)).toHaveAttribute('data-canvas-layer-id', LAYER_IDS[0])

    // Select.
    await rows(page).nth(1).click()
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'false')

    // Rename.
    await rows(page).nth(1).dblclick()
    const input = page.getByRole('textbox', { name: /Rename canvas layer/ })
    await expect(input).toBeVisible()
    await input.fill('Hero card')
    await input.press('Enter')
    await expect(rows(page).nth(1)).toContainText('Hero card')
    await expect
      .poll(() => readBoards().boards[0]!.layers!.find((layer) => layer.id === LAYER_IDS[1])?.name, { timeout: 30_000 })
      .toBe('Hero card')

    // Reorder: drag the front row below the last one - it becomes the back layer.
    const first = await box(rows(page).nth(0))
    const last = await box(rows(page).nth(2))
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 12, { steps: 4 })
    await page.mouse.move(last.x + last.width / 2, last.y + last.height - 2, { steps: 8 })
    await page.mouse.up()

    await expect(rows(page).nth(2)).toHaveAttribute('data-canvas-layer-id', LAYER_IDS[2])
    await expect(rows(page).nth(0)).toHaveAttribute('data-canvas-layer-id', LAYER_IDS[1])
    await expect
      .poll(
        () => {
          const layers = readBoards().boards[0]!.layers!
          const zOf = (id: string) => layers.find((layer) => layer.id === id)?.z
          return [zOf(LAYER_IDS[2]), zOf(LAYER_IDS[0]), zOf(LAYER_IDS[1])]
        },
        { timeout: 30_000, message: 'the reorder was not written as z (back, middle, front)' },
      )
      .toEqual([1, 2, 3])
  })
})

/** A solid-colour RGB PNG, built here so the file is a real decodable image of a known size. */
function solidPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9a)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
