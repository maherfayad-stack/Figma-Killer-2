import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * Adding a design-system component to a studio board, and rendering one with
 * its own package CSS. Two defects, both of which only a real browser can see.
 *
 *   1. **Vendor CSS was annihilated by the publisher reset.** Every `alm.*` /
 *      `pkg.*` component on the board rendered as unstyled text. The classes
 *      and the 120 KB of package CSS were both present and correct — but the
 *      reset was emitted inside `@layer user-authored`, one cascade layer ABOVE
 *      `@layer vendor`, and layer order beats specificity outright. So
 *      `:where(*) { padding: 0 }` beat `.btn { padding: 12px 22px }` despite
 *      having zero specificity, which is the exact opposite of what `:where()`
 *      is for. A unit test cannot catch this: happy-dom does not resolve
 *      cascade layers, and every string assertion about the CSS passed while
 *      the button was invisible. Only `getComputedStyle` in a real engine
 *      distinguishes "the rule is in the document" from "the rule applies".
 *
 *   2. **Insert was refused outright.** Picking a component from the palette
 *      toasted "Studio cannot add a new element to imported code yet" and did
 *      nothing. It now writes the element AND its import into the `.tsx` and
 *      the board re-reads it, so what lands on the canvas is a real parsed node
 *      with a `rel:line:col` id — asserted here against the bytes on disk,
 *      because the tree updating is precisely what used to happen without the
 *      file ever changing.
 *
 * SAFETY — this spec WRITES, so it never points at real user data. The fixture
 * is created fresh under this RUN's THROWAWAY COPY of `studio-workspace/`
 * (`WORKSPACE_ROOT`) and removed afterwards; the tracked tree is never touched.
 * An OS temp directory — what this used to use — sits outside the root the
 * server resolved, and `resolveProjectDir`'s containment check 404s the board.
 *
 * The fixture is a DESIGN-SYSTEM-BACKED project: it carries a
 * `design-system/index.js` and imports it relatively, which is what makes
 * `componentSources` classify `<Button/>` as `{ kind: 'design-system' }` and
 * `moduleMapping` render it as `alm.Button` out of Studio's OWN vendored pack.
 * The retired npm would classify as `kind: 'package'` -> `pkg.*`, which at
 * Tier 0 draws a "promote this project" placeholder and nothing this spec
 * asserts would hold. Only the RESOLVED path matters, so the stub below does
 * not have to be the real design system — Studio never renders from it.
 */
const DS = '../design-system'

/**
 * Two components already in the source, so the render assertions have something
 * that came through the ordinary parse, and the insert has a real sibling to be
 * appended after.
 */
const FIXTURE_PAGE = `import { Button, Chip } from '../design-system'

export default function Home() {
  return (
    <div className="wrap">
      <Button variant="primary" label="Existing button" />
      <Chip label="Existing chip" />
    </div>
  )
}
`

/** The project's own copy of the design system. Only its RESOLVABILITY matters — see the spec doc. */
const DESIGN_SYSTEM_INDEX = `export function Button() { return null }
export function Chip() { return null }
`

let fixture: FixtureProject

const pagePath = (): string => path.join(fixture.dir, 'pages', 'Home.tsx')
const readPage = (): string => fs.readFileSync(pagePath(), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-design-system-insert', {
    'pages/Home.tsx': FIXTURE_PAGE,
    'design-system/index.js': DESIGN_SYSTEM_INDEX,
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

/**
 * Open the board on the fixture - safe to write because it lives in this
 * run's throwaway workspace copy.
 *
 * `openFixtureBoard` rather than a private `goto`: the canvas has no scroll
 * container, so where a frame LANDS is decided by a "center on open" pass that
 * races the arrival of the page documents it centres on. On a cold load the
 * board can settle pointed somewhere with no frame in it, and every assertion
 * about what the frame renders then fails for a reason that has nothing to do
 * with the component under test. The shared opener resets the view with the
 * product's own Ctrl+0 first.
 */
async function openStudioBoard(page: Page): Promise<FrameLocator> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(
    frame.locator(CANVAS_FRAME_IFRAME_SELECTOR),
    'the fixture frame never mounted a live canvas iframe after being panned into view',
  ).toBeVisible({ timeout: 60_000 })
  return frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
}

test.describe('design-system components on a studio board', () => {
  // A cold ts-morph parse on open, a source write, and a reload.
  test.setTimeout(180_000)

  test('package CSS actually applies — the reset must not outrank @layer vendor', async ({ page }) => {
    const contentFrame = await openStudioBoard(page)

    const button = contentFrame.locator('button.btn').first()
    await expect(button).toBeVisible({ timeout: 15_000 })

    const computed = await button.evaluate((el) => {
      const style = el.ownerDocument.defaultView!.getComputedStyle(el)
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        padding: style.padding,
        fontFamily: style.fontFamily,
      }
    })

    // The exact values come from the built-in design system's own
    // `.btn--primary` rule (Studio's vendored `dist/index.css`, injected into
    // every frame by `ProjectCssInjector` — not resolved against the project). Asserting them (rather than merely "not the
    // default") is what proves the VENDOR layer won, not just that something
    // did — a stray editor-chrome rule could otherwise satisfy a loose check.
    expect(computed.backgroundColor, 'the button has no fill — vendor CSS lost to the reset').not.toBe(
      'rgba(0, 0, 0, 0)',
    )
    expect(computed.color, 'the label kept the inherited colour — `:where(button) { color: inherit }` won').not.toBe(
      'rgb(0, 0, 0)',
    )
    expect(computed.padding, 'the button has no padding — `:where(*) { padding: 0 }` won').not.toBe('0px')
    expect(computed.fontFamily, 'the button kept the reset font — `:where(input, button) { font: inherit }` won').toContain(
      'Open Sans',
    )

    // The layer pre-declaration every canvas stylesheet repeats: `reset` must be
    // declared FIRST, which is what makes it lose to both layers above it.
    const layerOrder = await contentFrame
      .locator('#mc-classes')
      .evaluate((el) => (el.textContent ?? '').split('\n')[0])
    expect(layerOrder).toBe('@layer reset, vendor, user-authored;')
  })

  test('inserting a component from the picker writes the .tsx and comes back as a real node', async ({ page }) => {
    const contentFrame = await openStudioBoard(page)
    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)

    // The Assets panel replaced the full-screen inserter dialog. It is docked,
    // so it stays open after the click — the round trip is observed on the
    // canvas and on disk, below.
    await page.getByTestId('panel-rail-assets').click()
    const assets = page.getByTestId('assets-panel')
    await expect(assets).toBeVisible({ timeout: 10_000 })
    await assets.getByRole('searchbox', { name: 'Search assets' }).fill('Button')
    await assets.locator('[data-asset-id="alm.Button"]').first().click()

    // The write is what makes the board reload, so waiting for the new node in
    // the canvas is waiting for the whole round trip.
    const inserted = contentFrame.locator('[data-module-id="alm.Button"]').nth(1)
    await expect(inserted, 'the inserted component never reached the canvas').toBeVisible({ timeout: 60_000 })

    // It is a REAL parsed node — a source location, not a canvas-minted nanoid.
    const nodeId = await inserted.getAttribute('data-node-id')
    expect(nodeId, 'the inserted node is not source-derived').toMatch(/^pages\/Home\.tsx:\d+:\d+$/)

    // …and it renders through the design system, styled, not as bare text.
    await expect(inserted.locator('button.btn')).toBeVisible()

    // The bytes on disk are the actual claim. Everything the fixture already
    // had survives verbatim and the JSX gains one line; the import declaration
    // is untouched because `Button` was already imported — reusing it rather
    // than writing a second declaration is the assertion at the end.
    expect(readPage()).toBe(
      `import { Button, Chip } from '../design-system'

export default function Home() {
  return (
    <div className="wrap">
      <Button variant="primary" label="Existing button" />
      <Chip label="Existing chip" />
      <Button dir="ltr" label="Button" size="default" variant="primary" />
    </div>
  )
}
`,
    )
    expect(readPage(), 'the import was duplicated instead of reused').not.toContain(`\nimport { Button } from '${DS}'`)
  })
})
