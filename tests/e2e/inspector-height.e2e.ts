import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WORKSPACE_ROOT } from './helpers/constants'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

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
 * ## The budget, in one place (panel-39)
 *
 * This gate asserts ONE budget, and it is not a literal: **the Design tab
 * must render inside the room the docked panel actually has at a 900px
 * window** — `clientHeight`, read at runtime from the same element whose
 * `scrollHeight` is being judged. Reclaiming chrome therefore moves the
 * budget by itself; nobody has to remember to edit a number in two places.
 *
 * It replaced four hand-pinned per-fixture ceilings (`DESIGN_TAB_CEILING_PX`
 * — 960 / 1190 / 1013 / 1043, the numbers panel-37's first real run
 * measured). Those were a ratchet, not a budget: they encoded today's
 * overflow as the target, so a panel that got 300px better still "passed"
 * with the same green tick as one that got 1px worse.
 *
 * The room at a 900px window was **626px** when panel-37 measured it
 * (274px of chrome: 36 admin top bar + 36 `PanelHeader` + 47 tab strip +
 * **88 `FrameSizePanel`** + 67 ClassPicker — that band was mislabelled "node
 * header (title + breadcrumb)" in the first artefact; the node title lives
 * inside `PanelHeader`'s own 36px). panel-39 moved `FrameSizePanel` to the
 * nothing-selected state it describes and trimmed the tab strip; panel-41
 * folded the selector pills into ClassPicker's own row (67 → 39). The room
 * is now **746px** and the chrome **154px**.
 *
 * ## The budget is strict, with exactly one named exception
 *
 * panel-39's blanket `POPULATED_SECTION_OVERFLOW_PX = 210` is gone: three of
 * the four fixtures now fit the room outright, so a 210px slack on all four
 * would hide a 200px regression on any of them. Measured after P2-G (the
 * Component section), at 1400x900 (`contentHeight`, not `scrollHeight` —
 * see the assertion's own comment for why the clamped one cannot show
 * headroom):
 *
 *   | Fixture | content | room | over | was (P2-F) |
 *   |---|---:|---:|---:|---:|
 *   | F1 rectangle | 598 | 746 | **0** (148 spare) | 598 |
 *   | F2 text | 769 | 746 | **23** | 772 (26 over) |
 *   | F3 flex board | 715 | 746 | **0** (31 spare) | 715 |
 *   | F4 image | 595 | 746 | **0** (151 spare) | 601 |
 *   | F5 instance | 256 | 746 | **0** (490 spare) | no props at all |
 *
 * P2-H re-measured all five: F1–F4 unchanged, F5 276 → 256 — the notice
 * under its Component section traded fluid `--space-4xl`/`-5xl` padding for
 * the frozen `--inspector-space-xl` (UX-27).
 *
 * P2-G added F5, a local component instance: before it, an instance with no
 * writable class showed the "no writable style" notice and nothing else, so
 * its props had no height to measure. Its Component section is now one 32px
 * title row and its three prop rows (137px with the hairline). F2 and F4 lost
 * 3px per stacked prop row: `ControlRow`'s gaps read the frozen inspector
 * scale inside the panel (UX-10) instead of the admin's fluid one.
 *
 * P2-F SPENT height on segregation — a 12px section gap instead of 8
 * (`--inspector-section-gap`, owner decision OD-4), a real 32px header, 8px
 * of bottom padding and a hairline on the Module block — and paid for it by
 * merging Shadow + Blur into one Effects section (-45) and tightening the
 * rows inside Text and Measures to 4px (-12, -8). Every fixture came out
 * shorter than it went in.
 *
 * The one exception is **F2**, and `TEXT_LAYER_OVERFLOW_PX` states its size.
 * Its cause, with numbers: a text layer's Design tab carries 483px of values
 * the user's source actually sets — Text 177 (Figma's own four typography
 * rows), Measures 114, Fill 65, Layer 32, and a 92px Module block holding
 * the node's own `text` content — plus 165px of five one-row collapsed
 * sections (Layout, Stroke, Effects, Export, More), 108px of gaps and 16px of
 * container padding. Nothing there is pre-drawn; closing the last 23px means
 * collapsing a section that has values in it, or giving back the section gap
 * the owner asked for. See `docs/features/inspector.md` §6.
 *
 * Every other fixture is asserted STRICTLY against the room. Adding a second
 * exception means naming its cause in §6, in the same change.
 *
 * ## Scoping — the panel-37 defect, still load-bearing
 *
 * This file used to ask the DOCUMENT for `[data-section-id="transform"]` and
 * expect 0. `InspectorShell` mounts all three tab panels and `hidden`s the
 * inactive two (a P1/P2 decision — see `InspectorShell.tsx`'s own doc for
 * why it is deliberate), and `transform`/`animations`/`interaction` declare
 * `tabs: ['design','prototype']`, so the Prototype tab's hidden copy
 * satisfied the locator. Every query here is scoped to the ACTIVE Design
 * panel via `designPanel()`.
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
 * throwaway project created directly INSIDE the workspace root (the one
 * shape `resolveProjectDir`'s containment check accepts; an OS temp dir
 * throws `ProjectDirOutsideWorkspaceError`) under a `ws145-e2e-` prefix,
 * removed in `afterAll`. That root is `WORKSPACE_ROOT` — this run's throwaway
 * COPY of `studio-workspace/`, not the tracked tree — which is also why this
 * spec no longer leaves `__canonical-fixture/.studio/meta.json` modified and a
 * `.studio/framework.json` behind it (`panel-37`'s landmine). It reproduces the same F1/F2/F3 shapes as that
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

const EDITOR_LAYOUT_STORAGE_KEY = 'studio-editor-layout-v2'
const FIXTURE_PROJECT_NAME = `ws145-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** The viewport §6's budget is stated at, and the whole point of this file. */
const HEIGHT_BUDGET_VIEWPORT = { width: 1400, height: 900 } as const

/**
 * The ONE exception to the strict budget, and it belongs to ONE fixture —
 * see this file's header for the per-section numbers behind it. Measured
 * after P2-G the F2 text node is 23px over; this is that number with the
 * same 24px of room panel-41 left for the sub-pixel and font-metric
 * differences between machines (it was 50 against 26 after P2-F, 60 against
 * 36 before).
 *
 * It is deliberately far below the 164px the More disclosure is worth
 * (`src/__tests__/inspector/measurement.test.ts` computes that number), the
 * 167px the collapsed Layout section is worth, and the 122px the Module
 * block's Law-3 fold is worth on an image, so un-folding any of them still
 * trips this gate — on F2 as well as on the three strict fixtures.
 */
const TEXT_LAYER_OVERFLOW_PX = 47

/** The fixture `TEXT_LAYER_OVERFLOW_PX` applies to, and the only one. */
const OVERFLOW_EXCEPTION_FIXTURE_ID = 'f2-text'

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

.btn {
  /* F5 — a local component instance (P2-G). Sized so the click lands on the
     instance's own rendered box. */
  display: inline-block;
  margin-top: 40px;
  padding: 12px 24px;
  border: 0;
  border-radius: 8px;
  background: #3949ab;
  color: #ffffff;
  font-size: 16px;
}
`

/**
 * F5 — a LOCAL component the page instantiates (P2-G). Three declared props,
 * one of them a union (a dropdown), one named long enough (`ariaLabel`) that
 * the 68px label column used to ellipsise it (UX-10).
 */
const FIXTURE_COMPONENT = `interface FixtureButtonProps {
  label: string
  variant?: 'primary' | 'ghost'
  ariaLabel?: string
}

export function FixtureButton({ label, variant, ariaLabel }: FixtureButtonProps) {
  return (
    <button className="btn" data-variant={variant} aria-label={ariaLabel}>
      {label}
    </button>
  )
}
`

/** A real, self-contained raster the fixture page can point an <img> at. */
const FIXTURE_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <rect width="240" height="160" fill="#8e24aa" />
  <circle cx="120" cy="80" r="48" fill="#ffd54f" />
</svg>
`

const FIXTURE_PAGE = `import './Home.css'
import { FixtureButton } from '../components/FixtureButton'

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
      <FixtureButton label="Get started" variant="primary" />
    </div>
  )
}
`

let fixtureDir: string

test.beforeAll(() => {
  fixtureDir = path.join(WORKSPACE_ROOT, FIXTURE_PROJECT_NAME)
  fs.mkdirSync(path.join(fixtureDir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'Home.css'), FIXTURE_CSS, 'utf8')
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'Home.tsx'), FIXTURE_PAGE, 'utf8')
  fs.writeFileSync(path.join(fixtureDir, 'pages', 'fixture.svg'), FIXTURE_IMAGE_SVG, 'utf8')
  fs.mkdirSync(path.join(fixtureDir, 'components'), { recursive: true })
  fs.writeFileSync(path.join(fixtureDir, 'components', 'FixtureButton.tsx'), FIXTURE_COMPONENT, 'utf8')
})

test.afterAll(() => {
  // Guarded by the `ws145-e2e-` prefix this spec itself generated — never a
  // bare rm of whatever `fixtureDir` happens to hold.
  if (fixtureDir && path.basename(fixtureDir).startsWith('ws145-e2e-')) {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    } catch (err) {
      // On Windows the still-running dev server's watcher holds a handle on
      // the open project, so the rm answers EPERM until the stack shuts down.
      // Harmless: `WORKSPACE_ROOT` is this run's throwaway copy, and
      // `scripts/e2e-dev.ts` wipes it before the next run.
      console.warn(
        '[inspector-height.e2e] fixture cleanup deferred to the next run:',
        err instanceof Error ? err.message : err,
      )
    }
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
  await expect(visibleCanvasIframe(page).first()).toBeVisible({ timeout: 20_000 })
  // A live board frame mounts the portal fallback AND a hidden bridge iframe
  // until the bridge is ready, and in a fixture whose dev server cannot boot it
  // never is: two `iframe[title^="Canvas frame"]` for good. Wait for the ONE
  // displayed canvas iframe (`helpers/canvasIframe.ts`) before resolving into it.
  await expect(
    visibleCanvasIframe(page.locator('[data-page-id]').first()),
    'the first board frame never settled to one canvas iframe',
  ).toHaveCount(1, { timeout: 30_000 })
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
 * Select a layer through its Layers-panel row. A click on a component's
 * rendered content lands on the element INSIDE the instance (its own
 * `<button>`), not on the instance; the row names the instance itself and is
 * the deterministic way to select it. The caller clicks the content first,
 * which is what reveals the row in a collapsed tree.
 */
async function selectLayerRow(page: Page, label: string): Promise<void> {
  const row = page.getByRole('treeitem', { name: label, exact: true })
  await expect(row, `no Layers row named ${label}`).toBeVisible({ timeout: 15_000 })
  await row.click()
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
  id: 'f1-rectangle' | 'f2-text' | 'f3-flex-board' | 'f4-image' | 'f5-instance'
  selector: string
  /** Click offset from the layer's top-left, for layers whose centre is covered. */
  offset?: { x: number; y: number }
  /** A section this selection MUST mount, so a mis-click fails loudly. */
  requiredSectionId: string
  /**
   * After the canvas click, select the Layers row with this label — the
   * instance enclosing what was clicked (`selectLayerRow`). Only F5 sets it.
   */
  layerRow?: string
  /**
   * A test id that appears only once the selection has settled. The Component
   * section's rows come from the project's component catalog, fetched after
   * the section mounts: measured before it lands, F5 shows the call site's
   * two props instead of the three the component declares.
   */
  settledTestId?: string
}

const FIXTURES: ReadonlyArray<Fixture> = [
  { id: 'f1-rectangle', selector: '.rectangle', requiredSectionId: 'measures' },
  { id: 'f2-text', selector: '.text-layer', requiredSectionId: 'text' },
  { id: 'f3-flex-board', selector: '.board', offset: { x: 8, y: 8 }, requiredSectionId: 'layout' },
  { id: 'f4-image', selector: '.image-layer', requiredSectionId: 'fill' },
  { id: 'f5-instance', selector: '.btn', requiredSectionId: 'component', layerRow: 'FixtureButton', settledTestId: 'instance-call-site-prop-ariaLabel' },
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

  test('every baseline fixture renders its Design tab within the room the panel has at 900px', async ({
    page,
  }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const frame = page.locator('[data-page-id]').first()
    const contentFrame: FrameLocator = canvasContentFrame(frame)

    const table: Record<string, unknown> = {
      viewport: HEIGHT_BUDGET_VIEWPORT,
      note:
        'MEASURED Design-tab heights, regenerated by tests/e2e/inspector-height.e2e.ts. ' +
        'THE BUDGET is `clientHeight` — the room the panel actually has at this viewport, ' +
        'i.e. 900px minus all chrome — read at runtime, not a literal. `contentHeight` is ' +
        'what the tab renders (`scrollHeight` clamps to the room and so cannot show headroom; ' +
        'this does). `overflowPx` is `contentHeight - clientHeight`, and the gate asserts it ' +
        'is ZERO for every fixture but one: the F2 text node, whose cause is named in ' +
        '05-section-heights.md and docs/features/inspector.md §6.',
      budget: { source: 'clientHeight of the Design tab scroll container at 900px' },
      overflowException: {
        fixture: OVERFLOW_EXCEPTION_FIXTURE_ID,
        allowancePx: TEXT_LAYER_OVERFLOW_PX,
      },
      fixtures: {},
    }
    const fixtures = table.fixtures as Record<string, unknown>

    for (const fixture of FIXTURES) {
      await clickLayer(page, canvasRoot, contentFrame.locator(fixture.selector).first(), fixture.offset)
      if (fixture.layerRow) await selectLayerRow(page, fixture.layerRow)
      await expect(
        designSection(page, fixture.requiredSectionId),
        `selecting ${fixture.selector} did not mount the ${fixture.requiredSectionId} section`,
      ).toBeVisible({ timeout: 15_000 })
      if (fixture.settledTestId) {
        await expect(
          designPanel(page).getByTestId(fixture.settledTestId),
          `${fixture.id} never settled — ${fixture.settledTestId} did not appear`,
        ).toBeVisible({ timeout: 15_000 })
      }

      const scroll = panelScroll(page)
      await expect(scroll).toBeVisible({ timeout: 10_000 })
      // `scrollHeight` is `max(clientHeight, content)` — it reports the room
      // itself for a tab that FITS, so it can neither show headroom nor catch
      // a fitting fixture growing back toward the limit. `contentHeight` is
      // the flow's own box plus the scroll container's own padding: the
      // honest "how tall is this tab" number, and what the budget is against.
      const { scrollHeight, clientHeight, contentHeight } = await scroll.evaluate((el) => {
        const style = getComputedStyle(el)
        const flow = el.firstElementChild
        const inner = flow ? flow.getBoundingClientRect().height : 0
        return {
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          contentHeight: Math.round(
            inner + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
          ),
        }
      })

      const sections = await readSectionHeights(page)
      fixtures[fixture.id] = {
        contentHeight,
        clientHeight,
        scrollHeight,
        overflowPx: Math.max(0, contentHeight - clientHeight),
        headroomPx: Math.max(0, clientHeight - contentHeight),
        sections,
      }

      // Strict for every fixture but the one declared exception. A second
      // exception is a new cause, and a new cause belongs in
      // `docs/features/inspector.md` §6 before it belongs here.
      const allowance =
        fixture.id === OVERFLOW_EXCEPTION_FIXTURE_ID ? TEXT_LAYER_OVERFLOW_PX : 0
      expect(
        contentHeight,
        `${fixture.id}: the Design tab is past its budget — contentHeight=${contentHeight}, ` +
          `room at 900px=${clientHeight}, allowance=${allowance}. The budget is the room ` +
          'itself, asserted strictly; only the F2 text node has a declared allowance, and its ' +
          'cause is named in docs/features/inspector.md §6. Closing an overflow here means ' +
          'folding something that is pre-drawn, not widening this number. Per-section ' +
          `heights: ${JSON.stringify(sections)}`,
      ).toBeLessThanOrEqual(clientHeight + allowance)
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
    const contentFrame = canvasContentFrame(frame)

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

  /**
   * The STRUCTURAL half of the budget (panel-39). The numeric assertion above
   * is strict now, but a height number still cannot say WHICH fold was
   * deleted when it goes red — so the folds the budget rests on are pinned as
   * structure as well: the four Studio extras stay folded (the test above),
   * the Module block folds the props the source does not set (below, worth a
   * measured 122px on the image fixture), and the Layout section stays one
   * row until a layout exists (this one, worth a measured 167px on every
   * selection that is not itself a flex/grid container).
   */
  test('Layout is one row until a layout exists, and the full body is one click away', async ({
    page,
  }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const frame = page.locator('[data-page-id]').first()
    const contentFrame = canvasContentFrame(frame)

    // A plain text node: no `display` at all, so no layout exists.
    await clickLayer(page, canvasRoot, contentFrame.locator('.text-layer').first())
    await expect(designSection(page, 'layout')).toBeVisible({ timeout: 15_000 })

    const layout = designSection(page, 'layout')
    await expect(
      layout.getByTestId('inspector-layout-section'),
      'the Layout body is mounted on a node with no layout — that is the 167px this fold buys back',
    ).toHaveCount(0)
    const addLayout = layout.getByRole('button', { name: 'Add auto layout' })
    await expect(addLayout, 'the collapsed Layout header has no "Add auto layout" +').toBeVisible()

    // …and the body — padding, margin, clip content — is still one click away.
    // `exact` — the collapsed header also carries an "Add auto layout"
    // button, which a substring match on "Layout" would resolve to as well.
    await layout.getByRole('button', { name: 'Layout', exact: true }).click()
    await expect(
      layout.getByTestId('inspector-layout-section'),
      'expanding Layout did not disclose its body — the fold must never be a deletion',
    ).toHaveCount(1)

    // The flex board is a real container: its body is open at rest, no click.
    await clickLayer(page, canvasRoot, contentFrame.locator('.board').first(), { x: 8, y: 8 })
    await expect(
      designSection(page, 'layout').getByTestId('inspector-layout-section'),
      'a flex container must render its Layout body at rest',
    ).toBeVisible({ timeout: 15_000 })
  })

  /**
   * The Module block's Law-3 fold (panel-41), against a real parsed file
   * rather than a hand-built prop bag — which is the whole point: the
   * partition asks what the USER'S SOURCE sets, and only a real parse can
   * produce a node whose `props` carry `src` but not `loading`.
   *
   * `<img className="image-layer" src="./fixture.svg" alt="Fixture" />` sets
   * `src`; `loading`, `fetchPriority` and `decoding` are schema defaults the
   * JSX never wrote. Worth a measured 122px on this fixture (three rows, two
   * gaps, and the row a separate "More properties" disclosure would have
   * cost).
   */
  test('the Module block folds the props the source does not set, and one click reaches them', async ({
    page,
  }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const frame = page.locator('[data-page-id]').first()
    const contentFrame = canvasContentFrame(frame)

    await clickLayer(page, canvasRoot, contentFrame.locator('.image-layer').first())
    const moduleBlock = designSection(page, 'module')
    await expect(moduleBlock).toBeVisible({ timeout: 15_000 })

    // The source sets `src`, so the image picker is resident.
    await expect(
      moduleBlock.getByTestId('image-source-src'),
      'the image the source DOES set is not at rest — the fold must never hide a value',
    ).toBeVisible()

    for (const key of ['loading', 'fetchPriority', 'decoding']) {
      await expect(
        moduleBlock.getByTestId(`property-control-${key}`),
        `${key} is pre-drawn at rest — the JSX never wrote it (Law 3)`,
      ).toHaveCount(0)
    }

    // One click, same test ids — a fold, not a deletion.
    await moduleBlock.getByTestId('module-more-properties-toggle').click()
    for (const key of ['loading', 'fetchPriority', 'decoding']) {
      await expect(
        moduleBlock.getByTestId(`property-control-${key}`),
        `${key} did not appear after opening the Module block's fold`,
      ).toHaveCount(1)
    }
  })

  /**
   * P2-G — the Component section, in a real browser. The height is F5 above;
   * this is the shape: an instance's props are reachable at all (before P2-G
   * the "no writable style" notice replaced every section, the props with
   * them), the section is one title row naming the instance, the prop label
   * column fits `ariaLabel`, a typed value that Escape abandons writes
   * nothing, and a multi-selection hides the section rather than showing one
   * instance's values.
   */
  test('an instance shows its props under one title row, and a multi-selection hides them', async ({ page }) => {
    await page.setViewportSize({ ...HEIGHT_BUDGET_VIEWPORT })
    const canvasRoot = await openStudioBoard(page, fixtureDir)
    const contentFrame = canvasContentFrame(page.locator('[data-page-id]').first())

    await clickLayer(page, canvasRoot, contentFrame.locator('.btn').first())
    await selectLayerRow(page, 'FixtureButton')
    const component = designSection(page, 'component')
    await expect(component, 'an instance with no writable class shows no props').toBeVisible({ timeout: 15_000 })
    await expect(component.getByTestId('instance-call-site-prop-ariaLabel')).toBeVisible({ timeout: 15_000 })

    // One title row: the instance's own name and source, Detach and Swap beside it.
    await expect(component.getByText('FixtureButton', { exact: true })).toHaveCount(1)
    await expect(component.getByTestId('instance-source-badge')).toHaveText('Local')
    await expect(component.getByRole('button', { name: 'Detach instance' })).toBeVisible()
    await expect(component.getByRole('button', { name: 'Swap instance' })).toBeVisible()

    // UX-10 — the 96px label column holds `ariaLabel` without ellipsis.
    const label = component.getByTestId('instance-call-site-prop-ariaLabel').locator('label').first()
    const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(clipped, 'the prop label column still ellipsises "ariaLabel"').toBe(false)

    // UX-16 — Escape abandons a typed value and writes nothing.
    const field = component.getByTestId('instance-call-site-prop-label').locator('input')
    await field.click()
    await field.fill('Typed, then abandoned')
    await page.keyboard.press('Escape')
    await expect(field).toHaveValue('Get started')
    expect(fs.readFileSync(path.join(fixtureDir, 'pages', 'Home.tsx'), 'utf8')).toContain('label="Get started"')

    // UX-14 — a second layer joins the selection: the section goes away.
    await page.getByRole('treeitem', { name: 'Image', exact: true }).click({ modifiers: ['Shift'] })
    await expect(component, "a multi-selection still shows one instance's props").toHaveCount(0)
  })
})
