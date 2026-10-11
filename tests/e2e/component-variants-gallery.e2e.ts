import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  SELECTION_RING,
  createAuthoredFixtureProject,
  frameForPage,
  openFixtureBoard,
  removeFixtureProject,
  selectInFrame,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame } from './helpers/canvasIframe'

/**
 * CV-2 — the Components board: a component with enum/boolean props gets one
 * frame whose body is the cartesian product of those props, each cell a real
 * inlined instance. happy-dom has no layout engine, so what is asserted here is
 * MEASURED: every cell has a box, the grid wraps into rows and columns, and the
 * source on disk is never touched.
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

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-component-variants-gallery', {
    'pages/Home.tsx': HOME,
    'components/Button.tsx': BUTTON,
    'components/Button.css': BUTTON_CSS,
    // The project already has a board with its page on it, as a project someone has
    // worked in does. (A brand-new project with no frames is seeded client-side with
    // a frame for EVERY page, derived ones included, before the server's board exists.)
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

test.describe('CV-2 — the variants gallery on the Components board', () => {
  test.setTimeout(180_000)

  test('renders every variant combination as a laid-out, labelled cell and writes nothing to source', async ({ page }) => {
    const before = [BUTTON, BUTTON_CSS, HOME].map((_, i) =>
      fs.readFileSync(path.join(fixture.dir, ...['components/Button.tsx', 'components/Button.css', 'pages/Home.tsx'][i]!.split('/')), 'utf8'),
    )
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })

    // The gallery lives on its own board, next to the project's, like Stories.
    // The first /load is what places the gallery frames, so the board list may
    // have been read just before the Components board existed: one reload covers it.
    const boardRow = page.getByRole('treeitem', { name: 'Components', exact: true })
    if (!(await boardRow.isVisible({ timeout: 15_000 }).catch(() => false))) {
      await page.reload()
      await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 60_000 })
    }
    await boardRow.click()
    const frame = await frameForPage(page, canvasRoot, PAGE_ID)
    const content = canvasContentFrame(frame)

    // 3 variants x 2 sizes x 2 booleans = 12 real <button>s, one per cell.
    const buttons = content.locator('button')
    await expect(buttons).toHaveCount(12, { timeout: 30_000 })
    await expect(content.getByText('variant=ghost, size=sm, disabled=true')).toHaveCount(1)

    // Measured, not inferred: every cell has a box and the grid wraps into
    // more than one row AND more than one column.
    const boxes = await buttons.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }),
    )
    expect(boxes.every((b) => b.w > 0 && b.h > 0)).toBe(true)
    expect(new Set(boxes.map((b) => b.x)).size).toBeGreaterThan(1)
    expect(new Set(boxes.map((b) => b.y)).size).toBeGreaterThan(1)

    // The member each cell names is the one it renders.
    expect(await content.locator('button.btn-ghost').count()).toBe(4)
    expect(await content.locator('button.btn-danger').count()).toBe(4)

    // Selecting a cell selects that variant's root: a composite id whose tail is Button.tsx.
    const ghostSmall = content.locator('button.btn-ghost').first()
    await selectInFrame(page, ghostSmall)
    await expect(content.locator(SELECTION_RING)).toHaveCount(1)
    expect(await ghostSmall.getAttribute('data-node-id')).toContain('~components/Button.tsx:')

    const after = ['components/Button.tsx', 'components/Button.css', 'pages/Home.tsx'].map((rel) =>
      fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8'),
    )
    expect(after).toEqual(before)
  })
})
