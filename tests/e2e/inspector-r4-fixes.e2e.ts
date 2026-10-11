import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  selectInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  frameForPage,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame } from './helpers/canvasIframe'

/**
 * Round-4 inspector fixes, each replayed with a real mouse and real keys and
 * asserted on the rendered frame AND on the bytes of the project on disk.
 *
 * The fixture is the round-3/4 audit project: a CSS-Modules page, two
 * `ProbeCard` instances of a shared component, two `ProbeBadge` instances.
 *
 * SAFETY - writes to a fixture created under this run's throwaway workspace
 * copy and removed afterwards; `studio-workspace/` is never touched.
 */

const PROBE_CSS = `:root {
  --probe-accent: #ff6600;
}

.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: #ffffff;
}

.greet {
  font-size: 18px;
  color: #333333;
}

.padded {
  padding: 20px 10px;
  background: #e0f0ff;
  border-radius: 8px;
}
`

const PROBE_TSX = `import styles from './Probe.module.css'
import ProbeCard from '../components/ProbeCard'
import ProbeBadge from '../components/ProbeBadge'

export default function Probe() {
  return (
    <main className={styles.page}>
      <p className={styles.greet}>Hello</p>
      <div className={styles.padded}>Padded box</div>
      <ProbeCard title="First" />
      <ProbeCard title="Second" />
      <ProbeBadge variant="danger" label="Danger" />
      <ProbeBadge variant="ghost" label="Ghost" />
    </main>
  )
}
`

const CARD_CSS = `.card {
  padding: 12px;
  background: #f4f4f4;
  border-radius: 6px;
}

.title {
  font-size: 16px;
  color: var(--probe-accent);
}
`

const CARD_TSX = `import styles from './ProbeCard.module.css'

export default function ProbeCard({ title }: { title: string }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
    </div>
  )
}
`

const BADGE_CSS = `.badge {
  display: inline-block;
  padding: 4px 8px;
}

.ghost {
  color: #0055ff;
}

.danger {
  color: #cc0000;
}
`

const BADGE_TSX = `import styles from './ProbeBadge.module.css'

type ProbeBadgeVariant = 'ghost' | 'danger'

export default function ProbeBadge({ variant = 'ghost', label }: { variant?: ProbeBadgeVariant; label: string }) {
  return <span className={\`\${styles.badge} \${styles[variant]}\`}>{label}</span>
}
`

const FILES: Record<string, string> = {
  'pages/Probe.module.css': PROBE_CSS,
  'pages/Probe.tsx': PROBE_TSX,
  'components/ProbeCard.module.css': CARD_CSS,
  'components/ProbeCard.tsx': CARD_TSX,
  'components/ProbeBadge.module.css': BADGE_CSS,
  'components/ProbeBadge.tsx': BADGE_TSX,
}

let fixture: FixtureProject
const readFile = (rel: string): string => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeEach(() => {
  fixture = createAuthoredFixtureProject('__e2e-inspector-r4-fixes', FILES)
})

test.afterEach(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openBoard(page: Page): Promise<{ canvasRoot: Locator; content: FrameLocator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  // The board also holds the project's Components frames, and which frame is `.first()` is board geometry: name the page.
  const frame = await frameForPage(page, canvasRoot, 'probe')
  return { canvasRoot, content: canvasContentFrame(frame) }
}

async function select(page: Page, canvasRoot: Locator, target: Locator): Promise<void> {
  await panIntoView(page, canvasRoot, target, 80)
  await selectInFrame(page, target)
}

/** The padding (all sides) input of the Layout section. */
async function paddingAll(page: Page): Promise<Locator> {
  const field = page.getByTestId('css-padding-all')
  if (!(await field.isVisible())) await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await expect(field, 'the inspector offered no padding control').toBeVisible({ timeout: 20_000 })
  return field
}

async function typeAndEnter(field: Locator, value: string): Promise<void> {
  await field.click()
  await field.press('ControlOrMeta+a')
  await field.fill(value)
  await field.press('Enter')
}

/** The computed padding-top of every rendered `ProbeCard` root. */
const cardPaddings = (content: FrameLocator): Promise<string[]> =>
  content.locator('h3').evaluateAll((titles) => titles.map((title) => getComputedStyle(title.parentElement as HTMLElement).paddingTop))

test.describe('r4 inspector fixes', () => {
  test.setTimeout(180_000)

  // N1 + N10 - introduced by G-2b (instance-class-overrides): the instance's class edit left its inline preview in the
  // tree, and the autosave that ran after the hold was released wrote it onto the shared component root.
  test('N1/N10: a padding edit inside one instance never reaches the component root, and the other cards keep their class', async ({ page }) => {
    const { canvasRoot, content } = await openBoard(page)
    await expect.poll(() => cardPaddings(content), { timeout: 30_000 }).toEqual(['12px', '12px'])
    const cardBefore = readFile('components/ProbeCard.tsx')

    const first = content.locator('h3').first().locator('xpath=..')
    await select(page, canvasRoot, first)
    await page.keyboard.press('Enter')
    const field = await paddingAll(page)
    await typeAndEnter(field, '30px')

    await expect.poll(() => cardPaddings(content), { message: 'only the first card takes 30px', timeout: 30_000 }).toEqual(['30px', '12px'])
    await expect.poll(() => readFile('pages/Probe.tsx'), { timeout: 30_000 }).toContain('className="card-probe-1"')
    // Give the autosave every chance to write a second time.
    await page.waitForTimeout(6_000)
    expect(readFile('components/ProbeCard.tsx'), 'the shared component gained an inline style').not.toContain('style=')
    expect(readFile('components/ProbeCard.tsx')).toContain('className')
    await expect.poll(() => cardPaddings(content), { message: 'the edited card keeps 30px and the other card keeps its class after the board re-read (N10)', timeout: 30_000 }).toEqual(['30px', '12px'])
    const otherBackground = await content.locator('h3').nth(1).locator('xpath=..').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(otherBackground, 'the second card lost its .card class on the canvas').not.toBe('rgba(0, 0, 0, 0)')

    // One Ctrl+Z brings every file back.
    await select(page, canvasRoot, first)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => readFile('pages/Probe.tsx'), { timeout: 30_000 }).toBe(PROBE_TSX)
    expect(readFile('components/ProbeCard.tsx')).toBe(cardBefore)
    expect(readFile('components/ProbeCard.module.css')).toBe(CARD_CSS)
  })
  // N2 - the swap added `import { ProbeCard }` next to the file's own `import ProbeCard from`.
  test('N2: swapping an instance to a default-exported component reuses the default import', async ({ page }) => {
    const { canvasRoot, content } = await openBoard(page)
    const badge = content.locator('span', { hasText: 'Ghost' }).first()
    await select(page, canvasRoot, badge)
    await page.getByRole('button', { name: 'Swap instance' }).click()
    await page.getByTestId('instance-swap-candidate-ProbeCard').click()

    await expect.poll(() => readFile('pages/Probe.tsx'), { timeout: 30_000 }).toContain('<ProbeCard variant="ghost" label="Ghost" />')
    const text = readFile('pages/Probe.tsx')
    expect(text, 'a named import of a default export does not compile').not.toContain('{ ProbeCard }')
    expect(text.match(/^import .*ProbeCard.* from /gm) ?? [], 'the file must bind ProbeCard exactly once').toHaveLength(1)
    expect(text).toContain("import ProbeCard from '../components/ProbeCard'")
  })
})
