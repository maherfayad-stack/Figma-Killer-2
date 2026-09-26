import { expect, test, type FrameLocator, type Locator } from '@playwright/test'
import {
  SELECTION_RING,
  clickInFrame,
  createAuthoredFixtureProject,
  openFixtureBoard,
  panIntoView,
  removeFixtureProject,
  sourceNodeId,
  type FixtureProject,
} from './helpers/studioFixtureProject'
import { canvasContentFrame, visibleCanvasIframe } from './helpers/canvasIframe'

/**
 * P5-D SVG-0 — a literal `<svg>` renders AS the node, asserted on COMPUTED
 * layout in a real browser (`standing-02`: happy-dom has no layout, so
 * `src/__tests__/canvas/svgHostIsTheSvg.test.tsx` can pin the DOM shape but
 * cannot fail on a box).
 *
 * Before the fix the canvas mounted `<span style="display:contents">` around
 * every literal `<svg>`, so:
 *   - `.row > svg { width: 48px }` matched nothing on the canvas (the svg's
 *     parent was the span) and the icon drew at its default size;
 *   - the node's own element had no box — hover and selection geometry came
 *     from a fallback, and the resize offer refused it.
 *
 * Each case measures the element's rendered rect and compares it with what a
 * plain browser renders for the same markup under the same CSS.
 *
 * SAFETY — reads only; the fixture is authored under this run's throwaway
 * copy of `studio-workspace/` and removed afterwards.
 */

const FIXTURE_PAGE = `import './Home.css'

export default function Home() {
  return (
    <main className="page">
      <div className="row">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 4h16v16H4z" stroke="black" strokeWidth={2} /></svg>
        <span className="label">Row label</span>
      </div>
      <div className="cell">
        <svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /></svg>
      </div>
    </main>
  )
}
`

const FIXTURE_CSS = `.page { padding: 40px; font: 16px/1.5 sans-serif; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 40px; }
.row > svg { width: 48px; height: 48px; }
.cell { width: 24px; background: #eee; }
`

/** What the `.cell` looks like in a plain browser: the same markup, no editor. */
const CELL_REFERENCE_MARKUP = '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg>'

const REL = 'pages/Home.tsx'
const ROW_SVG = sourceNodeId(FIXTURE_PAGE, REL, 'svg', 1)
const CELL_SVG = sourceNodeId(FIXTURE_PAGE, REL, 'svg', 2)

let fixture: FixtureProject

test.beforeAll(() => {
  fixture = createAuthoredFixtureProject('__e2e-svg-renders-as-itself', {
    [REL]: FIXTURE_PAGE,
    'pages/Home.css': FIXTURE_CSS,
    // Static tier: the portal frame is under test, and a live frame would add
    // a second canvas iframe.
    '.studio/meta.json': JSON.stringify({ pagesDir: 'pages', trust: 'static' }, null, 2) + '\n',
  })
})

test.afterAll(() => {
  if (fixture) removeFixtureProject(fixture)
})

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The largest per-edge difference between two boxes, or Infinity when either is missing. */
function boxDistance(actual: Box | null, expected: Box | null): number {
  if (!actual || !expected) return Number.POSITIVE_INFINITY
  return Math.max(...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(actual[key] - expected[key])))
}

/**
 * Wait for a ring to settle on `target`'s CURRENT box. Both are re-read on
 * every poll: the overlay positions rings in its own measure pass, and the
 * board itself may move under the pointer (the first click into a frame
 * re-frames the canvas on it), so a box captured before the gesture is stale.
 */
async function expectRingOn(ring: Locator, target: Locator, tolerance: number, label: string): Promise<void> {
  await expect
    .poll(async () => boxDistance(await ring.boundingBox(), await target.boundingBox()), { message: `${label} never settled on the <svg>`, timeout: 10_000 })
    .toBeLessThanOrEqual(tolerance)
}

async function openBoard(page: import('@playwright/test').Page): Promise<{ content: FrameLocator; canvasRoot: Locator }> {
  const canvasRoot = await openFixtureBoard(page, fixture, { autoSave: false })
  const frame = page.locator('[data-page-id]').first()
  await panIntoView(page, canvasRoot, frame)
  await expect(visibleCanvasIframe(frame)).toHaveCount(1, { timeout: 60_000 })
  return { content: canvasContentFrame(frame), canvasRoot }
}

test.describe('SVG-0 — a literal <svg> is the node, with the box the app gives it', () => {
  test.setTimeout(180_000)

  test('the <svg> carries the node id, sits under its real parent, and takes its child-selector size', async ({ page }) => {
    const { content } = await openBoard(page)
    const svg = content.locator(`[data-node-id="${ROW_SVG}"]`).first()
    await expect(svg).toBeVisible({ timeout: 30_000 })

    const facts = await svg.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return {
        localName: el.localName,
        parentClass: el.parentElement?.className ?? '',
        matchesChildSelector: el.matches('.row > svg'),
        isFirstChild: el.matches(':first-child'),
        width: rect.width,
        height: rect.height,
        display: getComputedStyle(el).display,
      }
    })
    expect(facts.localName).toBe('svg')
    expect(facts.parentClass).toBe('row')
    expect(facts.matchesChildSelector).toBe(true)
    expect(facts.isFirstChild).toBe(true)
    // `.row > svg { width: 48px; height: 48px }` applies — with the span in
    // between it matched nothing and the icon drew at the flex default.
    expect(facts.width).toBe(48)
    expect(facts.height).toBe(48)
    expect(facts.display).not.toBe('contents')
  })

  test('an inline <svg> in a block cell is exactly as tall as a plain browser draws it', async ({ page }) => {
    const { content } = await openBoard(page)
    const svg = content.locator(`[data-node-id="${CELL_SVG}"]`).first()
    await expect(svg).toBeVisible({ timeout: 30_000 })

    // Render the same markup under the same CSS, in the same frame document,
    // with no editor involved — the reference for "what the app draws". The
    // `board-27f` line-box regression ([24,44] instead of [24,24]) is exactly
    // a canvas cell that disagreed with this.
    const measured = await svg.evaluate((el, reference) => {
      const cell = el.parentElement!
      const probe = cell.ownerDocument.createElement('div')
      probe.className = 'cell'
      probe.innerHTML = reference
      cell.parentElement!.appendChild(probe)
      const probeSvg = probe.firstElementChild!.getBoundingClientRect()
      const result = {
        cell: cell.getBoundingClientRect().height,
        probeCell: probe.getBoundingClientRect().height,
        svg: [el.getBoundingClientRect().width, el.getBoundingClientRect().height],
        probeSvg: [probeSvg.width, probeSvg.height],
      }
      probe.remove()
      return result
    }, CELL_REFERENCE_MARKUP)
    expect(measured.svg).toEqual(measured.probeSvg)
    expect(measured.cell).toBe(measured.probeCell)
  })

  test('hovering and clicking target the <svg> itself; the selection ring is its box; resize is offered', async ({ page }) => {
    const { content, canvasRoot } = await openBoard(page)
    const svg = content.locator(`[data-node-id="${ROW_SVG}"]`).first()
    await panIntoView(page, canvasRoot, svg, 80)
    const svgBox = await svg.boundingBox()
    expect(svgBox).not.toBeNull()

    await page.mouse.move(svgBox!.x + svgBox!.width / 2, svgBox!.y + svgBox!.height / 2)
    // Hover lands on the <svg> node itself (not a Studio wrapper, not its
    // parent), and the ring is the svg's box. The pointer reaches it through
    // `body` and `main`, so this is also the regression case for a hover that
    // moves between nodes without a measure pass (the ring used to keep
    // `body`'s 1024x800 box under the svg's id).
    const hoverRing = content.locator('[data-canvas-hover-ring="true"]').first()
    await expect(hoverRing).toHaveAttribute('data-canvas-overlay-node-id', ROW_SVG, { timeout: 10_000 })
    await expectRingOn(hoverRing, svg, 3, 'hover ring')

    await clickInFrame(page, svg)
    await expect(svg).toHaveAttribute('data-canvas-selected', 'true', { timeout: 10_000 })
    const selectionRing = content.locator(SELECTION_RING).first()
    await expect(selectionRing).toBeVisible({ timeout: 10_000 })
    await expectRingOn(selectionRing, svg, 3, 'selection ring')
    // An inline `<svg>` is a replaced element CSS sizes, so the resize offer
    // no longer refuses it.
    await expect(content.locator('[data-canvas-resize-handle="e"]')).toBeVisible({ timeout: 15_000 })
  })
})
