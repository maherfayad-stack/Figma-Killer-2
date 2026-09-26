import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { WORKSPACE_ROOT } from './helpers/constants'
import { liveBridgeIframe } from './helpers/canvasIframe'
import {
  clickInFrame,
  createFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  type FixtureProject,
} from './helpers/studioFixtureProject'

/**
 * Live-frame parity — gestures Phase 1 and 2 fixed in static (portal) frames,
 * asserted on a LIVE (Tier 2, Vite) frame, on computed layout
 * (`standing-02`: happy-dom lays nothing out, so the unit tests in
 * `src/__tests__/studio-runtime/liveFrameParity.test.ts` cannot fail on what
 * these measure):
 *
 *   - store-17: a delete the server refuses is taken back IN THE FRAME — the
 *     element renders again, although no HMR follows a write that did not land;
 *   - canvas-23: a drag on a handle at the very bottom of the frame never grows
 *     the frame by the W×H badge hanging under it;
 *   - canvas-23: a `flex: 1` code input resized in the frame renders at the
 *     dragged width, during the drag and after the HMR — not the width
 *     flexbox hands back;
 *   - canvas-26: a resize edge snaps to a sibling's edge within 8 SCREEN px.
 *
 * One throwaway copy of `studio-workspace/test4` for the whole file (a live
 * frame costs a cold Vite start), with the SMS frame's stored height removed
 * so the frame HUGS its content — the only state in which the badge could
 * grow it. The cases touch different elements and run in order.
 */

const FIXTURE_NAME = '__e2e-live-frame-parity'

let fixture: FixtureProject

/** Playwright re-runs `beforeAll` after a failure while the dev server still holds the directory — reuse it then (Windows refuses the `rm`). */
function fixtureOrExisting(make: () => FixtureProject): FixtureProject {
  try {
    return make()
  } catch (err) {
    const dir = path.join(WORKSPACE_ROOT, FIXTURE_NAME)
    if (fs.existsSync(dir)) return { dir, ready: true }
    throw err
  }
}

/** The SMS frame hugs its content: a stored height would pin the frame box and hide what the badge does to it. */
function unpinSmsFrameHeight(dir: string): void {
  const file = path.join(dir, '.studio', 'boards.json')
  const boards = JSON.parse(fs.readFileSync(file, 'utf8')) as { boards: Array<{ frames: Array<{ pageId: string; height?: number }> }> }
  for (const board of boards.boards) {
    for (const frame of board.frames) if (frame.pageId === 'sms') delete frame.height
  }
  fs.writeFileSync(file, `${JSON.stringify(boards, null, 2)}\n`)
}

/**
 * Whether the copy can boot a LIVE frame at all: Tier 2 needs a lockfile
 * (`liveCapability.ts`) and an installed tree with Vite in it
 * (`devServer.ts`). The tracked `test4` has neither — committing an installed
 * tree is what `.gitignore`'s studio-workspace section forbids — so on a clean
 * checkout every case here skips with that reason instead of timing out on a
 * bridge iframe that can never appear. An owner's local `test4` with
 * `node_modules` runs them.
 */
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
function canBootLiveFrame(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'node_modules', 'vite')) && LOCKFILES.some((file) => fs.existsSync(path.join(dir, file)))
}

const readSms = () => fs.readFileSync(path.join(fixture.dir, 'pages', 'SMS.tsx'), 'utf8')

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  cssWidth: string
  display: string
}

/** The element's rendered box and computed CSS, in the frame's own px. */
function measure(element: Locator): Promise<Box> {
  return element.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cssWidth: cs.width, display: cs.display }
  })
}

const near = (actual: number, expected: number, message: string) =>
  expect(Math.abs(actual - expected), `${message} (got ${actual}, wanted ${expected})`).toBeLessThanOrEqual(1)

interface LiveSms {
  canvasRoot: Locator
  frame: Locator
  content: FrameLocator
}

/** The SMS frame once its BRIDGE iframe (the real app) has taken over from the fallback. */
async function openLiveSms(page: Page): Promise<LiveSms> {
  test.skip(!fixture.ready, 'studio-workspace/test4 is not on disk')
  test.skip(!canBootLiveFrame(fixture.dir), 'test4 has no lockfile + installed Vite, so no live frame can boot (see canBootLiveFrame)')
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: true })
  const frame = page.locator('[data-page-id="sms"]').first()
  await expect(frame, 'the test4 board has no SMS frame').toBeAttached({ timeout: 30_000 })
  await panIntoView(page, canvasRoot, frame)
  // A live board frame shows a Tier-0 fallback until its bridge iframe is
  // ready, so two canvas iframes coexist for a while — wait for the bridge.
  const bridge = liveBridgeIframe(frame)
  await expect(bridge, 'the SMS frame never switched to its live (bridge) iframe').toBeVisible({ timeout: 120_000 })
  const content = bridge.contentFrame()
  await expect(content.locator('[class*="codeInput"]').first()).toBeVisible({ timeout: 60_000 })
  return { canvasRoot, frame, content }
}

/** Select `element` in the live frame and wait for the runtime's own handles on it. */
async function selectWithHandles(page: Page, live: LiveSms, element: Locator): Promise<number> {
  await panIntoView(page, live.canvasRoot, element, 80)
  await clickInFrame(page, element)
  await expect(live.content.locator('[data-canvas-resize-handle="e"]'), 'the live frame drew no resize handles').toBeVisible({ timeout: 15_000 })
  // Screen px per frame px: the canvas zoom is a transform on the iframe.
  const pageBox = await element.boundingBox()
  const frameBox = await measure(element)
  return pageBox!.width / frameBox.width
}

/** Press the centre of `handle`, move by (`dx`, `dy`) FRAME px in steps; the caller releases. */
async function pressHandle(page: Page, content: FrameLocator, handle: string, dx: number, dy: number, zoom: number): Promise<void> {
  const box = await content.locator(`[data-canvas-resize-handle="${handle}"]`).boundingBox()
  expect(box, `the ${handle} handle has no box`).not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + box!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx * zoom, y + dy * zoom, { steps: 10 })
  // One animation frame for the coalesced preview write.
  await page.waitForTimeout(120)
}

test.describe.configure({ mode: 'serial' })

test.describe('Live-frame parity (Tier 2)', () => {
  test.setTimeout(300_000)

  test.beforeAll(() => {
    fixture = fixtureOrExisting(() => createFixtureProject('test4', FIXTURE_NAME))
    if (fixture.ready) unpinSmsFrameHeight(fixture.dir)
  })
  test.afterAll(() => {
    if (fixture) removeFixtureProject(fixture)
  })

  test('store-17: a delete the server refuses renders again in the live frame', async ({ page }) => {
    const live = await openLiveSms(page)
    const input = live.content.locator('[class*="codeInput"]').nth(5)
    await selectWithHandles(page, live, input)

    let refusedDeletes = 0
    await page.route('**/admin/api/studio/save', async (route) => {
      const body = route.request().postData() ?? ''
      if (!body.includes('"delete"')) return route.continue()
      refusedDeletes += 1
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Refused by the live-frame parity spec.' }) })
    })
    try {
      await page.keyboard.press('Delete')
      await expect.poll(() => refusedDeletes, { message: 'the Delete never posted a delete edit' }).toBeGreaterThan(0)
      // No write, so no HMR: only the rollback's revert can bring it back.
      await expect
        .poll(() => measure(input).then((box) => box.display !== 'none' && box.height > 0), { message: 'the refused delete stayed hidden in the live frame', timeout: 15_000 })
        .toBe(true)
      await expect(input).not.toHaveAttribute('data-studio-optimistic-hidden')
    } finally {
      await page.unroute('**/admin/api/studio/save')
    }
  })

  test('canvas-23: a drag at the bottom of the frame never grows it by the size badge', async ({ page }) => {
    const live = await openLiveSms(page)
    // `main` is the page: its bottom is the body's. A point in it below the
    // absolutely positioned banner (on screen, unlike main's own bottom edge)
    // selects it.
    const resend = live.content.locator('[class*="resend"]').first()
    await panIntoView(page, live.canvasRoot, resend, 80)
    const below = await resend.boundingBox()
    await page.mouse.click(below!.x + 4, below!.y + below!.height + 80)
    const handle = live.content.locator('[data-canvas-resize-handle="e"]')
    await expect(handle, 'selecting the page’s <main> drew no handles').toBeAttached({ timeout: 15_000 })
    await panIntoView(page, live.canvasRoot, handle)
    await expect(handle).toBeVisible()
    const frameHeight = async () => (await live.frame.boundingBox())!.height
    const before = await frameHeight()

    const box = await handle.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    // A few px out and back: the badge shows, the element ends where it began.
    await page.mouse.move(box!.x + box!.width / 2 + 6, box!.y + box!.height / 2, { steps: 3 })
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 3 })
    await expect(live.content.locator('[data-canvas-resizing] [data-canvas-size-badge]')).toBeVisible()
    // The app changes its DOM mid-drag (a carousel, a clock): the frame
    // re-measures its content — and must not measure the badge.
    await live.content.locator('body').evaluate((body) => {
      const dot = document.createElement('span')
      body.appendChild(dot)
      dot.remove()
    })
    await page.waitForTimeout(800)
    near(await frameHeight(), before, 'the frame grew mid-drag')
    await page.mouse.up()
    await page.waitForTimeout(800)
    near(await frameHeight(), before, 'the frame grew after the drag')
  })

  test('canvas-23: a flex:1 code input renders at the dragged width, during the drag and after the HMR', async ({ page }) => {
    const live = await openLiveSms(page)
    const input = live.content.locator('[class*="codeInput"]').first()
    const zoom = await selectWithHandles(page, live, input)
    const before = await measure(input)

    await pressHandle(page, live.content, 'e', 30, 0, zoom)
    near((await measure(input)).width, before.width + 30, 'the preview did not follow the pointer')
    await page.mouse.up()

    // The Fill (a `flex: 1` in the CSS module) is overridden with the width,
    // or the width is a dead write and the input snaps back.
    await expect.poll(readSms, { timeout: 30_000 }).toMatch(/flex: ["']0 1 auto["']/)
    // The HMR landed once the runtime dropped its preview; the source holds it now.
    await expect(input).not.toHaveAttribute('data-studio-resize-preview', { timeout: 30_000 })
    const after = await measure(input)
    near(after.width, Math.round(before.width + 30), 'the input snapped back after the HMR')
    // The inline START edge stays put (the right one under RTL).
    const rtl = await input.evaluate((el) => getComputedStyle(el).direction === 'rtl')
    near(rtl ? after.right : after.left, rtl ? before.right : before.left, 'the input moved')
  })

  test('canvas-26: a resize edge snaps to a sibling’s edge within 8 screen px', async ({ page }) => {
    const live = await openLiveSms(page)
    const input = live.content.locator('[class*="codeInput"]').nth(3)
    const sibling = live.content.locator('[class*="codeInput"]').nth(4)
    const zoom = await selectWithHandles(page, live, input)
    const before = await measure(input)
    const peer = await measure(sibling)

    // Aim 4 frame px short of the sibling's right edge — inside the 8 SCREEN px
    // pull at any zoom up to 200%, outside the 1 px this spec tolerates.
    const aim = peer.right - 4 - before.right
    await pressHandle(page, live.content, 'e', aim, 0, zoom)
    await expect(live.content.locator('[data-canvas-resize-handle="e"]')).toBeVisible()
    await page.mouse.up()

    await expect(input).not.toHaveAttribute('data-studio-resize-preview', { timeout: 30_000 })
    await expect.poll(() => measure(input).then((box) => Math.round(box.width)), { timeout: 30_000 }).toBe(Math.round(peer.right - before.left))
    const after = await measure(input)
    near(after.right, peer.right, 'the edge did not snap to the sibling’s edge')
  })
})
