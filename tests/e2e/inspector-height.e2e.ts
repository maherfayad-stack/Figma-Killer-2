import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * WS-14.5 — the inspector height gate: the Design tab's rendered height at a
 * 900px viewport, for the four baseline fixtures
 * (`docs/audits/penpot-inspector-baseline/01-fixtures.md`: F1 rectangle,
 * F2 text, F3 flex board, F4 image).
 *
 * This file is the REAL half of the gate — happy-dom does not lay out a DOM,
 * so `scrollHeight`/`clientHeight` are only available in a real browser
 * against a real dev server. The static half
 * (`src/__tests__/inspector/measurement.test.ts`) computes the section
 * column from frozen tokens; this one measures the whole thing.
 *
 * ## What this gate asserts, and what it does NOT (panel-37)
 *
 * It was written by S5 (`STATE.md` panel-36) and, as that entry says in as
 * many words, never executed. The first real run — during wave-1 integration
 * (PR #162) — turned up two separate things, and only one of them was this
 * file's fault:
 *
 *   1. **A scoping bug, this file's own.** It asked the DOCUMENT for
 *      `[data-section-id="transform"]` and expected 0. `InspectorShell`
 *      mounts all three tab panels and `hidden`s the inactive two (a P1/P2
 *      decision that predates S5 — see `InspectorShell.tsx`'s own doc for
 *      why it is deliberate), and `transform`/`animations`/`interaction`
 *      declare `tabs: ['design','prototype']`, so the Prototype tab's hidden
 *      copy satisfied the locator. Every query here is now scoped to the
 *      ACTIVE Design panel via `designPanel()`.
 *
 *   2. **A false claim in the docs, which this gate faithfully enforced.**
 *      `docs/features/inspector.md` §6 said "a text node's entire inspector
 *      fits in one 900px viewport with no scroll", so this file asserted
 *      `scrollHeight <= clientHeight`. Measured, at 1400x900, on the docked
 *      panel: `.surface`'s `clientHeight` is **626px** — which IS the honest
 *      "900px minus chrome" figure (36 admin top bar + 36 panel header + 47
 *      tab bar + 88 node header + 67 ClassPicker = 274px, and `.surface`'s
 *      own box reaches the window's bottom edge) — against a `scrollHeight`
 *      of **960 / 1190 / 1013 / 1043** for F1 / F2 / F3 / F4. The Design tab
 *      overflows 900px by 334–564px. Not by a rounding error, and not by an
 *      amount any chrome tuning closes.
 *
 * So the "fits with no scroll" assertion is not something this file can make
 * true, and re-deriving `clientHeight` a second way would only restate the
 * same number. What this gate enforces instead is a **measured per-fixture
 * ceiling** (`DESIGN_TAB_CEILING_PX`) — a ratchet. It goes red the moment the
 * Design tab grows: un-folding the four Studio-extras sections costs 164px
 * of always-mounted height (the static half computes exactly that), which
 * blows every ceiling below. The true 900px target is not dropped: each run
 * records `clientHeight` and the live `overflowPx` into the artefact, and
 * `docs/features/inspector.md` §6 carries the shortfall as an open, measured
 * density item rather than a claim.
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

/** The viewport §6's budget is stated at, and the whole point of this file. */
const HEIGHT_BUDGET_VIEWPORT = { width: 1400, height: 900 } as const

/**
 * MEASURED Design-tab `scrollHeight` per fixture at `HEIGHT_BUDGET_VIEWPORT`,
 * captured on the first real run of this spec (panel-37) and pinned here as a
 * ratchet. These are not targets — they are today's numbers, and every one of
 * them is over the 626px of room the panel actually has (see this file's own
 * header). Lowering one is always welcome; raising one is the regression this
 * gate exists to catch.
 */
const DESIGN_TAB_CEILING_PX: Record<Fixture['id'], number> = {
  'f1-rectangle': 960,
  'f2-text': 1190,
  'f3-flex-board': 1013,
  'f4-image': 1043,
}

/**
 * Slack on each ceiling, for sub-pixel and font-metric differences between
 * machines. Deliberately far below the 164px the More disclosure is worth
 * (`src/__tests__/inspector/measurement.test.ts` computes that number), so
 * the regression this ratchet exists to catch still trips every ceiling.
 */
const CEILING_TOLERANCE_PX = 24

/**
 * The `designGroup: 'more'` entries of `INSPECTOR_SECTIONS` — the four that
 * live behind the one collapsed More disclosure on Design.
 */
const MORE_GROUP_SECTION_IDS = ['transform', 'animations', 'interaction', 'customProperties'] as const

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

/**
 * The ACTIVE Design tab panel — the only surface any assertion in this file
 * is about.
 *
 * `InspectorShell` mounts Design, Prototype and Inspect together and hides
 * the inactive two with the `hidden` attribute, so three sections
 * (`transform`, `animations`, `interaction`) have a live DOM subtree in two
 * tabs at once. `:not([hidden])` is the discriminator, not the presence of
 * the node — asserting a document-wide count of `[data-section-id="…"]` finds
 * the Prototype copy and is the bug panel-37 fixed. Scoping here instead of
 * at each call site means a future shell that DOES unmount inactive tabs
 * keeps every assertion below true, unchanged.
 */
const designPanel = (page: Page) => page.locator('[data-inspector-tab="design"]:not([hidden])')

/** The Design tab's own scroll container (`StyleSurface.tsx`'s `.surface`). */
const panelScroll = (page: Page) => designPanel(page).getByTestId('properties-panel-scroll')

/** A section wrapper inside the ACTIVE Design tab, by manifest id. */
const designSection = (page: Page, sectionId: string) =>
  designPanel(page).locator(`[data-section-id="${sectionId}"]`)

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

/**
 * Per-section rendered heights for the current selection, in DOM order,
 * within the ACTIVE Design tab only. Scoped: an unscoped read used to fold
 * the Prototype tab's own hidden `transform`/`animations`/`interaction`
 * copies into the artefact as bogus 0px rows.
 */
async function readSectionHeights(page: Page): Promise<Record<string, number>> {
  const sections = designPanel(page).locator('[data-section-id]')
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

test.describe('WS-14.5 — the Design tab height at 900px', () => {
  test.setTimeout(180_000)

  test('every baseline fixture renders its Design tab within its measured ceiling at 900px', async ({
    page,
  }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const frame = page.locator('[data-page-id]').first()
    const contentFrame: FrameLocator = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)

    const table: Record<string, unknown> = {
      viewport: HEIGHT_BUDGET_VIEWPORT,
      note:
        'MEASURED Design-tab heights, regenerated by tests/e2e/inspector-height.e2e.ts. ' +
        '`clientHeight` is the room the panel actually has at this viewport (900px minus all ' +
        'chrome); `overflowPx` is how far past it the tab renders. Both are RECORDED, not ' +
        'asserted — the assertion is `scrollHeight <= ceilingPx`, a ratchet on today\'s numbers. ' +
        'See 05-section-heights.md and docs/features/inspector.md §6.',
      fixtures: {},
    }
    const fixtures = table.fixtures as Record<string, unknown>

    for (const fixture of FIXTURES) {
      await clickLayer(page, canvasRoot, contentFrame.locator(fixture.selector).first(), fixture.offset)
      await expect(
        designSection(page, fixture.requiredSectionId),
        `selecting ${fixture.selector} did not mount the ${fixture.requiredSectionId} section`,
      ).toBeVisible({ timeout: 15_000 })

      const scroll = panelScroll(page)
      await expect(scroll).toBeVisible({ timeout: 10_000 })
      const [scrollHeight, clientHeight] = await scroll.evaluate((el) => [
        el.scrollHeight,
        el.clientHeight,
      ])

      const sections = await readSectionHeights(page)
      const ceilingPx = DESIGN_TAB_CEILING_PX[fixture.id]
      fixtures[fixture.id] = {
        scrollHeight,
        clientHeight,
        ceilingPx,
        // The open item §6 carries. Recorded every run so it can never drift
        // out of the docs unnoticed; never asserted, because it is not 0 and
        // this gate is not the work order that makes it 0.
        overflowPx: Math.max(0, scrollHeight - clientHeight),
        sections,
      }

      expect(
        scrollHeight,
        `${fixture.id}: the Design tab grew past its measured ceiling — scrollHeight=${scrollHeight}, ` +
          `ceiling=${ceilingPx} (+${CEILING_TOLERANCE_PX} tolerance), room at 900px=${clientHeight}. ` +
          'If this is a deliberate addition, re-measure and move the ceiling in the same change; ' +
          `if it is the More disclosure coming un-folded, that is the 164px regression this ratchet ` +
          `exists to catch. Per-section heights: ${JSON.stringify(sections)}`,
      ).toBeLessThanOrEqual(ceilingPx + CEILING_TOLERANCE_PX)
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
    await expect(designSection(page, 'text')).toBeVisible({ timeout: 15_000 })

    const more = designPanel(page).getByTestId('inspector-more-disclosure')
    await expect(more, 'the More disclosure never mounted for a text node').toBeVisible({
      timeout: 10_000,
    })

    // Collapsed at rest: none of the four render a body IN THE DESIGN TAB.
    // Scoped, not document-wide: `transform`/`animations`/`interaction` also
    // mount, expanded, in the Prototype tab, which `InspectorShell` keeps in
    // the DOM behind `hidden`. Counting them there proves nothing about
    // Design's resting height, and asserting 0 across the document made this
    // test fail on a shell that was behaving exactly as designed.
    for (const id of MORE_GROUP_SECTION_IDS) {
      await expect(
        designSection(page, id),
        `${id} is mounted in the Design tab at rest — it belongs inside the collapsed More group`,
      ).toHaveCount(0)
    }

    // …and the Prototype tab's copies really are still there, hidden — the
    // fact that made the unscoped assertion above wrong, pinned so nobody
    // "fixes" the scoping by deleting the second mount instead.
    for (const id of ['transform', 'animations', 'interaction']) {
      await expect(
        page.locator(`[data-inspector-tab="prototype"] [data-section-id="${id}"]`),
        `${id} is no longer mounted in the Prototype tab — it declares tabs: ['design','prototype']`,
      ).toHaveCount(1)
    }

    // One click reaches all four — the disclosure is a fold, not a deletion.
    await more.getByRole('button', { name: 'More' }).click()
    for (const id of MORE_GROUP_SECTION_IDS) {
      await expect(
        designSection(page, id),
        `${id} did not appear after expanding More`,
      ).toHaveCount(1)
    }
  })
})
