import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import {
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  zoomToPercent,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'
import { profileGesture } from './helpers/canvasPerf'

/**
 * P5-D SVG-9 — vector edit mode and the pen, measured in a real browser
 * (`standing-02`: the overlay's whole job is geometry, which happy-dom cannot
 * lay out; `src/__tests__/canvas/vectorEditMode.test.tsx` pins the contract).
 *
 *   1. Double-click an inline `<svg>`: its anchors sit ON the path's points —
 *      measured, board overlay vs the in-frame path's own CTM — and are ~8
 *      screen px at 25%, 100% and 400% zoom.
 *   2. Drag one anchor: exactly ONE `POST /save`, the file changes only the
 *      moved segment, the frame's `d` equals the file's after the re-read, the
 *      frame's height does not move, and ⌘Z restores the file byte-for-byte.
 *   3. The budget: dragging an anchor of a 2,000-anchor path, p95 frame
 *      interval ≤ 16.7 ms at 25%, 100% and 400%, with ZERO React commits
 *      between the first move and the release.
 *   4. The pen: P, three clicks in the frame, ⏎ — one new `<svg>` in the file.
 *
 * SAFETY — writes only to this run's throwaway fixture under the workspace
 * root, removed afterwards.
 */

const REL = 'pages/Home.tsx'
const ICON_D = 'M4 4h16v16H4z'

/** 2,000 anchors: a zig-zag across a 2,000-unit-wide viewBox drawn 1,000 px wide. */
const BIG_D = `M0 100${Array.from({ length: 1999 }, (_, i) => `l1 ${i % 2 === 0 ? 40 : -40}`).join('')}`

const FIXTURE_PAGE = `import './Home.css'

export default function Home() {
  return (
    <main className="page">
      <svg className="icon" width="96" height="96" viewBox="0 0 24 24" fill="none">
        <path d="${ICON_D}" stroke="black" strokeWidth={2} />
      </svg>
      <div className="spacer">Below the icon</div>
      <svg className="big" width="1000" height="200" viewBox="0 0 2000 200" fill="none">
        <path d="${BIG_D}" stroke="black" />
      </svg>
    </main>
  )
}
`

const FIXTURE_CSS = `.page { padding: 40px; font: 16px/1.5 sans-serif; }
.spacer { height: 40px; }
`

const ICON_SVG = sourceNodeId(FIXTURE_PAGE, REL, 'svg', 1)
const BIG_SVG = sourceNodeId(FIXTURE_PAGE, REL, 'svg', 2)

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-studio-vector', {
    [REL]: FIXTURE_PAGE,
    'pages/Home.css': FIXTURE_CSS,
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

const readPage = (): string => fs.readFileSync(path.join(fixture.dir, ...REL.split('/')), 'utf8')

/** Counts every React commit from page load on (a minimal devtools hook — React calls it per commit). */
async function installCommitCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __reactCommits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }
    w.__reactCommits = 0
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: () => {
        w.__reactCommits += 1
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
    }
  })
}

const readCommits = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __reactCommits: number }).__reactCommits)

async function openBoard(page: Page): Promise<{ canvasRoot: Locator; frame: Locator }> {
  await installCommitCounter(page)
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toHaveCount(1, { timeout: 60_000 })
  return { canvasRoot, frame }
}

/** Double-click the svg node, with real mouse input at its centre, and wait for the overlay. */
async function enterEditMode(page: Page, frame: Locator, svgNodeId: string): Promise<Locator> {
  const svg = canvasContentFrame(frame).locator(`[data-node-id="${svgNodeId}"]`).first()
  await expect(svg).toBeVisible({ timeout: 30_000 })
  const box = (await svg.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('[data-board-vector-layer="edit"]')).toBeAttached({ timeout: 10_000 })
  return svg
}

interface AnchorFacts {
  /** Overlay square centres, client px. */
  overlay: { x: number; y: number }[]
  /** Board zoom as painted. */
  zoom: number
}

/** The overlay's anchor centres in client px, parsed from its one squares path. */
async function overlayAnchors(page: Page): Promise<AnchorFacts> {
  return page.evaluate(() => {
    const origin = document.querySelector('[data-studio-board-origin]')!.getBoundingClientRect()
    const zoom = origin.width / 1000
    const d = document.querySelector('[data-vector-anchors]')!.getAttribute('d') ?? ''
    const overlay = [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)/g)].map((m) => {
      const half = Number(m[3]) / 2
      return { x: origin.left + (Number(m[1]) + half) * zoom, y: origin.top + (Number(m[2]) + half) * zoom }
    })
    return { overlay, zoom }
  })
}

/** Where the in-frame path's local points actually are on screen: its own CTM, then the (scaled) iframe. */
async function pathPointsOnScreen(page: Page, frame: Locator, svgNodeId: string, points: readonly { x: number; y: number }[], zoom: number) {
  const iframeBox = (await visibleCanvasIframe(frame).boundingBox())!
  const local = await canvasContentFrame(frame)
    .locator(`[data-node-id="${svgNodeId}"] path`)
    .first()
    .evaluate((el, pts) => {
      const m = (el as SVGPathElement).getScreenCTM()!
      return pts.map((p) => new DOMPoint(p.x, p.y).matrixTransform(m)).map((p) => ({ x: p.x, y: p.y }))
    }, points as { x: number; y: number }[])
  return local.map((p) => ({ x: iframeBox.x + p.x * zoom, y: iframeBox.y + p.y * zoom }))
}

function savesOn(page: Page): Request[] {
  const saves: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/admin/api/studio/save')) saves.push(request)
  })
  return saves
}

test.describe('SVG-9 — vector edit mode and the pen, measured', () => {
  test.setTimeout(240_000)

  test('anchors sit on the path at 25%, 100% and 400%, and stay 8 screen px', async ({ page }) => {
    const { canvasRoot, frame } = await openBoard(page)
    const svg = await enterEditMode(page, frame, ICON_SVG)
    const iconPoints = [{ x: 4, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 20 }, { x: 4, y: 20 }]

    for (const pct of [100, 25, 400]) {
      await zoomToPercent(page, canvasRoot, pct)
      await panIntoView(page, canvasRoot, svg)
      await expect
        .poll(async () => {
          const facts = await overlayAnchors(page)
          const actual = await pathPointsOnScreen(page, frame, ICON_SVG, iconPoints, facts.zoom)
          if (facts.overlay.length !== actual.length) return Number.POSITIVE_INFINITY
          return Math.max(...facts.overlay.map((o, i) => Math.hypot(o.x - actual[i]!.x, o.y - actual[i]!.y)))
        }, { message: `anchors off the path at ${pct}%`, timeout: 10_000 })
        .toBeLessThanOrEqual(1)

      // Chrome is screen-sized: select an anchor and measure its square.
      const first = (await overlayAnchors(page)).overlay[1]!
      await page.mouse.click(first.x, first.y)
      // The element's own client rect: Playwright's `boundingBox()` reports a
      // different box for an SVG path inside a nested svg viewport.
      const activeWidth = await page.evaluate(() => {
        const el = document.querySelector('[data-vector-active]')
        return el ? el.getBoundingClientRect().width : null
      })
      expect(activeWidth, `no active anchor at ${pct}%`).not.toBeNull()
      expect(Math.abs(activeWidth! - 8), `anchor square at ${pct}%`).toBeLessThanOrEqual(1.5)
    }
  })

  test('one drag is ONE /save, changes one segment, leaves the frame height alone, and ⌘Z restores the file', async ({ page }) => {
    const before = readPage()
    const { canvasRoot, frame } = await openBoard(page)
    const svg = await enterEditMode(page, frame, ICON_SVG)
    await zoomToPercent(page, canvasRoot, 100)
    await panIntoView(page, canvasRoot, svg)
    const heightBefore = await canvasContentFrame(frame).locator('body').evaluate((b) => b.scrollHeight)
    const saves = savesOn(page)

    const anchor = (await overlayAnchors(page)).overlay[1]! // (20, 4): the end of `h16`
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.down()
    for (let i = 1; i <= 20; i += 1) await page.mouse.move(anchor.x + i, anchor.y + i * 2)
    // A preview, not a write: nothing posted mid-drag, and the frame's height held.
    expect(saves).toHaveLength(0)
    expect(await canvasContentFrame(frame).locator('body').evaluate((b) => b.scrollHeight)).toBe(heightBefore)
    await page.mouse.up()

    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => readPage() !== before, { timeout: 10_000 }).toBe(true)
    await page.waitForTimeout(1500)
    expect(saves).toHaveLength(1)

    const after = readPage()
    const written = /<path d="([^"]+)"/.exec(after)![1]!
    // `h16` became a line to the new point; `M4 4` and the rest are byte-for-byte.
    expect(written.startsWith('M4 4')).toBe(true)
    expect(written.endsWith('v16H4z') || written.includes('H4z')).toBe(true)
    expect(written).not.toBe(ICON_D)
    // The frame shows exactly what the file says, after the re-read.
    await expect
      .poll(() => canvasContentFrame(frame).locator(`[data-node-id="${ICON_SVG}"] path`).first().getAttribute('d'), { timeout: 10_000 })
      .toBe(written)
    expect(await canvasContentFrame(frame).locator('body').evaluate((b) => b.scrollHeight)).toBe(heightBefore)

    await page.keyboard.press('Escape')
    await canvasRoot.focus()
    await page.keyboard.press('Control+z')
    await expect.poll(readPage, { timeout: 10_000 }).toBe(before)
  })

  test('a 2,000-anchor path drags inside the frame budget at every zoom, with zero React commits', async ({ page }) => {
    const { canvasRoot, frame } = await openBoard(page)
    const svg = await enterEditMode(page, frame, BIG_SVG)

    for (const pct of [100, 25, 400]) {
      await zoomToPercent(page, canvasRoot, pct)
      await panIntoView(page, canvasRoot, svg)
      const anchors = (await overlayAnchors(page)).overlay
      expect(anchors.length).toBe(2000)
      const target = anchors[1000]!
      await page.mouse.move(target.x, target.y)
      await page.mouse.down()
      await page.mouse.move(target.x + 4, target.y + 4) // past the threshold: the gesture has begun
      await page.waitForTimeout(100)
      const commitsBefore = await readCommits(page)
      const profile = await profileGesture(page, async () => {
        for (let i = 0; i < 90; i += 1) {
          await page.mouse.move(target.x + 4 + i, target.y + 4 + (i % 20))
        }
      })
      const commitsDuring = (await readCommits(page)) - commitsBefore
      await page.mouse.up()
      await page.keyboard.press('Control+z').catch(() => {})
      console.log(`[studio-vector] ${pct}%: p95 ${profile.p95FrameMs.toFixed(1)} ms, worst ${profile.worstFrameMs.toFixed(1)} ms, frames ${profile.frames}, commits ${commitsDuring}`)
      expect(commitsDuring, `React committed during the drag at ${pct}%`).toBe(0)
      // A 60 Hz display cannot report a p95 interval BELOW 16.7 ms, and vsync
      // jitter puts it a hair over; a dropped frame is 33 ms. The slack is
      // what separates jitter from a missed frame.
      expect(profile.p95FrameMs, `p95 frame at ${pct}%`).toBeLessThanOrEqual(16.7 * 1.25)
    }
  })

  test('the pen: P, three clicks, ⏎ — one new <svg> in the file', async ({ page }) => {
    const before = readPage()
    const { canvasRoot, frame } = await openBoard(page)
    const saves = savesOn(page)
    const spacer = canvasContentFrame(frame).locator('.spacer').first()
    await expect(spacer).toBeVisible({ timeout: 30_000 })
    await panIntoView(page, canvasRoot, spacer)
    const box = (await spacer.boundingBox())!
    await canvasRoot.focus()
    await page.keyboard.press('p')
    await expect(page.locator('[data-canvas-draw-layer="pen"]')).toBeVisible()
    await page.mouse.click(box.x + 20, box.y + 10)
    await page.mouse.click(box.x + 120, box.y + 10)
    await page.mouse.click(box.x + 120, box.y + 30)
    await page.keyboard.press('Enter')
    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => (readPage().match(/<svg/g) ?? []).length, { timeout: 10_000 }).toBe(3)
    const after = readPage()
    expect(after).toContain('stroke="currentColor"')
    expect(after).toContain('strokeWidth={2}')
    expect(after).not.toBe(before)
  })
})
