import { expect, test, type Page } from '@playwright/test'
import { largeBoardPageId, openLargeBoardAtWorkingZoom, writeLargeBoardCorpus } from './helpers/largeBoardCorpus'
import { SELECTION_RING, selectInFrame, removeFixtureProject, type FixtureProject } from './helpers/studioFixtureProject'

/**
 * Opening the inspector must not move the board under the user, and the right
 * sidebar must not animate its width (2026-10-10 audit, edit-speed item 3).
 *
 * The sidebar used to take `flex-basis`/`width` transitions of 180 ms on the
 * first selection. The canvas root resized on every frame of it, which
 * re-rendered the board's frame layer and repainted both rulers each time.
 * Figma's panel is simply there; this one now is too: a selection changes the
 * sidebar's width in one step, and every frame stays where it was.
 *
 * Asserted on measured geometry (frames' bounding boxes, the sidebar's computed
 * transition), because happy-dom has no layout.
 */
const MAX_FRAME_DRIFT_PX = 1.5

test.use({ viewport: { width: 1920, height: 1080 } })

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = writeLargeBoardCorpus()
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

async function frameLefts(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-page-id]')]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth)
      .map((rect) => Math.round(rect.left * 10) / 10),
  )
}

test.describe('selecting an element opens the inspector without moving the board', () => {
  test.setTimeout(180_000)

  test('no frame moves, and the right sidebar has no width transition', async ({ page }) => {
    const { content } = await openLargeBoardAtWorkingZoom(page, fixture, largeBoardPageId(0))

    const sidebar = page.getByTestId('right-sidebar')
    const transition = await sidebar.evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(transition.split(',').every((duration) => parseFloat(duration) === 0), `sidebar transition-duration is "${transition}"`).toBe(true)

    await expect(sidebar).toHaveAttribute('data-expanded', 'false')
    const before = await frameLefts(page)
    expect(before.length).toBeGreaterThan(0)

    await selectInFrame(page, content.locator('.block__heading').nth(1))
    await expect(content.locator(SELECTION_RING).first()).toBeAttached({ timeout: 10_000 })
    await expect(sidebar).toHaveAttribute('data-expanded', 'true')
    await page.waitForTimeout(500)

    const after = await frameLefts(page)
    test.info().annotations.push({ type: 'perf', description: `frame lefts before ${before.join(',')} / after ${after.join(',')}` })
    console.log(`[edit-speed] frame lefts before: ${before.join(',')} after: ${after.join(',')}`)
    expect(after.length).toBe(before.length)
    for (let i = 0; i < before.length; i += 1) {
      expect(Math.abs(after[i] - before[i]), `frame ${i} moved ${after[i] - before[i]}px when the inspector opened`).toBeLessThanOrEqual(MAX_FRAME_DRIFT_PX)
    }
  })
})
