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
 * G-2b - a class-styled value edited inside ONE instance of a shared component
 * changes that instance and no other, in a real browser, on a real project.
 *
 * Three `<Tier>` cards share `.tier { padding: 8px }`. The user selects the
 * middle one, types a new padding in the inspector, and:
 *
 *   - the middle card's computed padding changes and the other two stay put
 *     (read off the rendered frame, not off the store);
 *   - on disk the component's own rule is untouched, the page's call site gains a
 *     modifier class, the component's root takes `className`, and the stylesheet
 *     gains `.tier.tier-home-2`;
 *   - "Apply to all (3)" then moves the value into `.tier` and removes the
 *     modifier, and all three cards show it.
 *
 * SAFETY - this spec WRITES, so the fixture is created fresh under this RUN's
 * throwaway copy of `studio-workspace/` and removed afterwards.
 */

const TIER_TSX = `import './Tier.css'

interface TierProps { name: string; price: number }

export function Tier({ name, price }: TierProps) {
  return (
    <section className="tier">
      <h3 className="tier__name">{name}</h3>
      <p className="tier__price">{price}</p>
    </section>
  )
}
`

const TIER_CSS = `.tier {
  padding: 8px;
  border: 1px solid #ccc;
}

.tier__name {
  font-weight: 600;
}
`

const HOME_TSX = `import { Tier } from '../components/Tier'

export default function Home() {
  return (
    <main>
      <Tier name="Basic" price={5} />
      <Tier name="Plus" price={9} />
      <Tier name="Pro" price={19} />
    </main>
  )
}
`

let fixture: FixtureProject

const read = (rel: string): string => fs.readFileSync(path.join(fixture.dir, ...rel.split('/')), 'utf8')

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-class-override', {
    'components/Tier.tsx': TIER_TSX,
    'components/Tier.css': TIER_CSS,
    'pages/Home.tsx': HOME_TSX,
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function openBoard(page: Page): Promise<{ canvasRoot: Locator; contentFrame: FrameLocator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame), 'the fixture frame never mounted a live canvas iframe').toBeVisible({ timeout: 60_000 })
  return { canvasRoot, contentFrame: canvasContentFrame(frame) }
}

/** The computed padding-top of each rendered tier, in board order. */
async function paddings(contentFrame: FrameLocator): Promise<string[]> {
  return contentFrame.locator('.tier').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).paddingTop))
}

test.describe('G-2b - a class edit inside one instance changes only that instance', () => {
  test.setTimeout(240_000)

  test('three cards, one padding change: only the selected card moves; Apply to all moves the rest', async ({ page }) => {
    const { canvasRoot, contentFrame } = await openBoard(page)
    expect(read('components/Tier.css')).toBe(TIER_CSS)
    await expect.poll(() => paddings(contentFrame), { message: 'the three cards never rendered at 8px' }).toEqual(['8px', '8px', '8px'])

    const second = contentFrame.locator('.tier').nth(1)
    await panIntoView(page, canvasRoot, second, 80)
    await selectInFrame(page, second)
    // A click selects the instance; Enter steps into it, onto the element the component returns.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('class-chip-tier'), 'stepping into the instance never bound the inspector to .tier').toBeVisible({ timeout: 20_000 })

    const field = page.getByTestId('css-padding-all')
    // Padding lives in the Layout section, collapsed until opened.
    if (!(await field.isVisible())) await page.getByText('Layout', { exact: true }).first().click()
    await expect(field, 'the inspector did not offer a padding control for the selected card').toBeVisible({ timeout: 20_000 })
    const input = field.getByRole('textbox').first()
    await input.click()
    await input.press('ControlOrMeta+a')
    await input.fill('24px')
    await input.press('Enter')

    // The rendered frame: only the middle card changed.
    await expect.poll(() => paddings(contentFrame), { message: 'only the selected card may take the new padding', timeout: 30_000 }).toEqual(['8px', '24px', '8px'])

    // The files: the component's own rule is untouched, the instance has a modifier class.
    await expect.poll(() => read('components/Tier.css'), { message: 'the modifier rule never reached Tier.css', timeout: 30_000 }).toContain('.tier.tier-home-2')
    expect(read('components/Tier.css')).toBe(
      `.tier {\n  padding: 8px;\n  border: 1px solid #ccc;\n}\n\n.tier.tier-home-2 {\n  padding: 24px;\n}\n\n.tier__name {\n  font-weight: 600;\n}\n`,
    )
    expect(read('pages/Home.tsx')).toContain('<Tier name="Plus" price={9} className="tier-home-2" />')
    expect(read('pages/Home.tsx')).toContain('<Tier name="Basic" price={5} />')
    expect(read('components/Tier.tsx')).toContain('className={`tier ${className || \'\'}`}')

    // Nothing was raised as an error; the notice says it was this card alone.
    await expect(page.locator('[role="alert"]', { hasText: /not saved|could not/i })).toHaveCount(0)
    const applyToAll = page.getByRole('button', { name: /Apply to all \(3\)/ })
    await expect(applyToAll).toBeVisible({ timeout: 15_000 })
    await applyToAll.click()

    await expect.poll(() => read('components/Tier.css'), { message: 'Apply to all never reached Tier.css', timeout: 30_000 }).toBe(
      `.tier {\n  padding: 24px;\n  border: 1px solid #ccc;\n}\n\n.tier__name {\n  font-weight: 600;\n}\n`,
    )
    expect(read('pages/Home.tsx')).toContain('<Tier name="Plus" price={9} />')
    await expect.poll(() => paddings(contentFrame), { message: 'every card should show the promoted padding', timeout: 30_000 }).toEqual(['24px', '24px', '24px'])
  })
})
