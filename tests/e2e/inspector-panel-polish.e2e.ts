import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WORKSPACE_ROOT } from './helpers/constants'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * P2-H — panel polish, measured in a real browser (UX-11, UX-20, UX-21,
 * UX-25).
 *
 * Every fact here is a COMPUTED style or a laid-out rect, which is exactly
 * what happy-dom cannot produce: it applies no `:hover`, no `:focus-visible`
 * and no layout. The static half — the tokens and rules these computed values
 * come from — is `src/__tests__/inspector/measurement.test.ts` ("P2-H") and
 * `src/admin/pages/site/ui/Tree/__tests__/treeRowStates.test.ts`.
 *
 *   1. A hovered inspector field is LIGHTER than a resting one, in both
 *      themes. It used to paint `--overlay-10` over the black docked panel,
 *      i.e. darker than the #212426 it rests at.
 *   2. A Layers row focused from the keyboard draws a ring; the same row
 *      focused by a mouse click does not.
 *   3. The selected Layers row and a hovered Layers row paint different
 *      fills, and the selected one keeps its fill under the pointer.
 *   4. A node-level notice sits on the panel's 12px gutter instead of
 *      running edge to edge.
 *
 * Fixture: a throwaway project authored under this run's workspace root
 * (never `studio-workspace/test4`, which is user data), removed in afterAll.
 */

const EDITOR_LAYOUT_STORAGE_KEY = 'studio-editor-layout-v2'
const EDITOR_PREFS_KEY = 'studio-editor-prefs'
const FIXTURE_PREFIX = 'p2h-polish-e2e-'
const FIXTURE_PROJECT_NAME = `${FIXTURE_PREFIX}${Date.now().toString(36)}`

/** The panel gutter every inset block lines up on (`--inspector-pad-x`). */
const PANEL_GUTTER_PX = 12

const FIXTURE_CSS = `.page {
  width: 720px;
  padding: 40px;
}

.rectangle {
  width: 240px;
  height: 120px;
  margin-bottom: 32px;
  background: #1e88e5;
}

.caption {
  width: 300px;
  margin: 0 0 32px;
  font-size: 20px;
  color: #000000;
}

.item {
  height: 32px;
  font-size: 16px;
}
`

const FIXTURE_PAGE = `import './Home.css'

const ITEMS = ['First row', 'Second row']

export default function Home() {
  return (
    <div className="page">
      <div className="rectangle" />
      <p className="caption">Polish</p>
      <ul>
        {ITEMS.map((item) => (
          <li key={item} className="item">{item}</li>
        ))}
      </ul>
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
})

test.afterAll(() => {
  if (!fixtureDir || !path.basename(fixtureDir).startsWith(FIXTURE_PREFIX)) return
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  } catch (err) {
    // Windows: the still-running dev server's watcher holds the project open.
    // `WORKSPACE_ROOT` is this run's throwaway copy, wiped before the next run.
    console.warn('[inspector-panel-polish.e2e] fixture cleanup deferred:', err instanceof Error ? err.message : err)
  }
})

async function openBoard(page: Page, theme: 'dark' | 'light'): Promise<{ canvasRoot: Locator; frame: FrameLocator }> {
  await page.addInitScript(
    ({ dir, layoutKey, prefsKey, prefs }) => {
      window.localStorage.setItem('studio:studio:dir', dir)
      window.localStorage.setItem('studio:studio', '1')
      window.localStorage.removeItem(layoutKey)
      window.localStorage.setItem(prefsKey, prefs)
    },
    {
      dir: fixtureDir,
      layoutKey: EDITOR_LAYOUT_STORAGE_KEY,
      prefsKey: EDITOR_PREFS_KEY,
      // Autosave off: nothing in this spec should write the fixture.
      prefs: JSON.stringify({ theme, autoSave: false }),
    },
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/admin/site?studio')
  const canvasRoot = page.getByTestId('canvas-root')
  await expect(canvasRoot).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`html[data-editor-theme="${theme}"]`)).toHaveCount(1)
  // A live frame mounts beside the fallback frame (hidden) until its bridge is
  // ready: wait for the one displayed canvas iframe (`helpers/canvasIframe.ts`).
  await expect(
    visibleCanvasIframe(page.locator('[data-page-id]').first()),
    'the board frame never settled to one canvas iframe',
  ).toHaveCount(1, { timeout: 30_000 })
  const frame = canvasContentFrame(page.locator('[data-page-id]').first())
  return { canvasRoot, frame }
}

/** Pan the board until `target` sits near the canvas centre. */
async function panIntoView(page: Page, canvasRoot: Locator, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [rootBox, targetBox] = await Promise.all([canvasRoot.boundingBox(), target.boundingBox()])
    if (!rootBox || !targetBox) throw new Error('panIntoView: missing bounding box')
    const cx = rootBox.x + rootBox.width / 2
    const cy = rootBox.y + rootBox.height / 2
    const dx = targetBox.x + targetBox.width / 2 - cx
    const dy = targetBox.y + targetBox.height / 2 - cy
    if (Math.abs(dx) <= 40 && Math.abs(dy) <= 40) return
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(dx, dy)
    await page.waitForTimeout(150)
  }
  throw new Error('panIntoView: the target never reached the canvas centre')
}

/** Select a layer by clicking it on the canvas; returns its node id. */
async function selectOnCanvas(page: Page, canvasRoot: Locator, target: Locator): Promise<string> {
  await expect(target).toBeVisible({ timeout: 15_000 })
  await panIntoView(page, canvasRoot, target)
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + Math.min(8, box!.height / 2))
  const id = await target.getAttribute('data-node-id')
  expect(id, 'the canvas element carries no data-node-id').toBeTruthy()
  return id!
}

const designPanel = (page: Page) => page.locator('[data-inspector-tab="design"]:not([hidden])')
const layerRow = (page: Page, nodeId: string) => page.getByTestId(`dom-tree-item-${nodeId}`)

/** WCAG relative luminance of a computed `rgb()/rgba()` over `under`. */
function luminance(css: string, under: readonly [number, number, number]): number {
  const parts = css.match(/[\d.]+/g)?.map(Number) ?? []
  const [r, g, b, a = 1] = parts
  const mix = [r, g, b].map((c, i) => c * a + under[i] * (1 - a))
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(mix[0]) + 0.7152 * lin(mix[1]) + 0.0722 * lin(mix[2])
}

/** The painted fill of a field: its own, or the nearest ancestor's (affix wrapper). */
async function fieldFill(field: Locator): Promise<string> {
  return field.evaluate((el) => {
    let node: Element | null = el
    for (let depth = 0; node && depth < 4; depth += 1) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg && bg !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return bg
      node = node.parentElement
    }
    return 'transparent'
  })
}

async function panelBackground(page: Page): Promise<[number, number, number]> {
  const css = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-body').trim())
  const hex = /^#([0-9a-f]{6})$/i.exec(css)
  if (!hex) throw new Error(`--bg-body is not a hex colour: ${css}`)
  const n = Number.parseInt(hex[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

test.describe('P2-H — panel polish', () => {
  test.setTimeout(150_000)

  for (const theme of ['dark', 'light'] as const) {
    test(`a hovered inspector field is lighter than a resting one (${theme}, UX-11)`, async ({ page }) => {
      const { canvasRoot, frame } = await openBoard(page, theme)
      await selectOnCanvas(page, canvasRoot, frame.locator('.rectangle').first())
      const field = designPanel(page).locator('[data-section-id="measures"] input').first()
      await expect(field).toBeVisible({ timeout: 15_000 })

      // Park the pointer off the panel, read the rest fill, then hover.
      await page.mouse.move(5, 450)
      const panel = await panelBackground(page)
      const rest = luminance(await fieldFill(field), panel)
      const box = await field.boundingBox()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await expect
        .poll(async () => luminance(await fieldFill(field), panel), {
          message: `${theme}: the hovered field must be lighter than its resting fill`,
        })
        .toBeGreaterThan(rest)
    })
  }

  test('Layers: a keyboard focus draws a ring, a click does not; selected and hovered rows differ (UX-20, UX-21)', async ({
    page,
  }) => {
    const { canvasRoot, frame } = await openBoard(page, 'dark')
    const captionId = await selectOnCanvas(page, canvasRoot, frame.locator('.caption').first())
    const rectangleId = await selectOnCanvas(page, canvasRoot, frame.locator('.rectangle').first())

    const selected = layerRow(page, rectangleId)
    const other = layerRow(page, captionId)
    await expect(selected).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
    await expect(other).toBeVisible()

    // UX-21 — hover the OTHER row: its fill must not equal the selection's.
    const otherBox = await other.boundingBox()
    await page.mouse.move(otherBox!.x + otherBox!.width / 2, otherBox!.y + otherBox!.height / 2)
    const hoveredFill = await other.evaluate((el) => getComputedStyle(el).backgroundColor)
    const selectedFill = await selected.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(hoveredFill, 'a hovered row must paint a fill').not.toBe('rgba(0, 0, 0, 0)')
    expect(selectedFill, 'the selected row and a hovered row paint the same fill').not.toBe(hoveredFill)

    // ...and the selected row keeps its own fill while the pointer is on it.
    const selectedBox = await selected.boundingBox()
    await page.mouse.move(selectedBox!.x + selectedBox!.width / 2, selectedBox!.y + selectedBox!.height / 2)
    expect(await selected.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(selectedFill)

    // UX-20 — a mouse click focuses the row but draws no ring over the
    // selection it just made.
    await selected.click()
    await expect(selected).toBeFocused()
    expect(await selected.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none')

    // Reach the same row from the keyboard: Tab away, Shift+Tab back.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(selected).toBeFocused()
    expect(
      await selected.evaluate((el) => getComputedStyle(el).boxShadow),
      'a keyboard-focused Layers row must draw a visible ring',
    ).toContain('inset')
  })

  test('a node-level notice sits on the panel gutter (UX-25)', async ({ page }) => {
    const { canvasRoot, frame } = await openBoard(page, 'dark')
    await selectOnCanvas(page, canvasRoot, frame.locator('.item').first())

    const notice = page.getByTestId('source-constraint-notice')
    await expect(notice, 'a .map() row must show its source-constraint notice').toBeVisible({ timeout: 15_000 })
    const [noticeBox, panelBox] = await Promise.all([
      notice.boundingBox(),
      page.getByTestId('properties-node-notices').evaluate((el) => {
        const panel = el.parentElement!.getBoundingClientRect()
        return { x: panel.left, width: panel.width }
      }),
    ])
    expect(noticeBox).not.toBeNull()
    const insetLeft = noticeBox!.x - panelBox.x
    const insetRight = panelBox.x + panelBox.width - (noticeBox!.x + noticeBox!.width)
    expect(Math.round(insetLeft), 'the notice runs to the panel edge on the left').toBe(PANEL_GUTTER_PX)
    expect(Math.round(insetRight), 'the notice runs to the panel edge on the right').toBe(PANEL_GUTTER_PX)
  })
})
