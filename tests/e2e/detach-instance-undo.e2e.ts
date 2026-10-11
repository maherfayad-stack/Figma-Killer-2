import { expect, test, type Page } from '@playwright/test'
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
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P5-C (DET-5) — Detach instance, in a real browser, asserted on the FILE on
 * disk and on the undo journal:
 *
 *   - ⌘⌥B / Ctrl+Alt+B on a plain instance detaches it at once — no dialog —
 *     writing the component's markup in place of `<Badge/>` (its import
 *     retired), with ONE journal entry; the markup that replaced the call site
 *     is selected; ONE ⌘Z puts the file back byte for byte;
 *   - on an instance whose component has another rendered state, the same key
 *     asks FIRST — the confirm names what is lost and the file is untouched
 *     until "Detach"; then one ⌘Z restores it;
 *   - a RIGHT-click on the canvas lands on the instance (not the element of
 *     the component under the pointer), so the menu offers "Detach instance"
 *     — it used to open on that inner element, replace the selection with it,
 *     and never offer the item;
 *   - a design-system component (the project's managed `design-system/`
 *     folder, an opaque `alm.*` node) detaches as the local code it is
 *     (OD-21): the folder's own markup is written in place of `<Button/>`, the
 *     folder stays byte-identical, and one Cmd+Z puts the call site back.
 *
 * SAFETY — this spec WRITES, so it authors its own fixture under this run's
 * throwaway copy of `studio-workspace/` and removes it afterwards.
 */

const HOME = 'pages/Home.tsx'

const HOME_PAGE = `import { Badge } from '../components/Badge'
import { Status } from '../components/Status'
import { Button } from '../design-system'

export default function Home() {
  return (
    <main style={{ padding: "24px" }}>
      <h1 className="title">Detach</h1>
      <Badge label="new" />
      <Status />
      <Button variant="primary" label="Continue" />
    </main>
  )
}
`

/** The project's copy of the design system: a real, readable component behind a barrel, exactly where Studio writes it. */
const DESIGN_SYSTEM_INDEX = `export { Button } from './components/Button'
`

const DESIGN_SYSTEM_BUTTON = `export function Button({ label }) {
  return <button className="ds-btn" type="button">{label}</button>
}
`

const BADGE = `export function Badge({ label }: { label: string }) {
  return <span className="badge" style={{ display: "inline-block", padding: "12px", background: "#fc0" }}>{label}</span>
}
`

const STATUS = `export function Status({ loading }: { loading?: boolean }) {
  if (loading) return <p className="status">Loading</p>
  return <p className="status" style={{ padding: "12px", background: "#9cf" }}>Ready</p>
}
`

let fixture: FixtureProject
const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')
const journalEntries = () => {
  const folder = path.join(fixture.dir, '.studio', 'undo-journal')
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []
}

/** The detach item of the open layer menu (the canvas renders the Layers panel's menu). */
const detachMenuItem = (page: Page) => page.getByTestId('layer-menu-detach-instance')

async function selectedNodeId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
    return useEditorStore.getState().selectedNodeId as string | null
  })
}

/** The top history entry's ⌘Z is known — the journal token has come back from the write. */
async function topEntryHasInverse(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
    const top = useEditorStore.getState()._historyPast.at(-1)
    return top?.structural?.gesture === 'source' && top.structural.source.inverse !== null
  })
}

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-detach-instance-undo', {
    [HOME]: HOME_PAGE,
    'components/Badge.tsx': BADGE,
    'components/Status.tsx': STATUS,
    'design-system/index.js': DESIGN_SYSTEM_INDEX,
    'design-system/components/Button.jsx': DESIGN_SYSTEM_BUTTON,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

test.describe('P5-C — detach an instance, and one ⌘Z puts it back', () => {
  test.setTimeout(240_000)

  test('Ctrl+Alt+B detaches a plain instance with no dialog; ⌘Z restores the exact bytes', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)

    const badgeId = sourceNodeId(HOME_PAGE, HOME, 'Badge', 1)
    const badge = content.locator(`[data-node-id^="${badgeId}~"]`).first()
    await panIntoView(page, canvasRoot, badge, 80)
    await selectInFrame(page, badge)
    await expect.poll(() => selectedNodeId(page)).toBe(badgeId)

    await canvasRoot.focus()
    await page.keyboard.press('Control+Alt+b')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('<Badge')
    const detached = read(HOME)
    expect(detached).toContain('<span className="badge"')
    expect(detached).toContain('>new</span>')
    expect(detached, 'the detach left the import it was the last use of').not.toContain("from '../components/Badge'")
    expect(await page.getByTestId('detach-confirm-losses').count(), 'a plain detach asked a question').toBe(0)
    expect(journalEntries()).toHaveLength(1)
    // What replaced the call site is selected: an ordinary element of the page now.
    await expect.poll(() => selectedNodeId(page), { timeout: 30_000 }).toMatch(/^pages\/Home\.tsx:\d+:\d+$/)
    await expect.poll(() => topEntryHasInverse(page)).toBe(true)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
    await expect(content.locator(`[data-node-id^="${badgeId}~"]`).first(), 'the instance never came back on the canvas').toBeVisible({ timeout: 30_000 })
    expect(journalEntries(), 'the restored entry was not consumed').toHaveLength(0)
  })

  test('an instance with another rendered state asks first, writes only on "Detach", and ⌘Z restores it', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)

    const statusId = sourceNodeId(HOME_PAGE, HOME, 'Status', 1)
    const status = content.locator(`[data-node-id^="${statusId}~"]`).first()
    await panIntoView(page, canvasRoot, status, 80)
    await selectInFrame(page, status)
    await expect.poll(() => selectedNodeId(page)).toBe(statusId)

    await canvasRoot.focus()
    await page.keyboard.press('Control+Alt+b')
    const losses = page.getByTestId('detach-confirm-losses')
    await expect(losses).toBeVisible({ timeout: 30_000 })
    await expect(losses).toContainText('more than one state')
    expect(read(HOME), 'the confirm wrote before it was answered').toBe(HOME_PAGE)
    expect(journalEntries()).toHaveLength(0)

    await page.getByTestId('detach-confirm-accept').click()
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('<Status')
    expect(read(HOME)).toContain('>Ready</p>')
    expect(journalEntries()).toHaveLength(1)
    await expect.poll(() => topEntryHasInverse(page)).toBe(true)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })

  test('a right-click on the canvas lands on the instance, and its menu detaches it', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)

    const badgeId = sourceNodeId(HOME_PAGE, HOME, 'Badge', 1)
    // The Badge's own <span>: an element of the COMPONENT's markup, not the instance.
    const inner = content.locator(`[data-node-id^="${badgeId}~"]`).first()
    await panIntoView(page, canvasRoot, inner, 80)
    const box = await inner.boundingBox()
    expect(box, 'the instance rendered no box').not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' })

    await expect(detachMenuItem(page), 'the canvas menu on an instance did not offer Detach').toBeVisible({ timeout: 15_000 })
    await expect(detachMenuItem(page)).toBeEnabled()
    expect(await selectedNodeId(page), 'the right-click selected the element under the pointer, not the instance').toBe(badgeId)

    await detachMenuItem(page).click()
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('<Badge')
    expect(read(HOME)).toContain('<span className="badge"')
    expect(journalEntries()).toHaveLength(1)
  })

  test('a design-system component detaches as local code: the folder is untouched, and Cmd+Z puts the call site back', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)

    const buttonId = sourceNodeId(HOME_PAGE, HOME, 'Button', 1)
    // The design-system host is `display: contents` - click what it renders.
    const rendered = content.locator(`[data-node-id="${buttonId}"] button`).first()
    await panIntoView(page, canvasRoot, rendered, 80)
    await selectInFrame(page, rendered)
    await expect.poll(() => selectedNodeId(page)).toBe(buttonId)

    await canvasRoot.focus()
    await page.keyboard.press('Control+Alt+b')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).not.toContain('<Button')
    expect(read(HOME)).toContain('<button className="ds-btn" type="button">Continue</button>')
    expect(read('design-system/components/Button.jsx'), 'detaching wrote into the design-system folder').toBe(DESIGN_SYSTEM_BUTTON)
    expect(read('design-system/index.js')).toBe(DESIGN_SYSTEM_INDEX)
    expect(journalEntries()).toHaveLength(1)
    await expect.poll(() => topEntryHasInverse(page)).toBe(true)

    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read(HOME), { timeout: 30_000 }).toBe(HOME_PAGE)
  })

  test('the menu offers Detach on a design-system component, enabled', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
    const frame = await frameForPage(page, canvasRoot, 'home')
    await panIntoView(page, canvasRoot, frame)
    await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
    const content = canvasContentFrame(frame)

    const buttonId = sourceNodeId(HOME_PAGE, HOME, 'Button', 1)
    const rendered = content.locator(`[data-node-id="${buttonId}"] button`).first()
    await panIntoView(page, canvasRoot, rendered, 80)
    const box = await rendered.boundingBox()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' })
    await expect(detachMenuItem(page), 'the menu hid Detach on a design-system component').toBeVisible({ timeout: 15_000 })
    await expect(detachMenuItem(page)).toBeEnabled()
    await page.keyboard.press('Escape')

    expect(read(HOME), 'opening the menu wrote').toBe(HOME_PAGE)
    expect(journalEntries()).toHaveLength(0)
  })
})
