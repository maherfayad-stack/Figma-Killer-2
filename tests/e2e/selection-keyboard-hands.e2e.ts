import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WORKSPACE_ROOT } from './helpers/constants'
import {
  CANVAS_FRAME_IFRAME_SELECTOR,
  clickInFrame,
  createAuthoredFixtureProject,
  createFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * P2-B "selection and keyboard hands" (ROADMAP §6), in a real browser: the
 * keys and clicks happy-dom cannot drive, because they are about FOCUS and
 * about which document a keystroke is born in.
 *
 * Two fixtures, one per frame kind:
 *
 *   - **A board (portal) frame** — an authored project with no Vite, so every
 *     frame is Studio's own same-origin document. A row of three boxes and a
 *     `Card` component that contains a `Badge` component.
 *   - **A live (Tier 2 bridge) frame** — a copy of `test4`, whose frames run
 *     the real app cross-origin. Keys pressed with focus INSIDE that frame
 *     must reach the editor's one dispatcher, through the runtime's `key`
 *     message (`keyForwarding.ts`).
 *
 * What is asserted is what a user sees: where the in-frame selection ring is,
 * which Layers rows are selected, the canvas transform, and the inspector's
 * component section. Never a store call.
 *
 * NOT covered here: ERR-11's "Alt-Tab while holding Space". Playwright
 * emulates focus per page, so the window never really loses it — the unit
 * test (`selectionKeyboardHands.test.tsx`) drives the blur path instead.
 */

const RING = '[data-canvas-selection-ring]'
const TOLERANCE_PX = 4

const PORTAL_FIXTURE = '__e2e-p2b-hands-board'
const LIVE_FIXTURE = '__e2e-p2b-hands-live'

const PORTAL_CSS = `.page { padding: 24px; display: flex; flex-direction: column; gap: 24px; }
.row { display: flex; gap: 16px; }
.box { width: 64px; height: 64px; background: #5c6bc0; }
.card { padding: 16px; background: #eceff1; display: flex; gap: 12px; align-items: center; }
.card-title { margin: 0; font-size: 18px; }
.badge { display: inline-block; padding: 8px 12px; background: #ef6c00; color: #fff; }
`

const PORTAL_FILES: Record<string, string> = {
  'pages/Home.css': PORTAL_CSS,
  'pages/Home.tsx': `import './Home.css'
import { Card } from '../components/Card'

export default function Home() {
  return (
    <div className="page">
      <div className="row">
        <div className="box box-a" />
        <div className="box box-b" />
        <div className="box box-c" />
      </div>
      <Card />
    </div>
  )
}
`,
  'components/Card.tsx': `import { Badge } from './Badge'

export function Card() {
  return (
    <div className="card">
      <p className="card-title">Card</p>
      <Badge />
    </div>
  )
}
`,
  'components/Badge.tsx': `export function Badge() {
  return <span className="badge">New</span>
}
`,
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Every selection ring in the frame, in the frame's own CSS pixels. */
async function ringRects(content: FrameLocator): Promise<Rect[]> {
  return content.locator('body').evaluate((_body, selector: string) => {
    return Array.from(document.querySelectorAll(selector)).map((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
  }, RING)
}

async function rectOf(target: Locator): Promise<Rect> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
}

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= TOLERANCE_PX
  )
}

/** Waits until exactly one ring sits on `target`. */
async function expectRingOn(content: FrameLocator, target: Locator, message: string): Promise<void> {
  await expect
    .poll(async () => {
      const [rings, want] = await Promise.all([ringRects(content), rectOf(target)])
      return rings.length === 1 && sameRect(rings[0]!, want)
    }, { message, timeout: 10_000 })
    .toBe(true)
}

/** The canvas transform's scale, read off the element the user actually sees move. */
async function canvasScale(page: Page): Promise<number> {
  return page.getByTestId('canvas-transform-layer').evaluate((el) => {
    const match = /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)
    return match ? Number(match[1]) : NaN
  })
}

/**
 * The Layers panel's selected rows whose class badge contains `badge` — the
 * selection as a list, independent of whether a ring is currently on screen
 * (the canvas may have panned a selected node to the viewport's edge). The
 * badge filter keeps the selected PAGE row, which is a treeitem too, out.
 */
const selectedLayerRows = (page: Page, badge: string) =>
  page.locator('[role="treeitem"][aria-selected="true"]').filter({ hasText: badge })

/**
 * Playwright restarts the worker after a failed test and re-runs `beforeAll`,
 * while the dev server still holds the fixture directory open — Windows then
 * refuses the `rm` (EPERM). The directory from the first run is already the
 * fixture, so reuse it rather than fail every later test on cleanup.
 */
function fixtureOrExisting(name: string, make: () => FixtureProject): FixtureProject {
  try {
    return make()
  } catch (err) {
    const dir = path.join(WORKSPACE_ROOT, name)
    if (fs.existsSync(dir)) return { dir, ready: true }
    throw err
  }
}

/**
 * Double-click `target` where it is NOW. A selection can move the board
 * (`focusActiveBreakpoint` frames the selected node), so a point measured
 * before the first click can end up under a side panel — measured: the
 * status-bar clock slid under the Explorer and the double-click opened the
 * board-rename field instead. Re-centre, let it settle, then measure.
 */
async function dblclickInFrame(page: Page, canvasRoot: Locator, target: Locator): Promise<void> {
  await panIntoView(page, canvasRoot, target, 80)
  await page.waitForTimeout(400)
  const box = await target.boundingBox()
  expect(box, 'double-click target has no bounding box').not.toBeNull()
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

const componentSection = (page: Page) =>
  page.locator('[data-inspector-tab="design"]:not([hidden])').getByTestId('instance-component-section')

// ---------------------------------------------------------------------------
// A board (portal) frame
// ---------------------------------------------------------------------------

test.describe('P2-B on a board frame', () => {
  let fixture: FixtureProject
  test.beforeAll(() => {
    fixture = fixtureOrExisting(PORTAL_FIXTURE, () => createAuthoredFixtureProject(PORTAL_FIXTURE, PORTAL_FILES))
  })
  test.afterAll(() => removeFixtureProject(fixture))

  async function openHome(page: Page): Promise<{ canvasRoot: Locator; content: FrameLocator }> {
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = page.locator('[data-page-id]').first()
    await panIntoView(page, canvasRoot, frame)
    await expect(frame.locator(CANVAS_FRAME_IFRAME_SELECTOR)).toHaveCount(1, { timeout: 60_000 })
    const content = frame.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(content.locator('.box-a')).toBeVisible({ timeout: 30_000 })
    return { canvasRoot, content }
  }

  test('Tab and Shift+Tab cycle the siblings; Shift-click toggles; Cmd/Ctrl+A selects siblings then climbs', async ({ page }) => {
    const { content } = await openHome(page)
    const [a, b, c] = [content.locator('.box-a'), content.locator('.box-b'), content.locator('.box-c')]

    await clickInFrame(page, a)
    await expectRingOn(content, a, 'a click on the first box did not ring it')

    // IX-3 — focus is inside the frame (the click put it there), so this Tab
    // is born in the frame document and crosses through the key relay.
    await page.keyboard.press('Tab')
    await expectRingOn(content, b, 'Tab did not move the selection to the next sibling')
    await page.keyboard.press('Shift+Tab')
    await expectRingOn(content, a, 'Shift+Tab did not move the selection back')
    await page.keyboard.press('Shift+Tab')
    await expectRingOn(content, c, 'Shift+Tab did not wrap to the last sibling')

    // IX-2 — Shift-click toggles: adds `a` (a tree RANGE would also have
    // swept `b` in), and a second Shift-click removes it again.
    await page.keyboard.down('Shift')
    await clickInFrame(page, a)
    await page.keyboard.up('Shift')
    await expect(selectedLayerRows(page, '.box'), 'Shift-click did not ADD exactly one node').toHaveCount(2)
    await page.keyboard.down('Shift')
    await clickInFrame(page, a)
    await page.keyboard.up('Shift')
    await expectRingOn(content, c, 'a second Shift-click did not toggle the node back out')

    // IX-4 — ⌘/Ctrl+A: the three siblings, then one level up.
    await page.keyboard.press('ControlOrMeta+a')
    await expect(selectedLayerRows(page, '.box'), '⌘A did not select the three siblings').toHaveCount(3)
    await page.keyboard.press('ControlOrMeta+a')
    await expect(selectedLayerRows(page, '.row'), "a second ⌘A did not climb to the row's level").toHaveCount(1)
    await expect(selectedLayerRows(page, '.box')).toHaveCount(0)
  })

  test('the zoom keys work with focus in a panel', async ({ page }) => {
    const { content } = await openHome(page)
    await clickInFrame(page, content.locator('.box-a'))

    // Put focus in the inspector — the move that used to kill the zoom keys
    // for the session (a React onKeyDown on the canvas div).
    const designTab = page.getByRole('tab', { name: 'Design' })
    await expect(designTab).toBeVisible({ timeout: 15_000 })
    await designTab.click()
    await expect(designTab).toBeFocused()

    const before = await canvasScale(page)
    await page.keyboard.press('-')
    await expect.poll(() => canvasScale(page), { message: '− did not zoom out with focus in a panel' }).toBeLessThan(before)
    await page.keyboard.press('Shift+0')
    await expect.poll(() => canvasScale(page), { message: '⇧0 did not zoom to 100%' }).toBe(1)
  })

  test('a click inside nested components selects the outer one; a double-click opens one level', async ({ page }) => {
    const { canvasRoot, content } = await openHome(page)
    const badge = content.locator('.badge')
    await clickInFrame(page, badge)
    await expect(componentSection(page), 'a click on the badge did not select the Card instance').toContainText('Card', { timeout: 15_000 })

    await dblclickInFrame(page, canvasRoot, badge)
    await expect(componentSection(page), 'a double-click did not open Card and select the Badge instance').toContainText('Badge', { timeout: 15_000 })
  })
})

// ---------------------------------------------------------------------------
// A live (Tier 2 bridge) frame
// ---------------------------------------------------------------------------

test.describe('P2-B on a live frame', () => {
  let fixture: FixtureProject
  test.beforeAll(() => {
    fixture = fixtureOrExisting(LIVE_FIXTURE, () => createFixtureProject('test4', LIVE_FIXTURE))
  })
  test.afterAll(() => removeFixtureProject(fixture))

  /** The SMS frame once its BRIDGE iframe (the real app) has taken over from the fallback. */
  async function openLiveSms(page: Page): Promise<{ canvasRoot: Locator; content: FrameLocator }> {
    test.skip(!fixture.ready, 'studio-workspace/test4 is not on disk')
    const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
    const frame = page.locator('[data-page-id="sms"]').first()
    await expect(frame, 'the test4 board has no SMS frame').toBeAttached({ timeout: 30_000 })
    await panIntoView(page, canvasRoot, frame)
    // A live board frame shows a Tier-0 fallback until its bridge iframe is
    // ready, so two canvas iframes coexist for a while — wait for the bridge.
    const bridge = frame.locator('[data-testid="live-board-frame-bridge"]:not([hidden])')
    await expect(bridge, 'the SMS frame never switched to its live (bridge) iframe').toBeVisible({ timeout: 120_000 })
    const content = bridge.frameLocator(CANVAS_FRAME_IFRAME_SELECTOR)
    await expect(content.locator('[class*="resendRun"]')).toBeVisible({ timeout: 60_000 })
    return { canvasRoot, content }
  }

  test('keys pressed with focus INSIDE the live frame reach the editor', async ({ page }) => {
    const { canvasRoot, content } = await openLiveSms(page)
    const run = content.locator('[class*="resendRun"]')
    const caption = content.locator('[class*="strongCaption"]')
    await panIntoView(page, canvasRoot, run, 80)

    await clickInFrame(page, run)
    await expectRingOn(content, run, 'a click on the resend text did not ring it')

    // Put real DOM focus inside the cross-origin frame, as an inline text
    // edit leaves it. From here a native keydown is born in the frame's
    // document and nowhere else.
    await content.locator('body').evaluate((body) => {
      body.setAttribute('tabindex', '-1')
      ;(body as HTMLElement).focus()
    })

    await page.keyboard.press('Tab')
    await expectRingOn(content, caption, 'Tab inside the live frame did not select the next sibling')

    const before = await canvasScale(page)
    await page.keyboard.press('-')
    await expect.poll(() => canvasScale(page), { message: '− inside the live frame did not zoom the canvas' }).toBeLessThan(before)
  })

  test('a click inside a component in a live frame selects the outermost instance', async ({ page }) => {
    const { canvasRoot, content } = await openLiveSms(page)
    // The status-bar clock: inside IOSStatusBar, inside SheetHeader.
    const clock = content.getByText('9:41', { exact: true })
    await panIntoView(page, canvasRoot, clock, 80)
    await clickInFrame(page, clock)
    await expect(componentSection(page), 'a click on the clock did not select SheetHeader').toContainText('SheetHeader', { timeout: 15_000 })

    await dblclickInFrame(page, canvasRoot, clock)
    await expect(componentSection(page), 'a double-click did not open SheetHeader and select IOSStatusBar').toContainText('IOSStatusBar', { timeout: 15_000 })
  })
})
