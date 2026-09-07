/**
 * The server's headless browser — one warm Chromium, N pages.
 *
 * `referenceRender.ts` already launched a browser per call and closed it
 * again; that was fine for a Tier-2 tool nobody calls in a loop. Headless
 * capture is the opposite: `studio_compare` on a five-page flow is the
 * innermost loop of the agent's fix-verify cycle, and a cold Chromium launch
 * (~300-600ms) paid per call would hand back a good part of the latency this
 * whole workstream exists to remove. So the browser is launched once, kept
 * warm, reused across calls, and torn down after `BROWSER_IDLE_MS` of no
 * captures — the same idle-reuse discipline `referenceRender` applies to a
 * project's dev server, one layer down.
 *
 * **Pages, not browsers, are the unit of isolation.** Each capture opens its
 * own page (its own viewport, its own device scale factor, its own JS realm)
 * and closes it in a `finally`. A crashed or disconnected browser is dropped
 * from the module state and relaunched on the next call rather than handed
 * out again.
 *
 * **Serialised on purpose.** `withCapturePage` runs captures one at a time.
 * Two concurrent 20-page batches at dpr 3 is exactly the shape that turns a
 * shared admin server into an OOM, and nothing about the agent's loop wants
 * parallel captures — it wants one batch to finish fast.
 *
 * The Playwright surface below is the minimal set both callers use, typed
 * structurally so tests can inject a fake without a browser at all. It lives
 * here (rather than in `referenceRender.ts`, where it started) because two
 * modules now need it and a second copy would drift.
 */

/** The navigation + rasterisation surface both capture paths need. Real `chromium.launch()` output satisfies it. */
export interface PlaywrightLikePage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  screenshot(options: { type: 'png' }): Promise<Buffer>
  close(): Promise<void>
}

/** One DOM element the driver rasterises on its own — a single board frame. */
export interface PlaywrightLikeElement {
  screenshot(options: { type: 'png' }): Promise<Buffer>
}

/**
 * The extra surface the CAPTURE driver needs on top of navigation: read the
 * page's readiness report, and screenshot one frame element rather than the
 * viewport. Expressions are passed as STRINGS — the driver runs inside Bun and
 * the page inside Chromium, so there is no shared realm to serialise a closure
 * into, and a string keeps the fake in tests honest about that boundary.
 */
export interface CapturePage extends PlaywrightLikePage {
  waitForFunction(expression: string, options: { timeout: number; polling?: number }): Promise<unknown>
  evaluate(expression: string): Promise<unknown>
  $(selector: string): Promise<PlaywrightLikeElement | null>
}

export interface PlaywrightLikeBrowser<TPage extends PlaywrightLikePage = PlaywrightLikePage> {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<TPage>
  close(): Promise<void>
  /** Playwright exposes this; a fake may not. Absent is treated as "still connected". */
  isConnected?(): boolean
}

export type LaunchBrowser<TPage extends PlaywrightLikePage = PlaywrightLikePage> =
  () => Promise<PlaywrightLikeBrowser<TPage>>

/** How long the warm browser survives with no captures before it is torn down. */
const BROWSER_IDLE_MS = 5 * 60_000

export const defaultLaunchBrowser: LaunchBrowser<CapturePage> = async () => {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: true })
  return browser as unknown as PlaywrightLikeBrowser<CapturePage>
}

interface WarmBrowser {
  browser: PlaywrightLikeBrowser<CapturePage>
  idleTimer: ReturnType<typeof setTimeout> | null
}

let warm: WarmBrowser | null = null
/** Serialises captures — see module doc. */
let captureTail: Promise<unknown> = Promise.resolve()

/**
 * When a launch last failed, and why.
 *
 * A self-hosted install with no Chromium on disk is a supported configuration:
 * headless capture simply falls back to the live editor bridge. But without
 * this memo, EVERY capture in such an install would pay a full failed launch
 * before falling back — on the innermost loop of the agent's fix-verify cycle.
 * Remembering the failure for a minute makes the fallback immediate, while
 * still letting an operator who installs the browser mid-session get headless
 * capture back without restarting the server.
 */
const LAUNCH_FAILURE_MEMO_MS = 60_000
let launchFailure: { at: number; message: string } | null = null

/** The remembered launch failure, if it is still fresh. `null` means "try again". */
export function rememberedLaunchFailure(now: number = Date.now()): string | null {
  if (!launchFailure) return null
  if (now - launchFailure.at >= LAUNCH_FAILURE_MEMO_MS) {
    launchFailure = null
    return null
  }
  return launchFailure.message
}

/** Test-only: forget a remembered launch failure. */
export function clearLaunchFailureMemo(): void {
  launchFailure = null
}

function scheduleBrowserTeardown(entry: WarmBrowser): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  // Deliberately NOT `.unref()`'d — `referenceRender.ts`'s `scheduleTeardown`
  // records the concrete failure that caused on this Bun version. The admin
  // server process is kept alive by `Bun.serve`'s listening socket anyway.
  entry.idleTimer = setTimeout(() => {
    if (warm !== entry) return
    warm = null
    void entry.browser.close().catch(() => {
      // already gone — nothing to close
    })
  }, BROWSER_IDLE_MS)
}

async function getWarmBrowser(launch: LaunchBrowser<CapturePage>): Promise<PlaywrightLikeBrowser<CapturePage>> {
  if (warm && (warm.browser.isConnected?.() ?? true)) return warm.browser
  if (warm?.idleTimer) clearTimeout(warm.idleTimer)
  warm = null
  try {
    const browser = await launch()
    launchFailure = null
    warm = { browser, idleTimer: null }
    return browser
  } catch (err) {
    launchFailure = { at: Date.now(), message: err instanceof Error ? err.message : String(err) }
    throw err
  }
}

export interface CapturePageOptions {
  viewport: { width: number; height: number }
  deviceScaleFactor?: number
  launchBrowser?: LaunchBrowser<CapturePage>
}

/**
 * Run `fn` against a fresh page on the warm browser, serialised against every
 * other capture, with the page closed and the idle teardown re-armed however
 * `fn` ends.
 *
 * A browser that fails to launch or dies mid-capture propagates its error to
 * the caller — the capture path treats that as a headless failure and falls
 * back to the live editor bridge, so an environment with no Chromium degrades
 * to today's behaviour rather than to a broken tool.
 */
export async function withCapturePage<T>(
  options: CapturePageOptions,
  fn: (page: CapturePage) => Promise<T>,
): Promise<T> {
  const previous = captureTail
  let release!: () => void
  captureTail = new Promise<void>((resolve) => { release = resolve })
  await previous.catch(() => {
    // A previous capture's failure is its caller's problem, never ours.
  })

  try {
    const launch = options.launchBrowser ?? defaultLaunchBrowser
    const browser = await getWarmBrowser(launch)
    const page = await browser.newPage({
      viewport: options.viewport,
      ...(options.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
    })
    try {
      return await fn(page)
    } finally {
      await page.close().catch(() => {
        // page already gone with its browser
      })
      if (warm) scheduleBrowserTeardown(warm)
    }
  } catch (err) {
    // A dead browser must not be handed to the next caller.
    if (warm && !(warm.browser.isConnected?.() ?? true)) warm = null
    throw err
  } finally {
    release()
  }
}

/**
 * In-flight prewarm, so N concurrent `prewarmCaptureBrowser` calls (two tabs
 * loading the same project) launch at most one Chromium.
 */
let prewarming: Promise<void> | null = null

/**
 * W9-5 lever 3 — launch the warm Chromium NOW, off the critical path, so the
 * first capture of a session does not pay the ~300-600 ms cold launch this
 * module's doc names.
 *
 * Called when a project is opened on the board (`GET /admin/api/studio/load`,
 * full loads only), because that is the moment we learn a capture is likely
 * and the moment there is idle time to spend. Fire-and-forget by contract:
 * every failure is swallowed (it is recorded in the launch-failure memo, which
 * is exactly what the real capture path reads), so an install with no Chromium
 * pays one failed launch per minute at most and never sees an error surface.
 *
 * Cheap and idempotent when there is nothing to do: already warm, already
 * launching, or a fresh remembered launch failure all return immediately. The
 * prewarmed browser arms the same `BROWSER_IDLE_MS` teardown a real capture
 * does, so a project opened and never captured releases it on the same timer.
 */
export function prewarmCaptureBrowser(launch: LaunchBrowser<CapturePage> = defaultLaunchBrowser): void {
  if (prewarming) return
  if (warm && (warm.browser.isConnected?.() ?? true)) return
  if (rememberedLaunchFailure()) return
  prewarming = getWarmBrowser(launch)
    .then(() => {
      if (warm) scheduleBrowserTeardown(warm)
    })
    .catch(() => {
      // Recorded in `launchFailure` by `getWarmBrowser`; the capture path is
      // the only thing that needs to know, and it reads that memo.
    })
    .finally(() => {
      prewarming = null
    })
}

/** Test-only: drop the warm browser without waiting for the idle timer. */
export async function closeWarmCaptureBrowser(): Promise<void> {
  const entry = warm
  warm = null
  prewarming = null
  if (!entry) return
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  await entry.browser.close().catch(() => {
    // already gone
  })
}
