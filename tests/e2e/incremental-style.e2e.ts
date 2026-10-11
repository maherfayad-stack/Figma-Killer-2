import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect, test, type Frame, type Page } from '@playwright/test'
import { traceEditCost, type EditCost } from './helpers/cdpTrace'
import { largeBoardPageId, openLargeBoardAtWorkingZoom, SCALE_BOARD_SHAPE, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { panIntoView, removeFixtureProject, selectInFrame, type FixtureProject } from './helpers/studioFixtureProject'

/**
 * SB-7 — incremental style (`docs/programs/board-speed.md`).
 *
 * A class edit used to rewrite the whole `<style id="mc-classes">` text in
 * EVERY mounted frame, which makes the browser throw the sheet away, reparse it
 * and restyle every element the old and new sheets could match. The edit is now
 * applied as a rule-level CSSOM diff (`overlayRuleDiff.ts`), so the browser
 * invalidates only the elements the changed rule matches.
 *
 * The board is the 100-frame x ~140-element scale corpus. Three of its
 * screens use a class (`.screen__special`) no other screen uses; that is the
 * class the spec edits. Asserted on COMPUTED style and on CSSOM rule identity,
 * because happy-dom has no style engine and cannot fail on either.
 *
 * Run: `E2E_VITE_MODE=preview bun run test:e2e tests/e2e/incremental-style.e2e.ts`
 */
/** `CLASS_CSS_APPLY_MEASURE` in `ClassStyleInjector.tsx`; a spec cannot import app source through the test runner's alias set. */
const CLASS_CSS_APPLY_MEASURE = 'studio:class-css-apply'
const SPECIAL_SCREENS = [0, 1, 2]
/**
 * Classes edited once before the measurement. An imported class only enters the
 * `mc-classes` overlay after a session edit, so without this the overlay holds a
 * single rule and a whole-sheet rewrite costs the same as a rule edit. Together
 * they cover every element of every screen: the board of a user who has styled
 * a design, which is the board this change is for.
 */
const PRIMED_CLASSES = [
  'screen', 'screen__bar', 'screen__badge', 'block', 'block__heading', 'block__body', 'block__rows', 'row', 'row__label', 'row__value',
]
const EDIT_WIDTHS = ['140px', '180px', '220px']

test.use({ viewport: { width: 1920, height: 1080 } })
test.describe.configure({ timeout: 300_000 })

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = writeLargeBoardCorpus({ ...SCALE_BOARD_SHAPE, name: '__incremental-style-corpus' })
  for (const index of SPECIAL_SCREENS) {
    const file = path.join(fixture.dir, 'pages', `Screen${String(index + 1).padStart(2, '0')}.tsx`)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('className="screen__title"', 'className="screen__special"'), 'utf8')
  }
  const css = path.join(fixture.dir, 'pages', 'corpus.css')
  fs.appendFileSync(css, '.screen__special { font-weight: 600; width: 100px; }\n')
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

function annotate(label: string, value: string): void {
  test.info().annotations.push({ type: 'perf', description: `${label}: ${value}` })
  console.log(`[sb-7] ${label}: ${value}`)
}

async function setWidth(page: Page, value: string): Promise<void> {
  const field = page.getByTestId('css-size-input-width').getByRole('textbox', { name: 'Width' })
  await field.click()
  await field.press('ControlOrMeta+a')
  await field.fill(value)
  await field.press('Enter')
}

interface FrameProbe {
  usesSpecial: boolean
  /** Computed style of a sample of elements, as one string. */
  computed: string
  specialWidth: string | null
}

function mountedContentFrames(page: Page): Frame[] {
  return page.frames().filter((frame) => frame !== page.mainFrame() && frame.parentFrame() === page.mainFrame())
}

/** Reads computed style; with `remember`, also keeps the live `mc-classes` rule objects on the window. */
async function probeFrame(frame: Frame, remember: boolean): Promise<FrameProbe | null> {
  try {
    return await frame.evaluate((rememberRules) => {
      const style = document.querySelector<HTMLStyleElement>('[data-studio-overlay-id="mc-classes"]')
      const sample = Array.from(document.querySelectorAll('[data-node-id]')).slice(0, 80)
      const props = ['width', 'height', 'color', 'background-color', 'font-weight', 'font-size', 'padding-top', 'margin-top', 'display']
      const computed = sample
        .map((el) => {
          const cs = getComputedStyle(el)
          return props.map((p) => cs.getPropertyValue(p)).join(',')
        })
        .join('|')
      const special = document.querySelector('.screen__special')
      if (rememberRules) {
        const flatten = (list: CSSRuleList | undefined): CSSRule[] =>
          Array.from(list ?? []).flatMap((rule) => [rule, ...flatten((rule as CSSGroupingRule).cssRules)])
        ;(window as unknown as { __sb7Rules: CSSRule[] }).__sb7Rules = flatten(style?.sheet?.cssRules)
      }
      return {
        usesSpecial: special !== null,
        computed,
        specialWidth: special ? getComputedStyle(special).width : null,
      }
    }, remember)
  } catch {
    return null
  }
}

/** How many of the remembered `mc-classes` rule objects are still the live ones, by identity. */
async function survivingRules(frame: Frame): Promise<{ before: number; surviving: number }> {
  return frame.evaluate(() => {
    const before = (window as unknown as { __sb7Rules?: CSSRule[] }).__sb7Rules ?? []
    const style = document.querySelector<HTMLStyleElement>('[data-studio-overlay-id="mc-classes"]')
    const flatten = (list: CSSRuleList | undefined): CSSRule[] =>
      Array.from(list ?? []).flatMap((rule) => [rule, ...flatten((rule as CSSGroupingRule).cssRules)])
    const now = new Set(flatten(style?.sheet?.cssRules))
    return { before: before.length, surviving: before.filter((rule) => now.has(rule)).length }
  })
}

function summarize(cost: EditCost): string {
  return (
    `style ${cost.styleMs.toFixed(1)} ms (${cost.styleEvents} recalcs, ${cost.styleElements} elements, ${cost.framesRestyled} frames), ` +
    `scripting ${cost.scriptingMs.toFixed(1)} ms, layout ${cost.layoutMs.toFixed(1)} ms, tasks ${cost.taskMs.toFixed(1)} ms (longest ${cost.longestTaskMs.toFixed(1)})`
  )
}

test('a class edit restyles only the frames that use the class, and the others keep all but the edited rule', async ({ page }) => {
  const { canvasRoot, content } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))
  for (const name of PRIMED_CLASSES) {
    const target = content.locator(`.${name}`).first()
    await panIntoView(page, canvasRoot, target, 120)
    await selectInFrame(page, target)
    await expect(page.getByTestId(`class-chip-${name}`)).toBeVisible({ timeout: 15_000 })
    await setWidth(page, '99%')
  }
  const special = content.locator('.screen__special').first()
  await panIntoView(page, canvasRoot, special, 120)
  await selectInFrame(page, special)
  await expect(page.getByTestId('class-chip-screen__special')).toBeVisible({ timeout: 15_000 })

  // Warm-up edit: the first edit to an imported rule moves it into the overlay.
  await setWidth(page, '120px')
  await expect.poll(() => special.evaluate((el) => getComputedStyle(el).width)).toBe('120px')
  await page.waitForTimeout(800)

  const before = new Map<Frame, FrameProbe>()
  for (const frame of mountedContentFrames(page)) {
    const probe = await probeFrame(frame, true)
    if (probe) before.set(frame, probe)
  }
  const users = [...before.values()].filter((probe) => probe.usesSpecial).length
  annotate('mounted frames', `${before.size} (${users} use the edited class)`)
  expect(before.size).toBeGreaterThan(1)

  const costs: EditCost[] = []
  for (const width of EDIT_WIDTHS) {
    await page.evaluate((name) => performance.clearMeasures(name), CLASS_CSS_APPLY_MEASURE)
    const cost = await traceEditCost(page, async () => {
      await setWidth(page, width)
      await page.waitForTimeout(600)
    })
    costs.push(cost)
    const applied = await page.evaluate(
      (name) => performance.getEntriesByName(name).map((entry) => entry.duration),
      CLASS_CSS_APPLY_MEASURE,
    )
    annotate(
      `class-css writes for ${width}`,
      `${applied.length} frame writes, ${applied.reduce((sum, ms) => sum + ms, 0).toFixed(1)} ms in the injector`,
    )
    annotate(`edit to ${width}`, summarize(cost))
  }
  const median = (pick: (c: EditCost) => number) => costs.map(pick).sort((a, b) => a - b)[Math.floor(costs.length / 2)] ?? 0
  annotate(
    'median of 3 edits',
    `style ${median((c) => c.styleMs).toFixed(1)} ms, scripting ${median((c) => c.scriptingMs).toFixed(1)} ms, elements ${median((c) => c.styleElements)}, frames restyled ${median((c) => c.framesRestyled)}`,
  )

  let verified = 0
  for (const [frame, was] of before) {
    const now = await probeFrame(frame, false)
    if (!now) continue
    if (was.usesSpecial) {
      expect(now.specialWidth, 'a frame using the class shows the new width').toBe(EDIT_WIDTHS[EDIT_WIDTHS.length - 1])
    } else {
      expect(now.computed, 'a frame that does not use the class is not restyled').toBe(was.computed)
      const { before: total, surviving } = await survivingRules(frame)
      expect(surviving, 'a frame that does not use the class keeps every one of its rule objects').toBe(total - 1)
      verified += 1
    }
  }
  annotate('unaffected frames verified', String(verified))
})
