import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import {
  clickInFrame,
  createFixtureProject,
  frameForPage,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame } from './helpers/canvasIframe'

/**
 * P1-F "Undo tells the truth" — ERR-1, in a real browser.
 *
 * Enter commits an inspector number and KEEPS focus (Figma), so the caret is
 * usually parked in a field with nothing left to commit. ⌘Z from a parked
 * field is editor undo (`pendingTextEdit.ts`: no uncommitted draft). Before
 * the fix, the field kept showing the value the undo had just removed, and the
 * click-away blur wrote it straight back — the undo was undone and the redo
 * stack was cleared. The unit test (`scrubInput.test.tsx`) pins the component;
 * this pins the whole road: real focus, real keyboard routing, real blur.
 *
 * Runs against a throwaway copy of `studio-workspace/test4`, the corpus the
 * other Studio specs drive, with autosave off so the only writes are the
 * store's own.
 */

const FIXTURE_NAME = '__e2e-undo-truth'
const PAGE_ID = 'sms'
/** Leaves written in the page's OWN file: a click on an inlined component's markup selects the instance, not the leaf. */
const OWN_LEAF = '[data-node-id^="pages/SMS.tsx:"]:not(:has([data-node-id]))'

let fixture: FixtureProject = { dir: '', ready: false }

test.beforeEach(() => {
  fixture = createFixtureProject('test4', FIXTURE_NAME)
})

test.afterAll(() => {
  removeFixtureProject(fixture)
})

/** The first own-file leaf big enough to click. */
async function ownLeaf(contentFrame: FrameLocator) {
  const candidates = contentFrame.locator(OWN_LEAF)
  await expect(candidates.first(), 'the frame rendered no leaf written in pages/SMS.tsx').toBeVisible({ timeout: 30_000 })
  const count = await candidates.count()
  for (let i = 0; i < count; i += 1) {
    const box = await candidates.nth(i).boundingBox().catch(() => null)
    if (box && box.width >= 12 && box.height >= 12) return candidates.nth(i)
  }
  throw new Error('no own-file leaf in the frame is large enough to click')
}

/** Select `nodeId` and wait for the Properties panel to offer its Width field. */
async function selectForWidth(page: Page, contentFrame: FrameLocator, nodeId: string) {
  await clickInFrame(page, contentFrame.locator(`[data-node-id="${nodeId}"]`).first())
  const width = page.getByRole('textbox', { name: 'Width', exact: true }).first()
  await expect(width, 'selecting the element showed no Width field in the Properties panel').toBeVisible({ timeout: 15_000 })
  return width
}

test.describe('Undo tells the truth (P1-F)', () => {
  test.setTimeout(300_000)

  test.beforeEach(() => {
    test.skip(!fixture.ready, 'studio-workspace/test4 is not present on disk, so the throwaway fixture could not be made')
  })

  test('a width typed, entered and undone is not written back when the user clicks away (ERR-1)', async ({ page }) => {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = await frameForPage(page, canvasRoot, PAGE_ID)
    const contentFrame = canvasContentFrame(frame)
    const leaf = await ownLeaf(contentFrame)
    const nodeId = await leaf.getAttribute('data-node-id')
    expect(nodeId, 'the leaf carries no node id').not.toBeNull()
    await panIntoView(page, canvasRoot, leaf, 120)
    const width = await selectForWidth(page, contentFrame, nodeId!)
    const height = page.getByRole('textbox', { name: 'Height', exact: true }).first()
    const before = await width.inputValue()
    const typed = before === '123px' ? '124px' : '123px'

    await width.click()
    await width.fill(typed)
    await width.press('Enter')
    await expect(width).toBeFocused()
    await expect(width).toHaveValue(typed)

    // ⌘Z from the parked caret is the EDITOR's undo — the field follows it.
    await page.keyboard.press('Control+z')
    await expect(width, 'the parked field did not follow the undo').toHaveValue(before, { timeout: 10_000 })

    // Click-away — onto the next field, so the selection (and this field)
    // stays: the blur that used to write the stale value back.
    await height.click()
    await expect(width).not.toBeFocused()
    await expect(width, 'blurring a parked field wrote the undone value back').toHaveValue(before)

    // …and the redo stack survived, because nothing was written over it.
    await canvasRoot.focus()
    await page.keyboard.press('Control+Shift+z')
    await expect(width, 'the redo stack was cleared by a phantom commit').toHaveValue(typed, { timeout: 10_000 })
  })
})
