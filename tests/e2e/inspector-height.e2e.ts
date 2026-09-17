import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * WS-14.5 — the inspector height gate: **a text node's whole Design tab
 * renders with no internal scrollbar at a 900px viewport**, for the four
 * baseline fixtures (`docs/audits/penpot-inspector-baseline/01-fixtures.md`:
 * F1 rectangle, F2 text, F3 flex board, F4 image).
 *
 * `docs/features/inspector.md` §6 has carried that claim since before P3 and
 * has never been enforced at 900px — the existing
 * `tests/e2e/inspector-panel-measurement.e2e.ts` gate opens a 2100px-tall
 * viewport and asserts against the ~1826px the panel really was. S5 is what
 * makes 900px reachable: the four Studio-extras sections (Transform,
 * Animations, Interaction, Custom properties) moved behind ONE collapsed
 * **More** disclosure, which the static half of this gate
 * (`src/__tests__/inspector/measurement.test.ts`) computes as 164px of
 * always-mounted Design-tab height bought back. This file is the REAL half —
 * happy-dom does not lay out a DOM, so `scrollHeight`/`clientHeight` are only
 * available in a real browser against a real dev server.
 *
 * ## Why a throwaway fixture project, not `studio-workspace/test4`
 *
 * The work order named `studio-workspace/test4`. That is REAL USER DATA —
 * `CLAUDE.md`'s repo-layout table says so in as many words ("USER DATA — the
 * real React repos Studio edits. Never rm -rf."). A gate whose fixtures are a
 * project the user edits between runs is not a gate: its four selections
 * would drift, and a failure would be indistinguishable from the user having
 * restyled a box. So this spec follows the convention
 * `inspector-panel-measurement.e2e.ts` already established — a fresh,
 * throwaway project created directly INSIDE `studio-workspace/` (the one
 * shape `resolveProjectDir`'s containment check accepts; an OS temp dir
 * throws `ProjectDirOutsideWorkspaceError`) under a `ws145-e2e-` prefix,
 * removed in `afterAll`. It reproduces the same F1/F2/F3 shapes as that
 * spec's fixture, plus the F4 image the baseline names and that spec never
 * had (`clickCountsToCommonEdit.f4_downloadSourceImage` is skipped there for
 * exactly this reason). Nothing here touches an existing project.
 *
 * ## The artefact this writes
 *
 * On a successful run this writes the MEASURED per-section height table to
 * `docs/audits/penpot-inspector-baseline/05-section-heights.json`, keyed by
 * fixture then `data-section-id`. The committed
 * `05-section-heights.md` beside it explains the file and carries the
 * COMPUTED baseline the static gate pins, so the two can be diffed. Writing
 * the artefact is deliberately the last thing each fixture does — a failing
 * assertion must not overwrite a good baseline with a bad one.
 *
 * ## Not run by `bun test`
 *
 * This is a Playwright spec (`npx playwright test tests/e2e/inspector-height.e2e.ts`),
 * run by the human or CI against a real dev server. `bun test` never picks it
 * up.
 */

const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
const EDITOR_LAYOUT_STORAGE_KEY = 'studio-editor-layout-v2'
const FIXTURE_PROJECT_NAME = `ws145-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** The budget §6 names, and the whole point of this file. */
const HEIGHT_BUDGET_VIEWPORT = { width: 1400, height: 900 } as const

const HEIGHTS_ARTEFACT = path.join(
  'docs',
  'audits',
  'penpot-inspector-baseline',
  '05-section-heights.json',
)

const FIXTURE_CSS = `.page {
  /* Plain block flow, not flex — same reasoning as
     inspector-panel-measurement.e2e.ts's own fixture: it keeps .page a
     non-flex PARENT, so MeasuresSection renders its plain TRBL
     "Constraints" face rather than the "Flex element" one, and the canvas
     auto-fit pan stays centred on real content. */
  width: 800px;
  padding: 40px;
}

.rectangle {
  position: relative;
  width: 240px;
  height: 160px;
  margin-bottom: 40px;
  border-radius: 8px;
  background: #1e88e5;
}

.text-layer {
  width: 300px;
  height: 24px;
  margin: 0 0 40px;
  font-family: 'Source Sans Pro', sans-serif;
  font-size: 24px;
  font-weight: 400;
  line-height: 1.2;
  letter-spacing: 0;
  color: #000000;
}

.board {
  display: flex;
  flex-direction: row;
  column-gap: 16px;
  padding: 24px;
  width: 480px;
  height: 200px;
  margin-bottom: 40px;
  background: #ffffff;
}

.board-child-a {
  width: 120px;
  height: 80px;
  background: #43a047;
}

.board-child-b {
  width: 120px;
  height: 80px;
  background: #fb8c00;
}

.image-layer {
  /* F4 — the image fixture the P0 baseline names and the existing
     measurement spec never had. object-fit is what makes Fill's content-fit
     row real for this selection. */
  width: 240px;
  height: 160px;
  object-fit: cover;
  border-radius: 8px;
}
`

/** A real, self-contained raster the fixture page can point an <img> at. */
const FIXTURE_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <rect width="240" height="160" fill="#8e24aa" />
  <circle cx="120" cy="80" r="48" fill="#ffd54f" />
</svg>
`

const FIXTURE_PAGE = `import './Home.css'

export default function Home() {
  return (
    <div className="page">
      <div className="rectangle" />
      <p className="text-layer">The quick brown fox jumps</p>
      <div className="board">
        <div className="board-child-a" />
        <div className="board-child-b" />
      </div>
      <img className="image-layer" src="./fixture.svg" alt="Fixture" />
    </div>
  )
}
`

let fixtureDir: string

test.beforeAll(() => {
  fixtureDir = path.join(process.cwd(), 'studio-workspace', FIXTURE_PROJECT_NAME)
  fs.mkdirSync(path.join(fixtureDir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'Home.css'), FIXTURE_CSS, 'utf8')
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'Home.tsx'), FIXTURE_PAGE, 'utf8')
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'fixture.svg'), FIXTURE_IMAGE_SVG, 'utf8')
})

test.afterAll(() => {
  // Guarded by the `ws145-e2e-` prefix this spec itself generated — never a
  // bare rm of whatever `fixtureDir` happens to hold.
  if (fixtureDir && path.basename(fixtureDir).startsWith('ws145-e2e-')) {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  }
})

/** Same shape as `inspector-panel-measurement.e2e.ts`'s own `openStudioBoard`. */
async function openStudioBoard(page: Page, projectDir: string): Promise<Locator> {
  await page.addInitScript(
    ({ dir, layoutKey }: { dir: string; layoutKey: string }) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
      window.localStorage.removeItem(layoutKey)
    },
    { dir: projectDir, layoutKey: EDITOR_LAYOUT_STORAGE_KEY },
  )

  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 30_000 })
  await expect(page.locator(CANVAS_FRAME_IFRAME_SELECTOR).first()).toBeVisible({ timeout: 20_000 })
  return canvasRoot
}

/** Same mechanism as `inspector-panel-measurement.e2e.ts`'s own `panIntoView`. */
async function panIntoView(page: Page, canvasRoot: Locator, target: Locator, tolerancePx = 40): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox) throw new Error('panIntoView: the canvas root has no bounding box')
    if (!targetBox) throw new Error('panIntoView: target has no bounding box')

    const rootCenterX = rootBox.x + rootBox.width / 2
    const rootCenterY = rootBox.y + rootBox.height / 2
    const dx = targetBox.x + targetBox.width / 2 - rootCenterX
    const dy = targetBox.y + targetBox.height / 2 - rootCenterY

    if (Math.abs(dx) <= tolerancePx && Math.abs(dy) <= tolerancePx) return

    await page.mouse.move(rootCenterX, rootCenterY)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target never reached the viewport centre after 20 pan attempts')
}

/**
 * Click a layer inside the canvas iframe. `offset` exists for `.board`,
 * whose centre is covered by its own children — its own padding corner is
 * the only point that selects the CONTAINER.
 */
async function clickLayer(
  page: Page,
  canvasRoot: Locator,
  target: Locator,
  offset?: { x: number; y: number },
): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  await panIntoView(page, canvasRoot, target)
  const box = await target.boundingBox()
  expect(box, 'click target has no bounding box').not.toBeNull()
  const x = offset ? box!.x + offset.x : box!.x + box!.width / 2
  const y = offset ? box!.y + offset.y : box!.y + 4
  await page.mouse.click(x, y)
}

const panelScroll = (page: Page) => page.getByTestId('properties-panel-scroll')

interface Fixture {
  /** Baseline id — F1..F4, `01-fixtures.md`'s own names. */
  id: 'f1-rectangle' | 'f2-text' | 'f3-flex-board' | 'f4-image'
  selector: string
  /** Click offset from the layer's top-left, for layers whose centre is covered. */
  offset?: { x: number; y: number }
  /** A section this selection MUST mount, so a mis-click fails loudly. */
  requiredSectionId: string
}

const FIXTURES: ReadonlyArray<Fixture> = [
  { id: 'f1-rectangle', selector: '.rectangle', requiredSectionId: 'measures' },
  { id: 'f2-text', selector: '.text-layer', requiredSectionId: 'text' },
  { id: 'f3-flex-board', selector: '.board', offset: { x: 8, y: 8 }, requiredSectionId: 'layout' },
  { id: 'f4-image', selector: '.image-layer', requiredSectionId: 'fill' },
]

/** Per-section rendered heights for the current selection, in DOM order. */
async function readSectionHeights(page: Page): Promise<Record<string, number>> {
  const sections = page.locator('[data-section-id]')
  const count = await sections.count()
  expect(count, 'no [data-section-id] sections mounted').toBeGreaterThan(0)
  const heights: Record<string, number> = {}
  for (let i = 0; i < count; i += 1) {
    const section = sections.nth(i)
    const id = await section.getAttribute('data-section-id')
    if (!id) continue
    // Nested sections inside the More disclosure share this attribute — key
    // the inner ones so the table stays a flat, readable map.
    const key = heights[id] === undefined ? id : `${id}#nested`
    heights[key] = await section.evaluate((el) => Math.round(el.getBoundingClientRect().height))
  }
  return heights
}

function writeHeightsArtefact(table: Record<string, unknown>): void {
  const file = path.join(process.cwd(), HEIGHTS_ARTEFACT)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
}

test.describe('WS-14.5 — the Design tab fits 900px', () => {
  test.setTimeout(180_000)

  test('every baseline fixture renders its whole Design tab with no internal scroll at 900px', async ({
    page,
  }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const frame = page.locator('[data-page-id]').first()
    const contentFrame: FrameLocator = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const table: Record<string, unknown> = {
      viewport: HEIGHT_BUDGET_VIEWPORT,
      note:
        'MEASURED per-section heights, regenerated by tests/e2e/inspector-height.e2e.ts. ' +
        'See 05-section-heights.md for what these are and the computed baseline they are diffed against.',
      fixtures: {},
    }
    const fixtures = table.fixtures as Record<string, unknown>

    for (const fixture of FIXTURES) {
      await clickLayer(page, canvasRoot, contentFrame.locator(fixture.selector).first(), fixture.offset)
      await expect(
        page.locator(`[data-section-id="${fixture.requiredSectionId}"]`),
        `selecting ${fixture.selector} did not mount the ${fixture.requiredSectionId} section`,
      ).toBeVisible({ timeout: 15_000 })

      const scroll = panelScroll(page)
      await expect(scroll).toBeVisible({ timeout: 10_000 })
      const [scrollHeight, clientHeight] = await scroll.evaluate((el) => [
        el.scrollHeight,
        el.clientHeight,
      ])

      const sections = await readSectionHeights(page)
      fixtures[fixture.id] = { scrollHeight, clientHeight, sections }

      expect(
        scrollHeight,
        `${fixture.id}: the Design tab overflows the 900px budget — scrollHeight=${scrollHeight}, ` +
          `clientHeight=${clientHeight}. Per-section heights: ${JSON.stringify(sections)}`,
      ).toBeLessThanOrEqual(clientHeight)
    }

    // Last, so a failure above never overwrites a good baseline.
    writeHeightsArtefact(table)
  })

  test('the four Studio-extras sections are collapsed behind one More disclosure, and still reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const frame = page.locator('[data-page-id]').first()
    const contentFrame = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    await clickLayer(page, canvasRoot, contentFrame.locator('.text-layer').first())
    await expect(page.locator('[data-section-id="text"]')).toBeVisible({ timeout: 15_000 })

    const more = page.getByTestId('inspector-more-disclosure')
    await expect(more, 'the More disclosure never mounted for a text node').toBeVisible({
      timeout: 10_000,
    })

    // Collapsed at rest: none of the four render a body.
    for (const id of ['transform', 'animations', 'interaction', 'customProperties']) {
      await expect(
        page.locator(`[data-section-id="${id}"]`),
        `${id} is mounted in the Design tab at rest — it belongs inside the collapsed More group`,
      ).toHaveCount(0)
    }

    // One click reaches all four — the disclosure is a fold, not a deletion.
    await more.getByRole('button', { name: 'More' }).click()
    for (const id of ['transform', 'animations', 'interaction', 'customProperties']) {
      await expect(
        page.locator(`[data-section-id="${id}"]`),
        `${id} did not appear after expanding More`,
      ).toHaveCount(1)
    }
  })
})
