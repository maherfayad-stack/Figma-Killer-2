import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  clickInFrame,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  readToastRecorder,
  removeFixtureProject,
  sourceNodeId,
  startToastRecorder,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P3-D — structural gestures that used to REFUSE now write, in a real
 * browser, asserted on the FILES on disk and on the `/save` requests:
 *
 *   - ERR-7: a multi-selection drag in the Layers tree is ONE `/save`
 *     sequence, and ONE ⌘Z puts the file back byte-for-byte;
 *   - ERR-8: ⌘C in one frame, ⌘V in another writes the copy into the second
 *     page's file and leaves the first alone;
 *   - OD-7: Delete on an element inside ONE instance of a shared component
 *     changes that instance only — the component file and the other instance
 *     are untouched — and ONE ⌘Z restores the page byte-for-byte.
 *
 * SAFETY — this spec WRITES, so every case authors its own fixture under this
 * run's throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const HOME = 'pages/Home.tsx'
const ABOUT = 'pages/About.tsx'
const CARD = 'components/Card.tsx'

const HOME_PAGE = `import { Card } from '../components/Card'

export default function Home() {
  return (
    <main style={{ padding: "24px" }}>
      <p className="a">Alpha</p>
      <p className="b">Bravo</p>
      <p className="c">Charlie</p>
      <p className="d">Delta</p>
      <Card title="One" />
      <Card title="Two" />
    </main>
  )
}
`

const ABOUT_PAGE = `export default function About() {
  return (
    <main style={{ padding: "24px" }}>
      <h2 className="remote">Copied from About</h2>
    </main>
  )
}
`

const CARD_COMPONENT = `export function Card({ title }: { title: string }) {
  return (
    <section className="card" style={{ border: "1px solid #999", padding: "8px", margin: "8px 0" }}>
      <h3>{title}</h3>
      <hr className="rule" style={{ height: "4px", background: "#333" }} />
    </section>
  )
}
`

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-structural-gestures', {
    [HOME]: HOME_PAGE,
    [ABOUT]: ABOUT_PAGE,
    [CARD]: CARD_COMPONENT,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

function recordSaves(page: Page): Request[] {
  const saves: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request)
  })
  return saves
}

const QUIET_MS = 2_000

async function openLayers(page: Page): Promise<Locator> {
  const tree = page.getByTestId('dom-panel-tree')
  await expect(tree, 'the layers tree never rendered').toBeVisible({ timeout: 20_000 })
  return tree
}

/** Drag one layer row onto another's edge band — the same small-step drag `structural-writeback.e2e.ts` uses. */
async function dragRow(page: Page, row: Locator, target: Locator, edge: 'before' | 'after'): Promise<void> {
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(500)
  const [from, to] = await Promise.all([row.boundingBox(), target.boundingBox()])
  if (!from || !to) throw new Error('the drag source or drop target has no bounding box')
  await page.mouse.move(from.x + 120, from.y + from.height / 2)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from.x + 120, from.y + from.height / 2 + step * 3)
    await page.waitForTimeout(30)
  }
  const y = edge === 'before' ? to.y + 2 : to.y + to.height - 2
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(to.x + 120, y)
    await page.waitForTimeout(60)
  }
  await expect(target).toHaveAttribute('data-drop-position', edge)
  await page.mouse.up()
}

async function openHome(page: Page) {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = await frameForPage(page, canvasRoot, 'home')
  await panIntoView(page, canvasRoot, frame)
  await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, frame, content: frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR) }
}

test.describe('P3-D — structural refusals become writes', () => {
  test.setTimeout(240_000)

  test('ERR-7: dragging two separated layers is ONE sequence write, and ONE ⌘Z undoes it', async ({ page }) => {
    const { canvasRoot, content } = await openHome(page)
    const saves = recordSaves(page)
    const a = content.locator(`[data-node-id="${sourceNodeId(HOME_PAGE, HOME, 'p', 1)}"]`).first()
    await panIntoView(page, canvasRoot, a, 80)
    await clickInFrame(page, a)

    // The selection is built in the Layers tree: click A, Ctrl-click C (the
    // tree's toggle), then drag A — the whole selection travels with it.
    const tree = await openLayers(page)
    const rowA = tree.getByTestId(`dom-tree-item-${sourceNodeId(HOME_PAGE, HOME, 'p', 1)}`)
    const rowC = tree.getByTestId(`dom-tree-item-${sourceNodeId(HOME_PAGE, HOME, 'p', 3)}`)
    const rowD = tree.getByTestId(`dom-tree-item-${sourceNodeId(HOME_PAGE, HOME, 'p', 4)}`)
    await rowA.click()
    await rowC.click({ modifiers: ['Control'] })
    await expect(rowA).toHaveAttribute('aria-selected', 'true')
    await expect(rowC).toHaveAttribute('aria-selected', 'true')
    await dragRow(page, rowA, rowD, 'after')

    const moved = HOME_PAGE.replace('      <p className="a">Alpha</p>\n', '')
      .replace('      <p className="c">Charlie</p>\n', '')
      .replace('      <p className="d">Delta</p>\n', '      <p className="d">Delta</p>\n      <p className="a">Alpha</p>\n      <p className="c">Charlie</p>\n')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(moved)
    await page.waitForTimeout(QUIET_MS)
    expect(saves, 'a multi-selection drag is ONE source write').toHaveLength(1)
    expect(saves[0]!.postDataJSON().sequence).toBe(true)

    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })

  test('ERR-8: ⌘C in one frame and ⌘V in another writes the copy into the second file', async ({ page }) => {
    const { canvasRoot } = await openHome(page)
    await startToastRecorder(page)
    await frameForPage(page, canvasRoot, 'about')
    // Picked in the Layers tree: a pointer pick there hands the keyboard to
    // the canvas (OD-15), so ⌘C / ⌘V reach the canvas shortcuts.
    const tree = await openLayers(page)
    await tree.getByTestId(`dom-tree-item-${sourceNodeId(ABOUT_PAGE, ABOUT, 'main', 1)}`).click()
    const remoteRow = tree.getByTestId(`dom-tree-item-${sourceNodeId(ABOUT_PAGE, ABOUT, 'h2', 1)}`)
    await remoteRow.click()
    await expect(remoteRow).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+c')

    // The paste target is picked on the Home frame itself: that activates Home.
    const home = await frameForPage(page, canvasRoot, 'home')
    const d = home.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR).locator(`[data-node-id="${sourceNodeId(HOME_PAGE, HOME, 'p', 4)}"]`).first()
    await panIntoView(page, canvasRoot, d, 80)
    await clickInFrame(page, d)
    await expect(tree.getByTestId(`dom-tree-item-${sourceNodeId(HOME_PAGE, HOME, 'p', 4)}`)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+v')

    await expect
      .poll(() => read(HOME), { timeout: 30_000, message: 'the paste never reached Home.tsx' })
      .toContain('<h2 className="remote">Copied from About</h2>')
      .catch(async (error: unknown) => {
        throw new Error(`${String(error)}\ntoasts: ${JSON.stringify(await readToastRecorder(page))}`)
      })
    expect(read(ABOUT), 'the frame it was copied from is untouched').toBe(ABOUT_PAGE)

    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
    expect(read(ABOUT)).toBe(ABOUT_PAGE)
  })

  test('OD-7: Delete inside ONE instance of a shared component changes that instance only; ONE ⌘Z restores it', async ({ page }) => {
    const { canvasRoot, content } = await openHome(page)
    const firstCard = sourceNodeId(HOME_PAGE, HOME, 'Card', 1)
    const rule = `${firstCard}~${sourceNodeId(CARD_COMPONENT, CARD, 'hr', 1)}`
    const title = content.locator(`[data-node-id="${firstCard}~${sourceNodeId(CARD_COMPONENT, CARD, 'h3', 1)}"]`).first()
    await panIntoView(page, canvasRoot, title, 80)
    await clickInFrame(page, title)
    const selected = () =>
      page.evaluate(async () => {
        const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
        return useEditorStore.getState().selectedNodeId as string | null
      })
    // P2-B: a click selects the outermost instance; Enter goes one level in
    // (the instance, then its first child), Tab to the next sibling — down to
    // the rule after the <h3>.
    const heading = `${firstCard}~${sourceNodeId(CARD_COMPONENT, CARD, 'h3', 1)}`
    for (let i = 0; i < 6; i += 1) {
      const now = await selected()
      if (now === rule) break
      await page.keyboard.press(now === heading ? 'Tab' : 'Enter')
      await page.waitForTimeout(300)
    }
    await expect.poll(selected).toBe(rule)

    await page.keyboard.press('Delete')

    // This instance is now its own markup, minus the rule; the component file
    // and the second instance are exactly as they were. No dialog opened.
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('<Card title="One" />')
    // The detach lands first; the delete it replays lands right after.
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('className="rule"')
    const detached = read(HOME)
    expect(detached).toContain('<h3>One</h3>')
    expect(detached).not.toContain('className="rule"')
    expect(detached).toContain('<Card title="Two" />')
    expect(read(CARD)).toBe(CARD_COMPONENT)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const stack = () =>
      page.evaluate(async () => {
        const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
        const st = useEditorStore.getState()
        const show = (entry: { linkedToNext?: boolean; structural?: { gesture: string; source?: { label: string; inverse: unknown } } }) =>
          `${entry.structural?.gesture}:${entry.structural?.source?.label ?? ''}:linked=${entry.linkedToNext ?? false}:inv=${JSON.stringify(entry.structural?.source?.inverse ?? null).slice(0, 160)}`
        return `past=[${st._historyPast.map(show).join(' | ')}] future=[${st._historyFuture.map(show).join(' | ')}]`
      })
    const beforeUndo = await stack()
    await page.keyboard.press('Control+z')
    await expect
      .poll(() => read(HOME), { timeout: 30_000, message: `before ⌘Z ${beforeUndo}` })
      .toBe(HOME_PAGE)
      .catch(async (error: unknown) => {
        throw new Error(`${String(error)}
after ⌘Z ${await stack()}`)
      })
    expect(read(CARD)).toBe(CARD_COMPONENT)
  })
})
