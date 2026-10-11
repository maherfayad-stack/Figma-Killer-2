import { expect, test, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import {
  selectInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  startToastRecorder,
  readToastRecorder,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * G-3 / OD-22 - a real mouse drag across a component instance's edge never ends
 * in a refusal, asserted on the FILES and the undo journal:
 *
 *   - dropping an element into a LAYOUT component's content area writes it
 *     between the `<Shell>` tags at the call site: Shell is not detached, its
 *     own file is untouched, no notice appears, ONE journal entry, ONE Ctrl+Z;
 *   - dropping it into a component that renders no children detaches that one
 *     instance, writes the element inside the markup that replaced it, shows
 *     the one-line notice with the way back, and ONE Ctrl+Z restores both;
 *   - dragging an element OUT of an instance into the page around it does the
 *     same detach-and-replay.
 *
 * Every assertion is on the file on disk, the journal, or the toasts the user
 * saw - never a store flag.
 *
 * SAFETY - this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const PAGE = 'pages/Recipes.tsx'

const SHELL = `export function Shell({ title, children }) {
  return (
    <section className="shell" style={{ padding: "16px", background: "#eef" }}>
      <h1>{title}</h1>
      <div className="shell-body" style={{ padding: "12px", background: "#fed" }}>{children}</div>
      <footer className="shell-foot">fin</footer>
    </section>
  )
}
`

const PLATE = `export function Plate({ label }) {
  return (
    <div className="plate" style={{ padding: "24px", background: "#cfc" }}>
      <span className="plate-label">{label}</span>
      <button type="button" className="plate-close">Close</button>
    </div>
  )
}
`

const RECIPES = `import { Shell } from '../components/Shell'
import { Plate } from '../components/Plate'

export default function Recipes() {
  return (
    <main className="recipes" style={{ padding: "24px" }}>
      <Shell title="Soups">
        <p className="first" style={{ padding: "10px" }}>Leek</p>
      </Shell>
      <Plate label="Bowl" />
      <aside className="tip" style={{ padding: "10px" }}>Salt early</aside>
    </main>
  )
}
`

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')
const journalEntries = () => {
  const folder = path.join(fixture.dir, '.studio', 'undo-journal')
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []
}

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-detach-never-refuses', {
    [PAGE]: RECIPES,
    'components/Shell.tsx': SHELL,
    'components/Plate.tsx': PLATE,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static', frameDefaults: { width: 480, height: 640 } }, null, 2) + '\n',
    // One narrow frame, so every drop point below is inside the visible canvas.
    '.studio/boards.json': JSON.stringify(
      {
        version: 1,
        boards: [
          { id: 'recipes-board', name: 'Recipes', frames: [{ id: 'recipes-frame', pageId: 'recipes', x: 0, y: 0, width: 480 }], notes: [], docs: [], guides: [] },
        ],
      },
      null,
      2,
    ),
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  if (!box) throw new Error('drag target has no bounding box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Press on `from`, travel well past the activation distance, release at (`x`, `y`) - the pointer path a hand makes. */
async function dragTo(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const start = await centerOf(from)
  // A press picks up the SELECTED layer, so select it first, as a hand does (`press-drag-depth.e2e.ts`).
  await page.mouse.click(start.x, start.y)
  await page.waitForTimeout(200)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 18 })
  await page.waitForTimeout(400)
  await page.mouse.up()
}

async function openRecipes(page: Page) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = await frameForPage(page, canvasRoot, 'recipes')
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, content: canvasContentFrame(frame) }
}

test.describe('G-3 / OD-22 - gestures across a component instance edge', () => {
  test.setTimeout(300_000)

  test('a real drop into a layout component\'s content area is written between the <Shell> tags - no detach, no notice, one Ctrl+Z', async ({ page }) => {
    const { canvasRoot, content } = await openRecipes(page)
    await startToastRecorder(page)

    const tip = content.locator(`[data-node-id="${sourceNodeId(RECIPES, PAGE, 'aside')}"]`)
    const first = content.locator(`[data-node-id="${sourceNodeId(RECIPES, PAGE, 'p')}"]`)
    await panIntoView(page, canvasRoot, first, 80)
    const firstBox = await first.boundingBox()
    expect(firstBox, 'the slot child rendered no box').not.toBeNull()
    // The bottom edge of the call site's own <p>, inside Shell's content area: the "after it" slot.
    await dragTo(page, tip, { x: firstBox!.x + firstBox!.width / 2, y: firstBox!.y + firstBox!.height - 3 })

    await expect.poll(() => read(PAGE), { timeout: 30_000 }).not.toBe(RECIPES)
    const after = read(PAGE)
    expect(after, 'Shell was detached').toContain('<Shell title="Soups">')
    const inside = after.slice(after.indexOf('<Shell'), after.indexOf('</Shell>'))
    expect(inside, 'the tip did not land between the <Shell> tags').toContain('className="tip"')
    expect(inside.indexOf('className="tip"')).toBeGreaterThan(inside.indexOf('className="first"'))
    expect(read('components/Shell.tsx'), 'the layout component was edited').toBe(SHELL)
    expect(journalEntries()).toHaveLength(1)

    const toasts = await readToastRecorder(page)
    expect(toasts.filter((toast) => toast.kind === 'error'), 'a drop into a layout slot showed an error').toHaveLength(0)
    expect(toasts.some((toast) => toast.title.includes('Detached')), 'a drop into a layout slot detached the layout').toBe(false)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(PAGE), { timeout: 30_000 }).toBe(RECIPES)
  })

  test('a real drop into a component that renders no children detaches it, writes inside it, says so once, and one Ctrl+Z restores', async ({ page }) => {
    const { canvasRoot, content } = await openRecipes(page)
    await startToastRecorder(page)

    const tip = content.locator(`[data-node-id="${sourceNodeId(RECIPES, PAGE, 'aside')}"]`)
    const plate = content.locator(`[data-node-id^="${sourceNodeId(RECIPES, PAGE, 'Plate')}~"]`).first()
    await panIntoView(page, canvasRoot, plate, 80)
    const plateBox = await plate.boundingBox()
    expect(plateBox, 'the instance rendered no box').not.toBeNull()
    // The middle of the plate, clear of its two children (which sit at its left): "inside the plate".
    await dragTo(page, tip, { x: plateBox!.x + plateBox!.width / 2, y: plateBox!.y + plateBox!.height / 2 })

    await expect.poll(() => read(PAGE), { timeout: 30_000 }).not.toContain('<Plate')
    const after = read(PAGE)
    const plateMarkup = after.slice(after.indexOf('<div className="plate"'), after.indexOf('</div>'))
    expect(plateMarkup, 'the tip did not land inside the detached plate').toContain('className="tip"')
    expect(read('components/Plate.tsx'), 'the component was edited').toBe(PLATE)

    const notice = page.locator('[data-toast-kind="info"]').filter({ hasText: 'Detached Plate to place this. Undo restores it.' })
    await expect(notice, 'the detach was silent').toBeVisible({ timeout: 15_000 })
    const toasts = await readToastRecorder(page)
    expect(toasts.filter((toast) => toast.kind === 'error'), 'an edge-crossing drop showed an error').toHaveLength(0)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(PAGE), { timeout: 30_000 }).toBe(RECIPES)
    expect(read('components/Plate.tsx')).toBe(PLATE)
  })

  test('a real drag OUT of an instance into the page detaches that instance and moves the element, one Ctrl+Z restores', async ({ page }) => {
    const { canvasRoot, content } = await openRecipes(page)
    await startToastRecorder(page)

    const plateId = sourceNodeId(RECIPES, PAGE, 'Plate')
    const close = content.locator(`button[data-node-id^="${plateId}~"]`).first()
    const tip = content.locator(`[data-node-id="${sourceNodeId(RECIPES, PAGE, 'aside')}"]`)
    await panIntoView(page, canvasRoot, close, 80)
    // Open the instance first (double-click, Figma's way in): a closed instance is one layer, and a press
    // on its button would move the whole thing.
    const closeBox = await close.boundingBox()
    expect(closeBox, 'the button rendered no box').not.toBeNull()
    await page.mouse.dblclick(closeBox!.x + closeBox!.width / 2, closeBox!.y + closeBox!.height / 2)
    await page.waitForTimeout(400)
    await selectInFrame(page, close)
    const tipBox = await tip.boundingBox()
    expect(tipBox, 'the page element rendered no box').not.toBeNull()
    await dragTo(page, close, { x: tipBox!.x + tipBox!.width / 2, y: tipBox!.y + tipBox!.height - 3 })

    await expect.poll(() => read(PAGE), { timeout: 30_000 }).not.toContain('<Plate')
    const after = read(PAGE)
    expect(after.indexOf('className="plate-close"'), 'the button did not leave the plate').toBeGreaterThan(after.indexOf('</div>'))
    expect(read('components/Plate.tsx')).toBe(PLATE)
    const toasts = await readToastRecorder(page)
    expect(toasts.filter((toast) => toast.kind === 'error')).toHaveLength(0)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(PAGE), { timeout: 30_000 }).toBe(RECIPES)
  })
})
