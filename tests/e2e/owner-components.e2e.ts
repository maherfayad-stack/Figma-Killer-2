import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  selectInFrame,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * Owner-reported component problems (2026-10-11), replayed with a real mouse and
 * keyboard on a throwaway project copy:
 *
 *  O1  Assets offers the built-in design system in a project that does not carry
 *      it. The insert wrote `import { TabBar } from '../design-system'` to a
 *      folder that was not there, so the real app stopped building and the board
 *      showed "Loading TabBar..." for ever. The first design-system insert now
 *      writes the folder and `.studio/meta.json` `designSystem: 'alm'` in the same
 *      batch, and one Ctrl+Z takes the page, the folder and the meta field back.
 *      An import that cannot resolve says so instead of "Loading".
 *
 *  O6  An instance's props were not all editable: a boolean, a selected tab, an
 *      enum had no control on a design-system instance (the unset ones sat behind
 *      a tiny disclosure and a list or callback prop had no row at all). Every
 *      prop of the component has a row; each writes the call-site attribute once.
 */

const HOME_BEFORE = `export default function Home() {
  return (
    <div className="wrap">
      <p>Hello</p>
    </div>
  )
}
`

let fixture: FixtureProject

const rel = (...parts: string[]): string => path.join(fixture.dir, ...parts)
const read = (...parts: string[]): string => fs.readFileSync(rel(...parts), 'utf8')
const metaDesignSystem = (): unknown => {
  const file = rel('.studio', 'meta.json')
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { designSystem?: string }).designSystem : undefined
}

test.use({ viewport: { width: 1600, height: 1000 } })

async function openBoard(page: Page, pageId = 'home'): Promise<FrameLocator> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator(`[data-page-id="${pageId}"]`).first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame), 'the fixture frame never mounted a canvas iframe').toBeVisible({ timeout: 60_000 })
  return canvasContentFrame(frame)
}

/**
 * The label of the newest undo entry once it has the inverse its write reported:
 * the write has landed AND the board has re-read it. `null` until then.
 */
async function topEntryLabel(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/admin/pages/site/store/store.ts' as string)
    const top = useEditorStore.getState()._historyPast.at(-1)
    return top?.structural?.gesture === 'source' && top.structural.source.inverse !== null ? (top.structural.source.label as string) : null
  })
}

async function insertFromAssets(page: Page, query: string, assetId: string): Promise<void> {
  await page.getByTestId('panel-rail-assets').click()
  const assets = page.getByTestId('assets-panel')
  await expect(assets).toBeVisible({ timeout: 10_000 })
  await assets.getByRole('searchbox', { name: 'Search assets' }).fill(query)
  await assets.locator(`[data-asset-id="${assetId}"]`).first().click()
}

test.describe('O1: the first design-system insert brings the design system', () => {
  test.setTimeout(240_000)

  test.beforeEach(() => {
    fixture = createAuthoredFixtureProject('__e2e-owner-ds-insert', { 'pages/Home.tsx': HOME_BEFORE })
  })
  test.afterEach(() => {
    removeFixtureProject(fixture)
  })

  test('insert writes the folder and the meta with the page, renders, and one Ctrl+Z removes all of it', async ({ page }) => {
    const contentFrame = await openBoard(page)
    expect(fs.existsSync(rel('design-system'))).toBe(false)

    await insertFromAssets(page, 'TabBar', 'alm.TabBar')

    const inserted = contentFrame.locator('[data-module-id="alm.TabBar"]').first()
    await expect(inserted, 'the inserted TabBar never rendered (the board shows a placeholder instead)').toBeVisible({ timeout: 90_000 })
    await expect(contentFrame.locator('[data-studio-package-placeholder]')).toHaveCount(0)

    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain("import { TabBar } from '../design-system'")
    expect(fs.existsSync(rel('design-system', 'index.js')), 'the import points at a folder that does not exist').toBe(true)
    expect(metaDesignSystem()).toBe('alm')

    // One Ctrl+Z: the page, the folder and the meta field go together.
    await expect.poll(() => topEntryLabel(page)).toBe('Add TabBar')
    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toBe(HOME_BEFORE)
    await expect.poll(() => fs.existsSync(rel('design-system')), { timeout: 30_000 }).toBe(false)
    expect(metaDesignSystem()).toBeUndefined()
    expect(fs.existsSync(rel('.studio', 'design-system.json'))).toBe(false)
  })

  test('an import that resolves to nothing says so instead of Loading for ever', async ({ page }) => {
    fixture = createAuthoredFixtureProject('__e2e-owner-ds-insert', {
      'pages/Home.tsx': `import { TabBar } from '../../design-system'

export default function Home() {
  return (
    <div className="wrap">
      <TabBar items={[{ label: 'Home' }]} value={0} />
    </div>
  )
}
`,
    })
    const contentFrame = await openBoard(page)
    const placeholder = contentFrame.locator('[data-studio-package-placeholder]').first()
    await expect(placeholder).toBeVisible({ timeout: 60_000 })
    await expect(placeholder, 'a node whose import cannot resolve must not promise to load').not.toContainText('Loading', { timeout: 60_000 })
    await expect(placeholder).toContainText('TabBar')
  })
})

/** The design-system-backed fixture O6 needs: the folder is the declaration, Studio renders from its own pack. */
const DS_PAGE = `import { Toggle, TabBar } from '../design-system'

export default function Home() {
  return (
    <div className="wrap">
      <TabBar items={[{ label: 'Home' }, { label: 'Explore' }, { label: 'My Trips' }]} value={0} />
      <Toggle />
    </div>
  )
}
`
const DS_STUB = `export function Toggle() { return null }
export function TabBar() { return null }
`

async function selectModule(page: Page, contentFrame: FrameLocator, moduleId: string): Promise<void> {
  // The module wrapper is `display: contents` (no box of its own); its first drawn child is what a user clicks.
  const target: Locator = contentFrame.locator(`[data-module-id="${moduleId}"] *`).first()
  await panIntoView(page, page.getByTestId('canvas-root'), target)
  await selectInFrame(page, target)
}

test.describe('O6: every prop of an instance has a control that writes the call site', () => {
  test.setTimeout(240_000)

  test.beforeEach(() => {
    fixture = createAuthoredFixtureProject('__e2e-owner-props', {
      'pages/Home.tsx': DS_PAGE,
      'design-system/index.js': DS_STUB,
    })
  })
  test.afterEach(() => {
    removeFixtureProject(fixture)
  })

  test('a boolean is a switch and the selected tab a select, shown without opening anything', async ({ page }) => {
    const contentFrame = await openBoard(page)

    const props = page.getByTestId('module-properties')
    await selectModule(page, contentFrame, 'alm.Toggle')
    const checked = props.getByTestId('property-control-checked')
    await expect(checked, 'the Toggle has no on/off control in the panel').toBeVisible({ timeout: 15_000 })
    await checked.getByRole('switch').click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain('<Toggle checked')

    await selectModule(page, contentFrame, 'alm.TabBar')
    const value = props.getByTestId('property-control-value')
    await expect(value, 'TabBar has no selected-tab control').toBeVisible({ timeout: 15_000 })
    await value.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Explore' }).click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain('value={1}')
    // The list itself is shown, read-only, not dropped from the panel.
    await expect(props.getByTestId('property-control-items')).toBeVisible()
  })
})

const NAVBAR_PAGE = `import { Navbar } from '../design-system'

export default function Home() {
  return (
    <div className="wrap">
      <Navbar title="Trips" segmentedControl={{ items: ['Flights', 'Stays'], value: 0 }} chips={[{ label: 'Dates', dropdown: true, selected: false }]} />
    </div>
  )
}
`

test.describe('O6: the literals inside a list or object prop are editable one by one', () => {
  test.setTimeout(240_000)

  test.beforeEach(() => {
    fixture = createAuthoredFixtureProject('__e2e-owner-nested', {
      'pages/Home.tsx': NAVBAR_PAGE,
      'design-system/index.js': 'export function Navbar() { return null }',
    })
  })
  test.afterEach(() => {
    removeFixtureProject(fixture)
  })

  test('Navbar: the selected segment is a select, a chip is a switch, and one Ctrl+Z puts the bytes back', async ({ page }) => {
    const contentFrame = await openBoard(page)
    const props = page.getByTestId('module-properties')
    await selectModule(page, contentFrame, 'alm.Navbar')

    const segment = props.getByTestId('property-control-segmentedControl.value')
    await expect(segment, 'Navbar has no control for the selected segment').toBeVisible({ timeout: 15_000 })
    await segment.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Stays' }).click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain("segmentedControl={{ items: ['Flights', 'Stays'], value: 1 }}")

    // A chip's flag, inside the list.
    const chip = props.getByTestId('property-control-chips.0.selected')
    await expect(chip).toBeVisible({ timeout: 15_000 })
    await chip.getByRole('switch').click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain("chips={[{ label: 'Dates', dropdown: true, selected: true }]}")

    // Everything else in the file is exactly what it was, and Undo twice returns the original bytes.
    await expect.poll(() => topEntryLabel(page)).toBe('Set chips.0.selected')
    await page.getByTestId('canvas-root').focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain('selected: false')
    await expect.poll(() => topEntryLabel(page)).toBe('Set segmentedControl.value')
    await page.keyboard.press('Control+z')
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toBe(NAVBAR_PAGE)
  })
})

const TABS_COMPONENT = `export function Tabs({
  items,
  activeIndex = 0,
  compact = false,
  tone = 'info',
}: {
  items: string[]
  activeIndex?: number
  compact?: boolean
  tone?: 'info' | 'warn' | 'danger'
}) {
  return (
    <div className={compact ? 'tabs compact' : 'tabs'} data-tone={tone}>
      <span className="tab">{items[activeIndex]}</span>
    </div>
  )
}`

const TABS_PAGE = `import { Tabs } from '../components/Tabs'

export default function Home() {
  return (
    <div className="wrap">
      <Tabs items={['Home', 'Explore', 'Trips']} />
    </div>
  )
}
`

test.describe('O6: a project component lists every prop it declares', () => {
  test.setTimeout(240_000)

  test.beforeEach(() => {
    fixture = createAuthoredFixtureProject('__e2e-owner-local-props', {
      'pages/Home.tsx': TABS_PAGE,
      'components/Tabs.tsx': TABS_COMPONENT,
    })
  })
  test.afterEach(() => {
    removeFixtureProject(fixture)
  })

  test('a boolean is a switch, a union a select, the selected tab a select of the labels, a list its entries', async ({ page }) => {
    const contentFrame = await openBoard(page)
    const target = contentFrame.locator('[data-node-id="pages/Home.tsx:6:8~components/Tabs.tsx:14:8"]')
    await panIntoView(page, page.getByTestId('canvas-root'), target)
    await selectInFrame(page, target)

    const section = page.getByTestId('instance-component-section')
    await expect(section, 'selecting the Tabs element did not select the instance').toBeVisible({ timeout: 30_000 })

    // A boolean the call site does not pass is still a switch.
    await section.getByTestId('instance-call-site-prop-compact').getByRole('switch').click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain("<Tabs items={['Home', 'Explore', 'Trips']} compact />")
      .catch(async () => expect(read('pages', 'Home.tsx')).toContain('compact={true}'))

    // The selected tab: a select of the list's own labels, not a number box.
    const active = section.getByTestId('instance-call-site-prop-activeIndex')
    await active.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Explore' }).click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain('activeIndex={1}')

    // The string union.
    const tone = section.getByTestId('instance-call-site-prop-tone')
    await expect(tone).toBeVisible()
    await tone.getByRole('button', { name: 'warn' }).click()
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain('tone="warn"')

    // The list's entries are rows too: rename one tab in the source.
    const second = section.getByTestId('property-control-items.1')
    await expect(second).toBeVisible()
    await second.getByRole('textbox').fill('Discover')
    await second.getByRole('textbox').press('Enter')
    await expect.poll(() => read('pages', 'Home.tsx'), { timeout: 30_000 }).toContain("items={['Home', 'Discover', 'Trips']}")
  })
})
