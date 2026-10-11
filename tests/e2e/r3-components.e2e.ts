import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  sourceNodeId,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * Round 3, components / styles / loose layers - each fix measured with a real
 * mouse and keyboard against the bytes on disk and the computed layout.
 *
 *   1. Text styles in a CSS Modules project apply and create through the file's
 *      binding (`styles.x`), and one Cmd+Z puts both files back.
 *   2. The Components board is made again when boards.json lost it, and a board
 *      list saved by an editor that never read it keeps it.
 *   3. With a draw tool armed a press draws, even on a loose layer; a loose
 *      layer's inspector edits its fill; no stray element lands in a page.
 *   4. Ctrl+Z after Add variant undoes it while focus is still on the "+" button.
 *
 * SAFETY - every fixture lives under this run's throwaway workspace copy.
 */

const read = (fixture: FixtureProject, rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')
const exists = (fixture: FixtureProject, rel: string) => fs.existsSync(path.join(fixture.dir, ...rel.split('/')))
const boardsOf = (fixture: FixtureProject) =>
  (JSON.parse(read(fixture, '.studio/boards.json')) as { boards: Array<{ id: string; name: string; frames: Array<{ pageId: string }>; layers?: Array<{ id: string; x: number; y: number }> }> }).boards

const style = (target: Locator, property: string): Promise<string> =>
  target.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property)

/** A real mouse drag with intermediate moves, the way a hand does it. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 14): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
}

// ── 1. text styles in a CSS Modules project ─────────────────────────────────

const PROBE = `import styles from './Probe.module.css'

export default function Probe() {
  return (
    <main className={styles.frame}>
      <h2 className={styles.greet}>Hello</h2>
      <p className={styles.note}>Count</p>
    </main>
  )
}
`

const PROBE_CSS = `.frame {
  display: grid;
  padding: 24px;
}

.greet {
  font-size: 28px;
  font-weight: 700;
}

.counter {
  font-size: 12px;
  line-height: 1.4;
}

.note {
  margin: 0;
}
`

test.describe('text styles in a CSS Modules project', () => {
  test.setTimeout(240_000)
  let fixture: FixtureProject

  test.beforeEach(() => {
    fixture = createAuthoredFixtureProject('__e2e-r3-text-styles', {
      'pages/Probe.tsx': PROBE,
      'pages/Probe.module.css': PROBE_CSS,
      '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
    })
  })
  test.afterEach(() => removeFixtureProject(fixture))

  test('apply swaps the bound class, create writes into the page module, each is one undo', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'probe')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)
    const h2 = () => content.locator(`[data-node-id="${sourceNodeId(read(fixture, 'pages/Probe.tsx'), 'pages/Probe.tsx', 'h2')}"]`).first()

    const select = async () => {
      await panIntoView(page, canvasRoot, h2(), 80)
      await selectInFrame(page, h2())
      await expect(page.getByTestId('text-styles-trigger'), 'the click never selected the heading').toBeVisible({ timeout: 15_000 })
    }

    // Apply `counter` over the bound `greet`.
    await select()
    expect(await style(h2(), 'font-size')).toBe('28px')
    await page.getByTestId('text-styles-trigger').click()
    await page.getByTestId('style-option-counter').click()
    await expect.poll(() => read(fixture, 'pages/Probe.tsx'), { message: 'applying a module style never reached Probe.tsx', timeout: 30_000 }).toContain('<h2 className={styles.counter}>')
    expect(read(fixture, 'pages/Probe.tsx')).not.toContain('styles.greet')
    expect(read(fixture, 'pages/Probe.module.css'), 'applying must not touch the module').toBe(PROBE_CSS)
    await expect.poll(() => style(h2(), 'font-size'), { message: 'the canvas still draws the old style', timeout: 30_000 }).toBe('12px')

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(fixture, 'pages/Probe.tsx'), { timeout: 30_000 }).toBe(PROBE)
    await expect.poll(() => style(h2(), 'font-size'), { timeout: 30_000 }).toBe('28px')

    // Create a style from what the heading shows.
    await select()
    await page.getByTestId('text-styles-trigger').click()
    await page.getByTestId('text-style-create').click()
    await page.getByTestId('text-style-name').fill('Hero')
    await page.getByTestId('text-style-name-submit').click()
    await expect.poll(() => read(fixture, 'pages/Probe.module.css'), { message: 'create never wrote into the page module', timeout: 30_000 }).toContain('.text-hero')
    await expect.poll(() => read(fixture, 'pages/Probe.tsx'), { timeout: 30_000 }).toContain('styles["text-hero"]')
    expect(read(fixture, 'pages/Probe.tsx')).not.toContain('styles.greet')
    await expect.poll(() => style(h2(), 'font-size'), { timeout: 30_000 }).toBe('28px')
    expect(exists(fixture, 'pages/studio.css'), 'a stray global stylesheet was made').toBe(false)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(fixture, 'pages/Probe.tsx'), { timeout: 30_000 }).toBe(PROBE)
    await expect.poll(() => read(fixture, 'pages/Probe.module.css'), { timeout: 30_000 }).toBe(PROBE_CSS)
  })
})

// ── 2. the Components board ──────────────────────────────────────────────────

const HOME = `export default function Home() {
  return <main><h1>Home</h1></main>
}
`

const BUTTON = `import './Button.css'

export type ButtonProps = {
  label: string
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
}

export function Button({ label, variant = 'primary', size = 'md', disabled = false }: ButtonProps) {
  return (
    <button className={\`btn btn-\${variant}\`} data-size={size} disabled={disabled}>
      {label}
    </button>
  )
}
`

const BUTTON_CSS = `.btn { display: inline-block; padding: 8px 16px; font: 14px sans-serif; border: 1px solid #999; }
.btn-primary { background: #2563eb; color: white; }
.btn-ghost { background: transparent; }
.btn-danger { background: #dc2626; color: white; }
[data-size='sm'] { padding: 4px 8px; }
`

const GALLERY_PAGE = 'component-components-button'

test.describe('the Components board', () => {
  test.setTimeout(240_000)
  let fixture: FixtureProject

  test.afterEach(() => removeFixtureProject(fixture))

  test('a ledger that points at a board boards.json lost is healed on open, and an editor save keeps it', async ({ page }) => {
    fixture = createAuthoredFixtureProject('__e2e-r3-components-board-lost', {
      'pages/Home.tsx': HOME,
      'components/Button.tsx': BUTTON,
      'components/Button.css': BUTTON_CSS,
      '.studio/boards.json': JSON.stringify({
        version: 1,
        boards: [{ id: 'main', name: 'Board 1', frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0 }], notes: [], docs: [], guides: [] }],
      }),
      // The ledger names a board that is not in boards.json: the real-data state the audit found.
      '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static', components: { boardId: 'a6c71a1c-gone', placedPageIds: [GALLERY_PAGE] } }, null, 2) + '\n',
    })
    await openFixtureBoard(page, fixture, { autoSave: true })

    await expect
      .poll(() => boardsOf(fixture).find((board) => board.name === 'Components')?.frames.map((frame) => frame.pageId), {
        message: 'the Components board was never made again',
        timeout: 60_000,
      })
      .toEqual([GALLERY_PAGE])

    // An editor that read boards.json BEFORE the heal saves its own list: add a board and wait for the autosave.
    await page.getByRole('button', { name: 'New board' }).click()
    await expect.poll(() => boardsOf(fixture).length, { message: 'the new board never reached boards.json', timeout: 30_000 }).toBeGreaterThanOrEqual(3)
    expect(boardsOf(fixture).map((board) => board.name)).toContain('Components')

    // After a reload the board is in the switcher.
    await page.reload()
    await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('treeitem', { name: 'Components', exact: true })).toBeVisible({ timeout: 30_000 })
  })

  test('a fresh project keeps the server-made Components board next to the seeded first board', async ({ page }) => {
    fixture = createAuthoredFixtureProject('__e2e-r3-components-board-fresh', {
      'pages/Home.tsx': HOME,
      'components/Button.tsx': BUTTON,
      'components/Button.css': BUTTON_CSS,
      '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
    })
    await openFixtureBoard(page, fixture, { autoSave: true })
    await expect(page.locator('[data-page-id="home"]').first()).toBeAttached({ timeout: 60_000 })
    await expect
      .poll(() => boardsOf(fixture).map((board) => board.name).sort(), {
        message: 'the client autosave overwrote the Components board',
        timeout: 60_000,
      })
      .toEqual(['Board 1', 'Components'])
    await page.waitForTimeout(3000)
    expect(boardsOf(fixture).map((board) => board.name).sort()).toEqual(['Board 1', 'Components'])
  })
})

// ── 3. loose layers ──────────────────────────────────────────────────────────

const LAYER_ID = 'clrect000001'
const LAYER_MODULE = `/* eslint-disable */
// Studio free-canvas layer. Not part of your app: nothing imports this file.
export default function CanvasLayer() {
  return (
    <div style={{ width: "160px", height: "100px", background: "#d9d9d9" }} />
  )
}
`

test.describe('loose layers', () => {
  test.setTimeout(300_000)
  let fixture: FixtureProject

  test.beforeEach(() => {
    fixture = createAuthoredFixtureProject('__e2e-r3-loose-layers', {
      'pages/Home.tsx': HOME,
      [`.studio/canvas/${LAYER_ID}.tsx`]: LAYER_MODULE,
      '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static', frameDefaults: { width: 600, height: 400 } }, null, 2) + '\n',
      '.studio/boards.json': JSON.stringify({
        version: 1,
        boards: [
          {
            id: 'board-1',
            name: 'Board 1',
            frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0, width: 600, height: 400 }],
            notes: [],
            docs: [],
            // Left of the frame, so it stays clear of the inspector the selection docks on the right.
            layers: [{ id: LAYER_ID, x: -480, y: 20, z: 1 }],
          },
        ],
      }),
    })
  })
  test.afterEach(() => removeFixtureProject(fixture))

  const layerModules = () => fs.readdirSync(path.join(fixture.dir, '.studio', 'canvas')).filter((name) => /^cl[a-z0-9]{10}\.tsx$/.test(name))
  const layerBox = (page: Page, id: string) => page.frameLocator('iframe[data-studio-canvas-surface-frame]').locator(`[data-studio-layer-id="${id}"] > *`)

  test('the inspector edits a loose layer; a press with the rectangle tool draws even on top of one; no page is touched', async ({ page }) => {
    const homeBefore = read(fixture, 'pages/Home.tsx')
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    await zoomToPercent(page, canvasRoot, 50)
    const layerEl = layerBox(page, LAYER_ID)
    await expect(layerEl).toBeVisible({ timeout: 60_000 })

    // ── select it with the real mouse and edit its fill ──────────────────────
    const at = (await layerEl.boundingBox())!
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
    await expect(page.getByTestId('layer-style'), 'the inspector never offered the layer its controls').toBeVisible({ timeout: 15_000 })
    expect(await style(layerEl, 'background-color')).toBe('rgb(217, 217, 217)')

    const fill = page.getByRole('textbox', { name: 'Layer fill colour' })
    await fill.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('#ff0000')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => read(fixture, `.studio/canvas/${LAYER_ID}.tsx`), { message: 'the fill never reached the layer module', timeout: 30_000 })
      .toMatch(/background: ["']#ff0000["']/)
    await expect.poll(() => style(layerBox(page, LAYER_ID), 'background-color'), { timeout: 30_000 }).toBe('rgb(255, 0, 0)')

    // One Cmd+Z puts the module back, byte for byte.
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(fixture, `.studio/canvas/${LAYER_ID}.tsx`), { timeout: 30_000 }).toBe(LAYER_MODULE)

    // ── size from the inspector ──────────────────────────────────────────────
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
    const width = page.getByRole('textbox', { name: 'Layer width' })
    await width.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('240')
    await page.keyboard.press('Enter')
    await expect.poll(() => read(fixture, `.studio/canvas/${LAYER_ID}.tsx`), { timeout: 30_000 }).toMatch(/width: ["']240px["']/)
    await expect.poll(async () => (await layerBox(page, LAYER_ID).boundingBox())!.width, { timeout: 30_000 }).toBeCloseTo(120, 0)
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2)
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(fixture, `.studio/canvas/${LAYER_ID}.tsx`), { timeout: 30_000 }).toBe(LAYER_MODULE)

    // ── the rectangle tool: a press on the loose layer draws ────────────────
    const placementBefore = boardsOf(fixture)[0]!.layers!.find((layer) => layer.id === LAYER_ID)!
    const onLayer = (await layerBox(page, LAYER_ID).boundingBox())!
    await page.getByRole('button', { name: 'Rectangle tool' }).click()
    await expect(page.getByRole('button', { name: 'Rectangle tool' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-canvas-draw-layer="rectangle"]')).toBeVisible({ timeout: 15_000 })
    // The press point is on the loose layer itself and the armed draw layer is what is under it.
    const press = { x: onLayer.x + 10, y: onLayer.y + 10 }
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-canvas-draw-layer'), press)).toBe('rectangle')
    await drag(page, press, { x: onLayer.x + 60, y: onLayer.y + 50 })

    await expect.poll(() => layerModules().length, { message: 'a press on a loose layer did not draw a new rectangle', timeout: 30_000 }).toBe(2)
    await expect
      .poll(() => boardsOf(fixture)[0]!.layers!.length, { message: 'the new rectangle has no placement', timeout: 30_000 })
      .toBe(2)
    const placementAfter = boardsOf(fixture)[0]!.layers!.find((layer) => layer.id === LAYER_ID)!
    expect(placementAfter.x, 'the existing layer moved').toBe(placementBefore.x)
    expect(placementAfter.y, 'the existing layer moved').toBe(placementBefore.y)
    expect(read(fixture, `.studio/canvas/${LAYER_ID}.tsx`), 'the existing layer was rewritten').toBe(LAYER_MODULE)

    // Draw a second one on empty board, quickly after the first: nothing lands in the page.
    await page.getByRole('button', { name: 'Rectangle tool' }).click()
    const root = (await canvasRoot.boundingBox())!
    await drag(page, { x: root.x + 120, y: root.y + root.height - 160 }, { x: root.x + 220, y: root.y + root.height - 100 })
    await expect.poll(() => layerModules().length, { timeout: 30_000 }).toBe(3)
    await page.waitForTimeout(1500)
    expect(read(fixture, 'pages/Home.tsx'), 'a stray element was written into the page').toBe(homeBefore)
  })
})

// ── 4. undo after Add variant ────────────────────────────────────────────────

test.describe('undo after Add variant', () => {
  test.setTimeout(240_000)
  let fixture: FixtureProject
  test.beforeAll(() => {
    fixture = createAuthoredFixtureProject('__e2e-r3-undo-add-variant', {
      'pages/Home.tsx': HOME,
      'components/Button.tsx': BUTTON,
      'components/Button.css': BUTTON_CSS,
      '.studio/boards.json': JSON.stringify({
        version: 1,
        boards: [{ id: 'main', name: 'Board 1', frames: [{ id: 'f-home', pageId: 'home', x: 0, y: 0 }], notes: [], docs: [], guides: [] }],
      }),
      '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
    })
  })
  test.afterAll(() => removeFixtureProject(fixture))

  test('Ctrl+Z works with focus still on the + button', async ({ page }) => {
    const files = ['components/Button.tsx', 'components/Button.css'] as const
    const before = files.map((rel) => read(fixture, rel))
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const boardRow = page.getByRole('treeitem', { name: 'Components', exact: true })
    if (!(await boardRow.isVisible({ timeout: 15_000 }).catch(() => false))) {
      await page.reload()
      await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 60_000 })
    }
    await boardRow.click()
    const frame = await frameForPage(page, canvasRoot, GALLERY_PAGE)
    await panIntoView(page, canvasRoot, frame)
    const content = canvasContentFrame(frame)
    await expect(content.locator('button')).toHaveCount(12, { timeout: 30_000 })

    const add = frame.getByTestId('gallery-add-variant')
    await add.click()
    const form = page.getByTestId('add-variant-form')
    await expect(form).toBeVisible()
    await form.getByTestId('add-variant-name').fill('outline')
    await page.keyboard.press('Enter')
    await expect.poll(() => read(fixture, 'components/Button.tsx'), { timeout: 30_000 }).toContain("'outline'")

    // No click anywhere else: whatever has focus keeps it. Pressed the moment the file changed,
    // before the gallery has re-read it, the way a hand does it.
    await expect(add, 'focus did not return to the + button the form was opened from').toBeFocused({ timeout: 10_000 })
    await page.keyboard.press('Control+z')
    await expect.poll(() => files.map((rel) => read(fixture, rel)), { message: 'Ctrl+Z was ignored', timeout: 30_000 }).toEqual(before)
    await expect(content.locator('button')).toHaveCount(12, { timeout: 60_000 })
    await page.waitForTimeout(1500)
    expect(files.map((rel) => read(fixture, rel)), 'the undo was undone or repeated').toEqual(before)
  })
})
