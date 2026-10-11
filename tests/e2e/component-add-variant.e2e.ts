import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame } from './helpers/canvasIframe'

/**
 * CV-3 — Add variant, end to end in a real browser: the "+" in the Components
 * board's gallery frame header, a name, and the gallery shows a new column of
 * cells that were not there before. Asserted on the FILES on disk (the union
 * member, a copy of the default variant's rule, the call sites untouched) and
 * on the MEASURED gallery (cell count), then undone with one ⌘Z.
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

const BUTTON_CSS = `.btn { display: inline-block; padding: 8px 16px; font: 14px sans-serif; border: 1px solid #999; }
.btn-primary { background: #2563eb; color: white; }
.btn-ghost { background: transparent; }
.btn-danger { background: #dc2626; color: white; }
[data-size='sm'] { padding: 4px 8px; }
`

const PAGE_ID = 'component-components-button'
const FILES = ['components/Button.tsx', 'components/Button.css', 'pages/Home.tsx'] as const

let fixture: FixtureProject

const read = (rel: string) => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')
const journalEntries = () => {
  const folder = path.join(fixture.dir, '.studio', 'undo-journal')
  return fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.json')) : []
}

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-component-add-variant', {
    'pages/Home.tsx': HOME,
    'components/Button.tsx': BUTTON,
    'components/Button.css': BUTTON_CSS,
    // As in the gallery spec: the project already has a board with its page, so the
    // client does not seed a frame for every derived page over the server's board.
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

test.describe('CV-3 — Add variant from the gallery header', () => {
  test.setTimeout(240_000)

  test('adds a variant: the source gains a member and a copied rule, the gallery gains cells, one undo takes it all back', async ({ page }) => {
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

    // The "+" is in the frame's header, outside the live iframe.
    await frame.getByTestId('gallery-add-variant').click({ force: true })
    const form = page.getByTestId('add-variant-form')
    await expect(form).toBeVisible()
    await expect(form).toContainText('Starts as a copy of "primary"')
    await form.getByTestId('add-variant-name').fill('outline')
    await form.getByTestId('add-variant-submit').click()

    // The source: the union grew by one, the new rule is a copy of the default's,
    // and nothing was written at any call site.
    await expect.poll(() => read('components/Button.tsx'), { timeout: 30_000 }).toContain("'primary' | 'ghost' | 'danger' | 'outline'")
    expect(read('components/Button.css')).toBe(
      BUTTON_CSS.replace(
        '.btn-primary { background: #2563eb; color: white; }\n',
        '.btn-primary { background: #2563eb; color: white; }\n.btn-outline { background: #2563eb; color: white; }\n',
      ),
    )
    expect(read('pages/Home.tsx')).toBe(HOME)
    expect(journalEntries(), 'the add recorded no undo journal entry').toHaveLength(1)

    // The gallery: 4 variants x 2 sizes x 2 booleans, and the new column renders.
    await expect(content.locator('button')).toHaveCount(16, { timeout: 60_000 })
    await expect(content.locator('button.btn-outline')).toHaveCount(4)
    await expect(content.getByText('variant=outline, size=sm, disabled=true')).toHaveCount(1)

    // One ⌘Z puts all of it back, byte for byte, and the gallery follows. (The gallery has
    // re-rendered from the written source, so the commit's own resync, which fills in the
    // entry's inverse, has run.)
    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => FILES.map(read), { timeout: 30_000 }).toEqual(FILES.map((rel) => before[rel]!))
    await expect(content.locator('button')).toHaveCount(12, { timeout: 60_000 })
    expect(journalEntries(), 'the restored entry was not consumed').toHaveLength(0)
  })
})
