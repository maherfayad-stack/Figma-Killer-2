import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * CT-5 - text and effect styles, in a real browser against real files.
 *
 * The claims a unit test cannot make:
 *
 *   1. **Apply changes what the canvas draws.** Picking `.heading` for a layer
 *      that has its own inline `fontSize` adds the class AND strips the inline
 *      values the class now owns - the computed font size is the class's, not
 *      the stale inline one - and one Cmd+Z puts the `.tsx` back byte for byte.
 *   2. **Create writes the rule and applies it in one undo step.** The layer
 *      looks exactly as before (same computed size), `Home.css` gains the rule,
 *      and Cmd+Z restores BOTH files.
 *   3. **Detach hands the values back inline.** The class comes off, the layer
 *      keeps its size.
 *   4. **Effects follow the same path.** A shadow style applied to a layer with
 *      no shadow shows up as a computed `box-shadow`.
 *
 * SAFETY - this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const HOME = 'pages/Home.tsx'
const HOME_CSS = 'pages/Home.css'

const HOME_PAGE = `import './Home.css'

export default function Home() {
  return (
    <main>
      <h1 style={{ fontSize: 40, fontWeight: 700 }}>Styles</h1>
      <div className="panel">Panel</div>
    </main>
  )
}
`

const HOME_STYLESHEET = `.heading {
  font-size: 32px;
  font-weight: 600;
  line-height: 1.2;
}

.panel {
  padding: 8px;
}

.soft {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}
`

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-text-styles', {
    [HOME]: HOME_PAGE,
    [HOME_CSS]: HOME_STYLESHEET,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openHome(page: Page) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = await frameForPage(page, canvasRoot, 'home')
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, content: canvasContentFrame(frame) }
}

/** Ctrl-click `target`, then wait for the inspector section that proves it is the selection (the production bundle has no store to poll). */
async function select(page: Page, canvasRoot: Locator, target: Locator, sectionTrigger: string) {
  await panIntoView(page, canvasRoot, target, 80)
  await selectInFrame(page, target)
  await expect(page.getByTestId(sectionTrigger), 'the click never selected the layer').toBeVisible({ timeout: 15_000 })
}

const style = (target: Locator, property: string): Promise<string> =>
  target.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property)

test.describe('CT-5 - text and effect styles', () => {
  test.setTimeout(240_000)

  test('apply, undo, create, detach on a heading; an effect style on a panel', async ({ page }) => {
    const { canvasRoot, content } = await openHome(page)
    const h1Id = sourceNodeId(HOME_PAGE, HOME, 'h1')
    const heading = content.locator(`[data-node-id="${h1Id}"]`).first()
    await select(page, canvasRoot, heading, 'text-styles-trigger')
    expect(await style(heading, 'font-size')).toBe('40px')

    // ── 1. apply ──────────────────────────────────────────────────────────────
    await page.getByTestId('text-styles-trigger').click()
    await page.getByTestId('style-option-heading').click()
    await expect.poll(() => read(HOME), { message: 'applying a style never reached Home.tsx', timeout: 30_000 }).toContain('className="heading"')
    const applied = read(HOME)
    expect(applied, 'the inline values the class owns stayed on the element').not.toContain('fontSize')
    expect(applied).not.toContain('fontWeight')
    expect(read(HOME_CSS), 'applying a style must not touch the stylesheet').toBe(HOME_STYLESHEET)
    await expect.poll(() => style(content.locator(`[data-node-id="${h1Id}"]`).first(), 'font-size'), {
      message: 'the canvas still draws the inline size',
      timeout: 30_000,
    }).toBe('32px')
    await expect(page.getByTestId('text-style-applied')).toContainText('heading')

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { message: 'Cmd+Z did not restore Home.tsx byte for byte', timeout: 30_000 }).toBe(HOME_PAGE)
    await expect.poll(() => style(content.locator(`[data-node-id="${h1Id}"]`).first(), 'font-size'), { timeout: 30_000 }).toBe('40px')

    // ── 2. create from selection ─────────────────────────────────────────────
    await select(page, canvasRoot, content.locator(`[data-node-id="${h1Id}"]`).first(), 'text-styles-trigger')
    await page.getByTestId('text-styles-trigger').click()
    await page.getByTestId('text-style-create').click()
    await page.getByTestId('text-style-name').fill('Hero')
    await page.getByTestId('text-style-name-submit').click()
    await expect.poll(() => read(HOME_CSS), { message: 'create never wrote the rule', timeout: 30_000 }).toContain('.text-hero')
    expect(read(HOME_CSS)).toContain('font-size: 40px')
    expect(read(HOME_CSS)).toContain('font-weight: 700')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toContain('className="text-hero"')
    expect(read(HOME)).not.toContain('fontSize')
    // Same look as before the style existed.
    await expect
      .poll(() => style(content.locator(`[data-node-id="${h1Id}"]`).first(), 'font-size'), { timeout: 30_000 })
      .toBe('40px')
    await expect(page.getByTestId('text-style-applied')).toContainText('text-hero')

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
    await expect.poll(() => read(HOME_CSS), { message: 'one Cmd+Z did not take the new rule back out of the stylesheet', timeout: 30_000 }).toBe(HOME_STYLESHEET)

    // ── 3. apply then detach ────────────────────────────────────────────────
    await select(page, canvasRoot, content.locator(`[data-node-id="${h1Id}"]`).first(), 'text-styles-trigger')
    await page.getByTestId('text-styles-trigger').click()
    await page.getByTestId('style-option-heading').click()
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toContain('className="heading"')
    await page.getByTestId('text-style-detach-chip').click()
    await expect.poll(() => read(HOME), { message: 'detach left the class on the element', timeout: 30_000 }).not.toContain('className="heading"')
    expect(read(HOME)).toMatch(/fontSize: ['"]32px['"]/)
    await expect
      .poll(() => style(content.locator(`[data-node-id="${h1Id}"]`).first(), 'font-size'), { timeout: 30_000 })
      .toBe('32px')
    await expect(page.getByTestId('text-style-applied')).toHaveCount(0)

    // ── 4. an effect style ──────────────────────────────────────────────────
    const panelId = sourceNodeId(read(HOME), HOME, 'div')
    const panel = content.locator(`[data-node-id="${panelId}"]`).first()
    await select(page, canvasRoot, panel, 'effect-styles-trigger')
    expect(await style(panel, 'box-shadow')).toBe('none')
    await page.getByTestId('effect-styles-trigger').click()
    await page.getByTestId('style-option-soft').click()
    await expect
      .poll(() => style(content.locator(`[data-node-id="${sourceNodeId(read(HOME), HOME, 'div')}"]`).first(), 'box-shadow'), {
        message: 'the shadow style never reached the canvas',
        timeout: 30_000,
      })
      .not.toBe('none')
    expect(read(HOME)).toContain('className="panel soft"')
    await expect(page.getByTestId('effect-style-applied')).toContainText('soft')
    await page.screenshot({ path: test.info().outputPath('effect-style.png') })
  })
})
