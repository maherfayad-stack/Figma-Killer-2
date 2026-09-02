import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Adding a design-system component to a studio board, and rendering one with
 * its own package CSS. Two defects, both of which only a real browser can see.
 *
 *   1. **Vendor CSS was annihilated by the publisher reset.** Every `@alm-design`
 *      / `pkg.*` component on the board rendered as unstyled text. The classes
 *      and the 120 KB of package CSS were both present and correct — but the
 *      reset was emitted inside `@layer user-authored`, one cascade layer ABOVE
 *      `@layer vendor`, and layer order beats specificity outright. So
 *      `:where(*) { padding: 0 }` beat `.btn { padding: 12px 22px }` despite
 *      having zero specificity, which is the exact opposite of what `:where()`
 *      is for. A unit test cannot catch this: happy-dom does not resolve
 *      cascade layers, and every string assertion about the CSS passed while
 *      the button was invisible. Only `getComputedStyle` in a real engine
 *      distinguishes "the rule is in the document" from "the rule applies".
 *
 *   2. **Insert was refused outright.** Picking a component from "Add to canvas"
 *      toasted "Studio cannot add a new element to imported code yet" and did
 *      nothing. It now writes the element AND its import into the `.tsx` and
 *      the board re-reads it, so what lands on the canvas is a real parsed node
 *      with a `rel:line:col` id — asserted here against the bytes on disk,
 *      because the tree updating is precisely what used to happen without the
 *      file ever changing.
 *
 * SAFETY — this spec WRITES, so it never points at real user data. The fixture
 * is created fresh in an OS temp directory, opened by absolute path, and removed
 * afterwards. Nothing under `studio-workspace/` is read or written.
 */

const CANVAS_FRAME_IFRAME_SELECTOR = 'iframe[title^="Canvas frame"]'
const DS = '@alm-design/design-system'

/**
 * Two components already in the source, so the render assertions have something
 * that came through the ordinary parse, and the insert has a real sibling to be
 * appended after.
 */
const FIXTURE_PAGE = `import { Button, Chip } from '@alm-design/design-system'

export default function Home() {
  return (
    <div className="wrap">
      <Button variant="primary" label="Existing button" />
      <Chip label="Existing chip" />
    </div>
  )
}
`

let fixtureDir: string

const pagePath = (): string => path.join(fixtureDir, 'pages', 'Home.tsx')
const readPage = (): string => fs.readFileSync(pagePath(), 'utf8')

test.beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ds-insert-'))
  fs.mkdirSync(path.join(fixtureDir, 'pages'), { recursive: true })
  fs.writeFileSync(pagePath(), FIXTURE_PAGE, 'utf8')
})

test.afterAll(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
})

/** Open the studio board on the temp fixture. Safe to write only because `fixtureDir` is a throwaway. */
async function openStudioBoard(page: Page, projectDir: string): Promise<FrameLocator> {
  await page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
    window.localStorage.setItem('studio-editor-prefs', JSON.stringify({ autoSave: true }))
  }, projectDir)

  await page.goto('/admin/site?studio')
  await expect(page.getByTestId('canvas-root')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('board-frames-layer')).toBeAttached({ timeout: 90_000 })
  const frame = page.locator('[data-page-id]').first()
  await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toBeVisible({ timeout: 30_000 })
  return frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
}

test.describe('design-system components on a studio board', () => {
  // A cold ts-morph parse on open, a source write, and a reload.
  test.setTimeout(180_000)

  test('package CSS actually applies — the reset must not outrank @layer vendor', async ({ page }) => {
    const contentFrame = await openStudioBoard(page, fixtureDir)

    const button = contentFrame.locator('button.btn').first()
    await expect(button).toBeVisible({ timeout: 15_000 })

    const computed = await button.evaluate((el) => {
      const style = el.ownerDocument.defaultView!.getComputedStyle(el)
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        padding: style.padding,
        fontFamily: style.fontFamily,
      }
    })

    // The exact values come from `@alm-design/design-system`'s own
    // `.btn--primary` rule. Asserting them (rather than merely "not the
    // default") is what proves the VENDOR layer won, not just that something
    // did — a stray editor-chrome rule could otherwise satisfy a loose check.
    expect(computed.backgroundColor, 'the button has no fill — vendor CSS lost to the reset').not.toBe(
      'rgba(0, 0, 0, 0)',
    )
    expect(computed.color, 'the label kept the inherited colour — `:where(button) { color: inherit }` won').not.toBe(
      'rgb(0, 0, 0)',
    )
    expect(computed.padding, 'the button has no padding — `:where(*) { padding: 0 }` won').not.toBe('0px')
    expect(computed.fontFamily, 'the button kept the reset font — `:where(input, button) { font: inherit }` won').toContain(
      'Open Sans',
    )

    // The layer pre-declaration every canvas stylesheet repeats: `reset` must be
    // declared FIRST, which is what makes it lose to both layers above it.
    const layerOrder = await contentFrame
      .locator('#mc-classes')
      .evaluate((el) => (el.textContent ?? '').split('\n')[0])
    expect(layerOrder).toBe('@layer reset, vendor, user-authored;')
  })

  test('inserting a component from the picker writes the .tsx and comes back as a real node', async ({ page }) => {
    const contentFrame = await openStudioBoard(page, fixtureDir)
    expect(readPage(), 'the fixture was modified before the test ran').toBe(FIXTURE_PAGE)

    await page.getByTestId('canvas-notch-add-btn').click()
    const dialog = page.getByRole('dialog', { name: 'Add to canvas' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.locator('[data-module-id="alm.Button"]').first().click()

    // The write is what makes the board reload, so waiting for the new node in
    // the canvas is waiting for the whole round trip.
    const inserted = contentFrame.locator('[data-module-id="alm.Button"]').nth(1)
    await expect(inserted, 'the inserted component never reached the canvas').toBeVisible({ timeout: 60_000 })

    // It is a REAL parsed node — a source location, not a canvas-minted nanoid.
    const nodeId = await inserted.getAttribute('data-node-id')
    expect(nodeId, 'the inserted node is not source-derived').toMatch(/^pages\/Home\.tsx:\d+:\d+$/)

    // …and it renders through the design system, styled, not as bare text.
    await expect(inserted.locator('button.btn')).toBeVisible()

    // The bytes on disk are the actual claim. Everything the fixture already
    // had survives verbatim; the import gains one name, the JSX one line.
    expect(readPage()).toBe(
      `import { Button, Chip } from '@alm-design/design-system'

export default function Home() {
  return (
    <div className="wrap">
      <Button variant="primary" label="Existing button" />
      <Chip label="Existing chip" />
      <Button dir="ltr" label="Button" size="default" variant="primary" />
    </div>
  )
}
`,
    )
    expect(readPage(), 'the import was duplicated instead of reused').not.toContain(`\nimport { Button } from '${DS}'`)
  })
})
