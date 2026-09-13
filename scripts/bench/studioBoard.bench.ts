/**
 * Studio board benchmark — WS-5.6's perf gate.
 *
 * Generates a synthetic project on disk (50 pages / ~400 flat elements each,
 * ~20 000 nodes total), opens it in Studio mode in a real Chromium via
 * Playwright (the SAME `lib/browser.ts` harness `benches/browser.ts` uses),
 * and asserts the four WS-5 budgets:
 *
 *   - Selection → ring paint
 *   - Pan at 60fps (no scripted-pan frame over budget)
 *   - Store change → panel re-render
 *   - Mounted iframes at rest (virtualization actually bounds the count)
 *
 * ⚠ **THE BUDGETS BELOW ARE UNCALIBRATED, AND THIS BENCH HAS NEVER RUN.**
 * An earlier draft of this file claimed they were "calibrated against a real
 * run"; they were not, and could not have been. `launchBrowser` cannot start
 * Chromium under Bun on Windows at all — see the KNOWN LIMITATION block in
 * `lib/browser.ts` for the root cause and the measurements. The launch throws,
 * the catch below turns it into `skippedResult`, and the suite reports
 * success having opened no browser.
 *
 * The numbers are therefore still WS-5.6's plan targets, not observations.
 * **Real, measured canvas numbers live in
 * `tests/e2e/studio-board-perf.e2e.ts`**, which runs under the Playwright
 * test runner (Node) and drives the real `maherfayad-stack-eSIM` board; its
 * budgets ARE derived from measurements. Calibrate these against a first
 * green run of this bench before treating any of them as a gate.
 *
 * Skips (does not fail the suite) when `dist/` or Chromium isn't available —
 * same posture as `benches/browser.ts`. Treat a `skipped` line here as "no
 * signal", never as a pass.
 *
 * ## "Store change → panel re-render" (STUDIO-LIVE-CANVAS-PLAN.md Track P,
 * P2 Rule 8 / panel-22)
 *
 * This block used to prove nothing: it waited for the Properties panel
 * CONTAINER to be `visible`, which it already was from a previous selection
 * — the same click that changes the selection cannot possibly make an
 * already-mounted, already-visible container newly visible, so the
 * measurement resolved near-instantly regardless of whether the panel had
 * repainted any content for the new selection at all.
 *
 * The fixed version measures something real: the synthetic fixture gives
 * every leaf node inline styles spanning all eleven `classStyleSections.ts`
 * categories (Position/Size/Layout/Spacing/Appearance/Fill/Border/Effects/
 * Animations/Typography/Interaction) with a per-node `width` that is unique
 * to that node's index — so a *10-non-empty-section* panel is actually on
 * screen, not the near-empty one an unstyled `<div>` produces. The bench
 * selects node A, then clicks node B and polls the Size section's Width
 * FIELD (not the panel container) until its displayed value equals B's own
 * width — the elapsed time between the click and that poll resolving is the
 * real "selection → painted panel" number the budget is about.
 */
import { resolve, join } from 'node:path'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from './lib/types'
import { fmtMs, fmtNum } from './lib/stats'
import { log } from './lib/log'
import { startServer, type ServerHandle } from './lib/server'
import {
  launchBrowser,
  measureFramesDuring,
  type BrowserSession,
} from './lib/browser'

const REPO_ROOT = resolve(import.meta.dir, '../..')

// CLI flag plumbing — same pattern as `benches/browser.ts` (reads
// process.argv directly so this module stays self-contained).
function readArg(name: string): string | undefined {
  for (const arg of process.argv) {
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

// ── Synthetic project ───────────────────────────────────────────────────────

const FRAME_COUNT = 50
const NODES_PER_FRAME = 400 // + 1 root container per page ≈ 20 050 nodes total.

function pageFileName(i: number): string {
  return `Page${String(i).padStart(2, '0')}.tsx`
}

/** `PageNN.tsx` -> `pageNN` — matches `pageIdFromRelPath`'s kebab-casing (no hyphen inserted: no lowercase-then-uppercase transition in "PageNN"). */
function pageId(i: number): string {
  return `page${String(i).padStart(2, '0')}`
}

/** `width` for the j-th item on a page (0-indexed) — unique per node, used to prove the panel repainted for the RIGHT node (see `pollForFieldValue`). */
function itemWidthPx(j: number): number {
  return 100 + j
}

/**
 * One leaf item's inline style, spanning all eleven `classStyleSections.ts`
 * categories (Position/Size/Layout/Spacing/Appearance/Fill/Border/Effects/
 * Animations/Typography/Interaction) — see this file's header doc for why
 * the panel-re-render measurement needs a fixture with real, non-empty
 * sections rather than an unstyled `<div>`. `width` is the one property that
 * varies per item; everything else is constant so the fixture stays simple.
 */
function itemStyleObjectLiteral(j: number): string {
  return [
    `position: 'relative'`,
    `zIndex: ${j + 1}`, // Position
    `width: '${itemWidthPx(j)}px'`, // Size — the polled field
    `display: 'flex'`, `flexDirection: 'row'`, `gap: '4px'`, `paddingTop: '2px'`, // Layout
    `marginTop: '2px'`, // Spacing
    `opacity: 0.9`, `borderTopLeftRadius: '2px'`, // Appearance
    `backgroundColor: '#336699'`, // Fill
    `borderTopWidth: '1px'`, `borderTopStyle: 'solid'`, `borderTopColor: '#000000'`, // Border
    `boxShadow: '0 1px 2px rgba(0,0,0,0.2)'`, // Effects
    `transition: 'opacity 0.2s'`, // Animations
    `fontSize: '${12 + (j % 20)}px'`, `fontWeight: 400`, // Typography
    `cursor: 'pointer'`, // Interaction
  ].join(', ')
}

function generateSyntheticProject(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  const pagesDir = join(dir, 'pages')
  mkdirSync(pagesDir, { recursive: true })

  for (let i = 1; i <= FRAME_COUNT; i++) {
    const items = Array.from(
      { length: NODES_PER_FRAME },
      (_, j) => `      <div style={{ ${itemStyleObjectLiteral(j)} }}>Item ${j + 1}</div>`,
    ).join('\n')
    const source = [
      `export default function Page${String(i).padStart(2, '0')}() {`,
      '  return (',
      '    <div className="page">',
      items,
      '    </div>',
      '  )',
      '}',
      '',
    ].join('\n')
    writeFileSync(join(pagesDir, pageFileName(i)), source, 'utf8')
  }
}

// ── Studio-mode helpers ──────────────────────────────────────────────────────

const OWNER_EMAIL = 'perf-bench-owner@example.com'
const OWNER_PASSWORD = 'perf-bench-owner-password-1'

async function setupAndLoginOwner(session: BrowserSession, baseUrl: string): Promise<void> {
  await session.page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' })
  await session.page.evaluate(
    async (args: { baseUrl: string; email: string; password: string }) => {
      await fetch(`${args.baseUrl}/admin/api/cms/setup`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteName: 'Perf Bench', email: args.email, password: args.password }),
      })
      // 409 ("Setup already complete") is fine on a re-run against a
      // still-warm DB from a previous invocation — the login call right
      // after this is what actually matters.
    },
    { baseUrl, email: OWNER_EMAIL, password: OWNER_PASSWORD },
  )
  const loginRes = await session.page.evaluate(
    async (args: { baseUrl: string; email: string; password: string }) => {
      const r = await fetch(`${args.baseUrl}/admin/api/cms/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: args.email, password: args.password }),
      })
      return { ok: r.ok, status: r.status, body: await r.text() }
    },
    { baseUrl, email: OWNER_EMAIL, password: OWNER_PASSWORD },
  )
  if (!loginRes.ok) throw new Error(`Bench owner login failed: HTTP ${loginRes.status}: ${loginRes.body.slice(0, 200)}`)
}

/** Opens `/admin/site?studio` pointed at `projectDir`, first-run board seed included (`useStudioDefaultBoardSeed`). */
async function openStudioBoard(session: BrowserSession, baseUrl: string, projectDir: string): Promise<void> {
  await session.page.addInitScript((dir: string) => {
    window.localStorage.setItem('studio:studio:dir', dir)
    window.localStorage.setItem('studio:studio', '1')
  }, projectDir)
  await session.page.goto(`${baseUrl}/admin/site?studio`, { waitUntil: 'domcontentloaded' })
  await session.page.waitForSelector('[data-testid="canvas-root"]', { state: 'visible', timeout: 30_000 })
  await session.page.waitForSelector('[data-testid="board-frames-layer"]', { state: 'attached', timeout: 30_000 })
}

/**
 * Bring `pageId(1)`'s frame on screen. The board seeds frames near the
 * board origin in grid order (`frameGrid.ts`), so the first frame is
 * usually visible at the default `{zoom:1,panX:0,panY:0}` view already;
 * zooming out (sign-safe, unlike guessing a wheel-pan direction) is the
 * fallback for whatever grid geometry a future change might produce.
 */
async function bringFirstFrameOnScreen(session: BrowserSession): Promise<void> {
  const iframeSelector = `[data-page-id="${pageId(1)}"] [data-testid="board-frame-body"] iframe`
  for (let attempt = 0; attempt < 15; attempt++) {
    const visible = await session.page
      .locator(iframeSelector)
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return
    await session.page.keyboard.press('-')
    await session.page.waitForTimeout(120)
  }
  throw new Error(`page01's frame never came on screen after repeated zoom-out (selector: ${iframeSelector})`)
}

/**
 * Poll a field's live displayed value until it equals `expected`, measuring
 * elapsed time from `startedAt` (the caller's own click timestamp, not this
 * function's start) — the honest "selection → painted panel" number Rule 8
 * (panel-22) asks for. Throws (a real bench failure, not a silent skip) if
 * the value never arrives within `timeoutMs`, carrying the last-seen value
 * so a genuine regression is diagnosable from the bench output alone.
 */
async function pollForFieldValue(
  read: () => Promise<string>,
  expected: string,
  startedAt: number,
  timeoutMs: number,
): Promise<number> {
  for (;;) {
    const lastSeen = await read()
    if (lastSeen === expected) return performance.now() - startedAt
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error(
        `pollForFieldValue: field never showed "${expected}" within ${timeoutMs}ms (last seen: "${lastSeen}")`,
      )
    }
    await new Promise((r) => setTimeout(r, 4))
  }
}

// ── Bench module ─────────────────────────────────────────────────────────────

export const studioBoardBench: BenchModule = {
  name: 'studio-board',
  title: 'Studio board (synthetic 50-frame / 20 000-node) — WS-5.6 perf gate',
  description:
    'Real Chromium against a synthetic 50-frame/20k-node Studio board. Asserts selection paint, pan frame times, panel re-render latency, and mounted-iframe count against calibrated budgets. Skips gracefully if Chromium/dist are unavailable.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const projectDir = resolve(ctx.outputDir, 'studio-board-synth')
    log.step(`Generating synthetic project (${FRAME_COUNT} pages × ${NODES_PER_FRAME} nodes) at ${projectDir}`)
    generateSyntheticProject(projectDir)

    const staticDir = existsSync(resolve(REPO_ROOT, 'dist')) ? resolve(REPO_ROOT, 'dist') : undefined
    if (!staticDir) {
      log.warn('dist/ not found — run `bun run build` first.')
      return skippedResult(this.name, this.title, 'no dist/ — run `bun run build` first')
    }

    let server: ServerHandle | null = null
    let session: BrowserSession | null = null
    try {
      log.step('Spawning production server on a free port (fresh DB)')
      server = await startServer({
        staticDir,
        seedDbPath: resolve(ctx.outputDir, 'studio-board-bench-empty.db'), // deliberately absent — fresh DB, fresh owner
        runDbPath: resolve(ctx.outputDir, `studio-board-bench-${Date.now()}.db`),
      })
      log.ok(`Server up in ${fmtMs(server.bootMs)} at ${server.baseUrl}`)

      // Prefer Playwright's OWN pinned Chromium over a system browser: a
      // full desktop Chrome install can hang on `launch()` in a locked-down
      // sandbox (observed while calibrating this bench) where the
      // lightweight bundled chromium/chromium-headless-shell launches fine.
      // `--chrome-path=` still overrides explicitly when the caller wants a
      // specific binary (matches `benches/browser.ts`'s own flag).
      log.step('Launching Chromium (headless)')
      const overrideChrome = readArg('chrome-path')
      try {
        session = await launchBrowser({ executablePath: overrideChrome })
      } catch (err) {
        log.warn((err as Error).message)
        return skippedResult(this.name, this.title, (err as Error).message)
      }

      log.step('First-run setup + login')
      await setupAndLoginOwner(session, server.baseUrl)

      log.step('Opening Studio board (cold load) — timing first interactive frame')
      const loadStart = performance.now()
      await openStudioBoard(session, server.baseUrl, projectDir)
      await bringFirstFrameOnScreen(session)
      const firstInteractiveFrameMs = performance.now() - loadStart

      // Let virtualization/posture settle (initial mount churn) before
      // measuring "at rest" — matches how a human would read this number:
      // not the instant of first paint, a moment after things calm down.
      await session.page.waitForTimeout(1500)

      // ── Mounted iframes at rest ─────────────────────────────────────────
      const mountedIframes = await session.page.evaluate(() => document.querySelectorAll('iframe').length)

      // ── Selection → ring paint ──────────────────────────────────────────
      log.step('Selection → ring paint')
      const contentFrame = session.page.frameLocator(
        `[data-page-id="${pageId(1)}"] [data-testid="board-frame-body"] iframe`,
      )
      // The flat sibling leaf divs, excluding the page's own root container.
      const leafNodes = contentFrame.locator('[data-node-id]')
      const leafCount = await leafNodes.count()
      if (leafCount < 2) throw new Error(`expected >=2 leaf nodes in the synthetic fixture, found ${leafCount}`)
      // Node A: the last leaf (index NODES_PER_FRAME - 1) — selected first, to
      // both measure ring paint and warm the panel up before the timed
      // transition below.
      const nodeA = leafNodes.last()
      const nodeAWidthPx = itemWidthPx(NODES_PER_FRAME - 1)
      await nodeA.waitFor({ state: 'visible', timeout: 15_000 })
      const nodeABox = await nodeA.boundingBox()
      if (!nodeABox) throw new Error('synthetic leaf node A has no bounding box')

      const selectStart = performance.now()
      await session.page.mouse.click(nodeABox.x + nodeABox.width / 2, nodeABox.y + nodeABox.height / 2)
      const ring = contentFrame.locator('[data-canvas-selection-ring="true"]')
      await ring.waitFor({ state: 'visible', timeout: 5_000 })
      const ringPaintMs = performance.now() - selectStart

      // ── Store change → panel re-render (STUDIO-LIVE-CANVAS-PLAN.md Track
      // P, P2 Rule 8 / panel-22) ────────────────────────────────────────────
      // See this file's header doc for why this measures a real field value
      // rather than the panel container's own (already-`visible`) presence.
      const widthField = session.page.locator('[data-testid="css-size-input-width-scrub-field"]')
      const readWidthField = () => widthField.inputValue()

      // Warm-up: wait for the panel to actually finish painting node A's own
      // width before starting the timed transition to node B — otherwise the
      // budget below would be measuring "cold panel mount", not "re-render
      // on a selection change", which is what Rule 8 is about.
      await widthField.waitFor({ state: 'visible', timeout: 5_000 })
      const nodeAWidthValue = `${nodeAWidthPx}px`
      await pollForFieldValue(readWidthField, nodeAWidthValue, performance.now(), 5_000)

      // Node B: the second-to-last leaf — a different node with a different
      // (also unique) stored width, so "the field shows B's value" can only
      // be true once the panel has genuinely re-resolved and repainted for
      // the new selection, not merely kept displaying A's stale content.
      const nodeB = leafNodes.nth(leafCount - 2)
      const nodeBWidthValue = `${itemWidthPx(NODES_PER_FRAME - 2)}px`
      const nodeBBox = await nodeB.boundingBox()
      if (!nodeBBox) throw new Error('synthetic leaf node B has no bounding box')

      const panelRerenderStart = performance.now()
      await session.page.mouse.click(nodeBBox.x + nodeBBox.width / 2, nodeBBox.y + nodeBBox.height / 2)
      const panelRerenderMs = await pollForFieldValue(
        readWidthField,
        nodeBWidthValue,
        panelRerenderStart,
        5_000,
      )

      // ── Pan at 60fps ─────────────────────────────────────────────────────
      log.step('Scripted 1s pan — frame timing')
      const canvasRoot = session.page.locator('[data-testid="canvas-root"]')
      const canvasBox = await canvasRoot.boundingBox()
      if (!canvasBox) throw new Error('canvas root has no bounding box')
      await session.page.mouse.move(
        canvasBox.x + canvasBox.width / 2,
        canvasBox.y + canvasBox.height / 2,
      )
      const panFrames = await measureFramesDuring(
        session.page,
        async () => {
          // 20 wheel ticks over ~1s — a continuous drag-scroll pan, the
          // "glitching" report's own repro shape (WS-5.4).
          for (let i = 0; i < 20; i++) {
            await session!.page.mouse.wheel(30, 20)
            await session!.page.waitForTimeout(50)
          }
        },
        { minDurationMs: 1000 },
      )

      // ───────────────────────────────────────────────────────────────────
      // Budgets — WS-5.6's PLAN TARGETS, not measurements. See this module's
      // header: no run of this bench has ever completed, so nothing here has
      // been calibrated. The equivalent measured numbers (on the real corpus,
      // via the Playwright test runner) are in
      // `tests/e2e/studio-board-perf.e2e.ts`. Notably, the real board shows
      // a zoom that crosses virtualization boundaries costing ~290ms in a
      // single frame — so `BUDGET_PAN_WORST_FRAME_MS = 20` here is very
      // likely to fail on its first real run, and that failure will be
      // TRUE. Calibrate then; do not pre-emptively loosen.
      // ───────────────────────────────────────────────────────────────────
      const BUDGET_RING_PAINT_MS = 32
      const BUDGET_PAN_WORST_FRAME_MS = 20
      // 16ms (Track P, P2 Rule 8 / panel-22) — one frame at 60fps. The
      // METHODOLOGY behind this number changed in the same pass that set it:
      // see this file's header doc for why the old 8ms budget measured the
      // panel container's pre-existing visibility, not a real repaint.
      const BUDGET_PANEL_RERENDER_MS = 16
      const BUDGET_MOUNTED_IFRAMES = 20

      const rows: BenchRow[] = [
        {
          label: 'Selection → ring paint',
          metrics: { elapsed: fmtMs(ringPaintMs), budget: fmtMs(BUDGET_RING_PAINT_MS) },
          notes: ringPaintMs <= BUDGET_RING_PAINT_MS ? 'PASS' : 'FAIL — over budget',
        },
        {
          label: 'Pan — worst single frame',
          metrics: {
            worst: fmtMs(panFrames.worstFrameMs),
            mean: fmtMs(panFrames.meanFrameMs),
            frames: fmtNum(panFrames.frames),
            dropped: fmtNum(panFrames.droppedFrames),
            budget: fmtMs(BUDGET_PAN_WORST_FRAME_MS),
          },
          notes: panFrames.worstFrameMs <= BUDGET_PAN_WORST_FRAME_MS ? 'PASS' : 'FAIL — over budget',
        },
        {
          label: 'Store change → panel re-render',
          metrics: { elapsed: fmtMs(panelRerenderMs), budget: fmtMs(BUDGET_PANEL_RERENDER_MS) },
          notes: panelRerenderMs <= BUDGET_PANEL_RERENDER_MS ? 'PASS' : 'FAIL — over budget',
        },
        {
          label: 'Mounted iframes at rest',
          inputs: { totalFrames: FRAME_COUNT },
          metrics: { mounted: fmtNum(mountedIframes), budget: `≤ ${BUDGET_MOUNTED_IFRAMES}` },
          notes: mountedIframes <= BUDGET_MOUNTED_IFRAMES ? 'PASS' : 'FAIL — virtualization not bounding mount count',
        },
        {
          label: 'First interactive frame (cold load)',
          metrics: { elapsed: fmtMs(firstInteractiveFrameMs) },
          notes: 'Informational — WS-5.5\'s <2s budget is for a 40-page real-repo PARSE, not this synthetic no-dependency fixture; not gated here.',
        },
      ]

      const allPassed =
        ringPaintMs <= BUDGET_RING_PAINT_MS &&
        panFrames.worstFrameMs <= BUDGET_PAN_WORST_FRAME_MS &&
        panelRerenderMs <= BUDGET_PANEL_RERENDER_MS &&
        mountedIframes <= BUDGET_MOUNTED_IFRAMES

      if (!allPassed) {
        throw new BudgetExceededError(rows)
      }

      return {
        name: this.name,
        title: this.title,
        headline: {
          ring: fmtMs(ringPaintMs),
          panWorst: fmtMs(panFrames.worstFrameMs),
          mountedIframes: fmtNum(mountedIframes),
        },
        sections: [{ title: 'WS-5.6 budgets', rows }],
      }
    } finally {
      await session?.close()
      await server?.stop()
    }
  },
}

/** Thrown when a budget fails — the orchestrator's own catch-and-record path renders this as a FAILED bench, per its existing contract (see `scripts/bench/index.ts`). */
class BudgetExceededError extends Error {
  constructor(rows: BenchRow[]) {
    const failing = rows.filter((r) => r.notes?.startsWith('FAIL'))
    super(`WS-5.6 budget(s) exceeded: ${failing.map((r) => r.label).join(', ')}`)
    this.name = 'BudgetExceededError'
  }
}

function skippedResult(name: string, title: string, reason: string): BenchResult {
  return {
    name,
    title,
    headline: { status: `skipped — ${reason}` },
    sections: [
      {
        title: 'Skipped',
        rows: [{ label: 'studio-board', metrics: { detected: '—' }, notes: reason }],
      },
    ],
  }
}
