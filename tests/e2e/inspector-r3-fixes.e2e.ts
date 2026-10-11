import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  selectInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * Round-3 inspector fixes, each driven with a real mouse and real keys and
 * asserted on the BYTES of the project on disk:
 *
 *   1. Cmd-Z after a style edit that landed as an override or an expanded
 *      shorthand (`padding: 20px 10px` + padding-top, `border-radius: 8px` + one
 *      corner) restores the stylesheet byte for byte - the history entry carries
 *      the save's undo-journal token.
 *   2. The Text field of a node whose text is a call-site attribute commits once
 *      on Enter (no newline, `title="Alpha"` stays a plain string attribute) and
 *      is ONE undo.
 *   3. Esc after typing a padding value takes the canvas preview back.
 *   4. A notification never covers the inspector.
 *
 * SAFETY - writes to a fixture created under this run's throwaway workspace
 * copy and removed afterwards; `studio-workspace/` is never touched.
 */

const FIXTURE_CSS = `/* r3 inspector fixture */
.padded {
  padding: 20px 10px;
  border-radius: 8px;
  background: #eeeeee;
}

.plain {
  color: #333333;
}
`

const FIXTURE_PAGE = `import './Home.css'
import { Card } from '../components/Card'

export default function Home() {
  return (
    <main>
      <div className="padded">Padded</div>
      <Card title="First" />
      <p className="plain">Plain</p>
    </main>
  )
}
`

const CARD = `export function Card({ title }: { title: string }) {
  return (
    <section>
      <h3>{title}</h3>
    </section>
  )
}
`

let fixture: FixtureProject
const readFile = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')
const readCss = () => readFile('pages/Home.css')
const readPage = () => readFile('pages/Home.tsx')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-inspector-r3-fixes', {
    'pages/Home.css': FIXTURE_CSS,
    'pages/Home.tsx': FIXTURE_PAGE,
    'components/Card.tsx': CARD,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openBoard(page: Page): Promise<{ canvasRoot: Locator; content: FrameLocator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, content: canvasContentFrame(frame) }
}

async function select(page: Page, canvasRoot: Locator, target: Locator): Promise<void> {
  await panIntoView(page, canvasRoot, target, 80)
  await selectInFrame(page, target)
}

/** The inspector field named `name`, with its cluster expanded to individual sides when it is not already. */
async function sideField(page: Page, cluster: 'padding' | 'radius', name: string): Promise<Locator> {
  const field = page.getByRole('textbox', { name, exact: true })
  const toggle = page.getByTestId(`expandable-field-cluster-${cluster}-toggle`)
  // Padding lives in the Layout section, which opens collapsed.
  if (cluster === 'padding' && !(await toggle.isVisible())) await page.getByRole('button', { name: 'Layout', exact: true }).click()
  for (let attempt = 0; attempt < 3 && !(await field.isVisible()); attempt += 1) {
    await toggle.click()
    await page.waitForTimeout(150)
  }
  await expect(field, `${name} never became visible`).toBeVisible({ timeout: 10_000 })
  return field
}

async function typeAndEnter(field: Locator, value: string): Promise<void> {
  await field.click()
  await field.press('ControlOrMeta+a')
  await field.fill(value)
  await field.press('Enter')
}

/** Cmd-Z from the canvas (focus on the board, not in a field), then wait for the file to read `original`. */
async function undoAndExpect(page: Page, read: () => string, original: string, message: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(read, { message, timeout: 30_000 }).toBe(original)
}

test.describe('r3 inspector fixes', () => {
  test.setTimeout(150_000)

  for (const side of ['Padding top', 'Padding bottom', 'Padding left'] as const) {
    test(`Cmd-Z after ${side} on padding: 20px 10px restores the stylesheet byte for byte`, async ({ page }) => {
      const { canvasRoot, content } = await openBoard(page)
      await select(page, canvasRoot, content.locator('.padded').first())
      const field = await sideField(page, 'padding', side)

      await typeAndEnter(field, '30px')
      await expect.poll(readCss, { timeout: 30_000 }).not.toBe(FIXTURE_CSS)
      expect(readCss(), 'the edit must reach the .padded rule').toContain('30px')

      // Let the save answer (its journal token turns the history entry into a restore), then take focus off the field.
      await expect(page.getByTestId('style-landing-chip')).toBeVisible({ timeout: 30_000 })
      await select(page, canvasRoot, content.locator('.padded').first())
      await undoAndExpect(page, readCss, FIXTURE_CSS, `Cmd-Z after ${side} left the stylesheet different from the original`)
    })
  }

  test('editing one radius corner of border-radius: 8px keeps the shorthand and writes one corner; Cmd-Z is byte-exact', async ({ page }) => {
    const { canvasRoot, content } = await openBoard(page)
    await select(page, canvasRoot, content.locator('.padded').first())
    const field = await sideField(page, 'radius', 'Border radius, top left')

    await typeAndEnter(field, '20px')
    await expect.poll(readCss, { timeout: 30_000 }).not.toBe(FIXTURE_CSS)
    const edited = readCss()
    expect(edited, 'the shorthand the author wrote must survive').toContain('border-radius: 8px')
    expect(edited.match(/border-[a-z-]+-radius:/g) ?? [], 'exactly one corner longhand is written').toHaveLength(1)

    await expect(page.getByTestId('style-landing-chip')).toBeVisible({ timeout: 30_000 })
    await select(page, canvasRoot, content.locator('.padded').first())
    await undoAndExpect(page, readCss, FIXTURE_CSS, 'Cmd-Z after a radius corner left the stylesheet different from the original')
  })

  test('Esc after typing a padding value takes the canvas preview back and writes nothing', async ({ page }) => {
    const { canvasRoot, content } = await openBoard(page)
    const padded = content.locator('.padded').first()
    await select(page, canvasRoot, padded)
    const field = await sideField(page, 'padding', 'Padding left')
    const paddingLeft = () => padded.evaluate((el) => getComputedStyle(el).paddingLeft)
    expect(await paddingLeft()).toBe('10px')

    await field.click()
    await field.press('ControlOrMeta+a')
    await field.pressSequentially('40')
    await expect.poll(paddingLeft, { message: 'typing did not preview on the canvas' }).toBe('40px')

    await field.press('Escape')

    await expect.poll(paddingLeft, { message: 'Esc left the preview painted on the canvas' }).toBe('10px')
    await expect(field).toHaveValue('10px')
    await page.waitForTimeout(1_000)
    expect(readCss(), 'Esc must write nothing').toBe(FIXTURE_CSS)
  })

  test('the Text field of attribute-bound text commits once on Enter, as a plain attribute, with one undo', async ({ page }) => {
    const { canvasRoot, content } = await openBoard(page)
    // A click inside a component selects its call site; Enter steps into the instance, and a second click then selects the h3 itself.
    await select(page, canvasRoot, content.locator('h3').first())
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        content
          .locator('[data-canvas-selection-ring="true"]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-canvas-overlay-node-id'))),
      )
      .toEqual([expect.stringContaining('~')])
    await select(page, canvasRoot, content.locator('h3').first())
    const text = page.getByRole('textbox', { name: 'Text', exact: true })
    await expect(text).toBeVisible({ timeout: 15_000 })
    await expect(text).toHaveValue('First')

    await text.click()
    await text.press('ControlOrMeta+a')
    await text.pressSequentially('Alpha')
    // Nothing is written while typing.
    await page.waitForTimeout(1_200)
    expect(readPage(), 'typing wrote to the file before Enter').toBe(FIXTURE_PAGE)

    await text.press('Enter')
    await expect.poll(readPage, { timeout: 30_000 }).toContain('title="Alpha"')
    expect(readPage(), 'Enter must not add a newline or turn the attribute into an expression').not.toContain('title={')

    await page.waitForTimeout(600)
    await select(page, canvasRoot, content.locator('h3').first())
    await undoAndExpect(page, readPage, FIXTURE_PAGE, 'one Cmd-Z did not restore title="First"')
  })

  test('a notification never covers the inspector', async ({ page }) => {
    const { canvasRoot, content } = await openBoard(page)
    // A component call site takes no style: the opacity key says so in a toast.
    const card = content.locator('section').first()
    await panIntoView(page, canvasRoot, card, 80)
    const box = await card.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await expect(page.getByTestId('properties-panel')).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press('5')

    const stack = page.getByTestId('toast-stack')
    await expect(stack).toBeVisible({ timeout: 10_000 })
    const [toastBox, panelBox] = await Promise.all([stack.boundingBox(), page.getByTestId('properties-panel').boundingBox()])
    expect(toastBox).not.toBeNull()
    expect(panelBox).not.toBeNull()
    const overlapsHorizontally = toastBox!.x < panelBox!.x + panelBox!.width && toastBox!.x + toastBox!.width > panelBox!.x
    const overlapsVertically = toastBox!.y < panelBox!.y + panelBox!.height && toastBox!.y + toastBox!.height > panelBox!.y
    expect(overlapsHorizontally && overlapsVertically, 'the toast stack sits on top of the inspector').toBe(false)
    await expect(page.locator('[role="alert"]', { hasText: /won.t be saved/i })).toHaveCount(0)
  })
})
