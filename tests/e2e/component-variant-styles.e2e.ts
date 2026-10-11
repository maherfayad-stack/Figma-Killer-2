import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  selectInFrame,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame } from './helpers/canvasIframe'

/**
 * CV-4 — a style edit on a variant lands in THAT variant's rule, in a real
 * browser. On the Components board, select a ghost cell and change its text
 * colour in the inspector: the four ghost cells repaint and nothing else does,
 * and the file diff touches only `.btn-ghost`. The base rule `.btn` — the only
 * rule that sets a colour for a ghost button — keeps every byte, which is the
 * case a cascade-following write gets wrong (it would write `.btn` and recolour
 * every variant).
 *
 * SAFETY — the fixture lives under this run's throwaway workspace copy.
 */

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

const BUTTON_CSS = `.btn { display: inline-block; padding: 8px 16px; font: 14px sans-serif; border: 1px solid #999; color: #111111; }
.btn-primary { background: #2563eb; color: #ffffff; }
.btn-ghost { background: transparent; }
.btn-danger { background: #dc2626; color: #ffffff; }
[data-size='sm'] { padding: 4px 8px; }
`

const PAGE_ID = 'component-components-button'
const FILES = ['components/Button.tsx', 'components/Button.css', 'pages/Home.tsx'] as const

let fixture: FixtureProject

const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-component-variant-styles', {
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

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

test.describe('CV-4 — a style edit on a variant lands in that variant', () => {
  test.setTimeout(240_000)

  test("changing a ghost cell's text colour recolours the ghost cells only, and writes only .btn-ghost", async ({ page }) => {
    const before = Object.fromEntries(FILES.map((rel) => [rel, read(rel)]))
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })

    const boardRow = page.getByRole('treeitem', { name: 'Components', exact: true })
    if (!(await boardRow.isVisible({ timeout: 15_000 }).catch(() => false))) {
      await page.reload()
      await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 60_000 })
    }
    await boardRow.click()
    const frame = await frameForPage(page, canvasRoot, PAGE_ID)
    const content = canvasContentFrame(frame)
    await expect(content.locator('button')).toHaveCount(12, { timeout: 30_000 })

    const colourOf = (selector: string) =>
      content.locator(selector).evaluateAll((els) => els.map((el) => getComputedStyle(el).color))
    const ghostBefore = await colourOf('button.btn-ghost')
    const primaryBefore = await colourOf('button.btn-primary')
    const dangerBefore = await colourOf('button.btn-danger')
    expect(new Set(ghostBefore)).toEqual(new Set(['rgb(17, 17, 17)']))

    // Select one ghost cell. A click inside an instance selects the instance, which is on the
    // Main component tab here; it says which rule a style edit will land in, and one press opens it.
    await selectInFrame(page, content.locator('button.btn-ghost').first())
    await expect(page.getByTestId('variant-style-entry-text')).toHaveText('Style edits go to .btn-ghost in Button.css.', { timeout: 20_000 })
    await page.getByTestId('variant-style-entry-edit').click()
    const label = page.getByTestId('variant-context-label')
    await expect(label).toHaveText('Editing variant ghost: .btn-ghost in Button.css', { timeout: 20_000 })

    // Change the text colour: the Text row of the Fill section. A ghost button sets no colour of
    // its own (the base rule does), which is exactly the case a cascade-following write gets wrong.
    const textColour = page.getByRole('textbox', { name: 'Text colour', exact: true })
    await textColour.scrollIntoViewIfNeeded()
    await expect(textColour).toBeVisible({ timeout: 10_000 })
    await textColour.click()
    await textColour.press('ControlOrMeta+a')
    await textColour.fill('#ff0000')
    await textColour.press('Enter')

    // The file: ONLY .btn-ghost changed, and it gained the declaration.
    await expect
      .poll(() => read('components/Button.css'), { message: 'the colour never reached Button.css', timeout: 30_000 })
      .toContain('.btn-ghost {')
    await expect.poll(() => read('components/Button.css'), { timeout: 30_000 }).not.toBe(before['components/Button.css'])
    const css = read('components/Button.css')
    expect(css.replace(/\r\n/g, '\n')).toMatch(/^\.btn-ghost \{ background: transparent; color: (#ff0000|red|rgb\(255, 0, 0\)); \}$/m)
    // Every other line is byte-identical, in order: the base rule above all.
    const changedLines = css.split('\n').filter((line, index) => line !== before['components/Button.css']!.split('\n')[index])
    expect(changedLines).toHaveLength(1)
    expect(changedLines[0]).toContain('.btn-ghost')
    expect(read('components/Button.tsx')).toBe(before['components/Button.tsx'])
    expect(read('pages/Home.tsx')).toBe(before['pages/Home.tsx'])

    // The board: every ghost cell is red, no other variant moved.
    await expect
      .poll(async () => new Set(await colourOf('button.btn-ghost')), { message: 'the ghost cells never repainted', timeout: 60_000 })
      .toEqual(new Set(['rgb(255, 0, 0)']))
    expect(await colourOf('button.btn-primary')).toEqual(primaryBefore)
    expect(await colourOf('button.btn-danger')).toEqual(dangerBefore)
    expect(await colourOf('button.btn-ghost')).toHaveLength(ghostBefore.length)

    // One undo takes the declaration out again: the file is what it was, byte for byte, and the ghost cells follow.
    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect
      .poll(() => FILES.map(read), { message: 'undo did not restore the files', timeout: 30_000 })
      .toEqual(FILES.map((rel) => before[rel]!))
    await expect
      .poll(async () => new Set(await colourOf('button.btn-ghost')), { message: 'the ghost cells never went back', timeout: 60_000 })
      .toEqual(new Set(ghostBefore))
  })
})
