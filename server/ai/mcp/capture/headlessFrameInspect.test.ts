/**
 * `inspectFrameHeadless` — the driver that lets `studio_computed_styles` and
 * `studio_measure_element` answer with NO editor tab open.
 *
 * **Faked: Chromium, and only Chromium.** Everything else is real — capture
 * token minting/revocation, the shared settle session, the readiness-report
 * validation, and the TypeBox validation of the inspect response. The fake
 * page stands in for exactly one thing this environment cannot do: paint a
 * DOM. It answers the two evaluate expressions the driver actually sends (the
 * readiness report, and the inspect global), so a driver that built the wrong
 * expression, mis-ordered the two hops, or skipped validation fails here.
 *
 * The reads themselves are covered against a real document in
 * `src/core/studio-capture/frameInspector.test.ts` — the same function runs in
 * both places, which is why neither suite has to re-test the other's half.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { AGENT_CAPTURE_INSPECT_GLOBAL, AGENT_CAPTURE_GLOBAL, type AgentCaptureReport } from '@core/studio-capture'
import { clearLaunchFailureMemo, closeWarmCaptureBrowser, type CapturePage, type PlaywrightLikeBrowser } from './browserPool'
import { liveCaptureGrantCount } from './captureToken'
import { inspectFrameHeadless } from './headlessFrameInspect'

const READY_REPORT: AgentCaptureReport = {
  status: 'ready',
  frames: [{ pageId: 'checkout', ok: true, cssWidth: 400, cssHeight: 800, nodeRects: [], warnings: [] }],
}

interface FakeOptions {
  report?: AgentCaptureReport
  /**
   * What the page's inspect global returns, verbatim. `undefined` means "use
   * the default success response"; `null` models a page with no inspect global
   * at all, which reaches the driver as a non-string.
   */
  inspectResponse?: unknown
  launchError?: string
}

/** Every expression the driver evaluated, so the wire hops can be asserted on. */
let evaluated: string[] = []
let navigations: string[] = []

function fakeLauncher(options: FakeOptions = {}) {
  evaluated = []
  navigations = []
  return async (): Promise<PlaywrightLikeBrowser<CapturePage>> => {
    if (options.launchError) throw new Error(options.launchError)
    const page: CapturePage = {
      async goto(url: string) { navigations.push(url); return null },
      async waitForTimeout() {},
      async waitForFunction() { return null },
      async evaluate(expression: string) {
        evaluated.push(expression)
        if (expression.includes(AGENT_CAPTURE_INSPECT_GLOBAL)) {
          return options.inspectResponse === undefined
            ? JSON.stringify({
              ok: true,
              result: {
                kind: 'computedStyles',
                pageId: 'checkout',
                nodeCount: 1,
                truncated: false,
                fontFamiliesInUse: ['Open Sans'],
                nodes: [{
                  nodeId: 'title',
                  tag: 'h1',
                  text: 'Checkout',
                  fontFamily: 'Open Sans',
                  fontSizePx: 26,
                  lineHeightPx: 36,
                  fontWeight: '600',
                  color: 'rgb(0, 0, 0)',
                  backgroundColor: 'rgba(0, 0, 0, 0)',
                  rect: { width: 320, height: 34 },
                }],
              },
            })
            : options.inspectResponse
        }
        return JSON.stringify(options.report ?? READY_REPORT)
      },
      async $() { return null },
      async screenshot() { return Buffer.alloc(0) },
      async close() {},
    }
    return {
      async newPage() { return page },
      async close() {},
      isConnected: () => true,
    }
  }
}

afterEach(async () => {
  clearLaunchFailureMemo()
  await closeWarmCaptureBrowser()
})

const REQUEST = { kind: 'computedStyles', pageId: 'checkout' } as const

describe('inspectFrameHeadless', () => {
  it('settles the capture page, then asks it the question — in that order, on one page', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      { launchBrowser: fakeLauncher(), baseUrl: 'http://localhost:3001' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.kind).toBe('computedStyles')

    expect(navigations).toHaveLength(1)
    expect(navigations[0]).toContain('/admin/agent-capture?token=')
    // Readiness first, inspect second — an inspect before the settle would
    // measure a mid-layout DOM and report it as a measurement.
    expect(evaluated).toHaveLength(2)
    expect(evaluated[0]).toContain(AGENT_CAPTURE_GLOBAL)
    expect(evaluated[1]).toContain(AGENT_CAPTURE_INSPECT_GLOBAL)
  })

  it('sends the request as a JSON string literal the page can parse back', async () => {
    await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: { kind: 'measure', pageId: 'checkout', selector: '.card' } },
      {
        launchBrowser: fakeLauncher({
          inspectResponse: JSON.stringify({
            ok: true,
            result: {
              kind: 'measure',
              pageId: 'checkout',
              frame: { width: 400, height: 800 },
              matched: 0,
              truncated: false,
              unmatched: [],
              elements: [],
            },
          }),
        }),
        baseUrl: 'http://localhost:3001',
      },
    )
    const inspectExpression = evaluated[1]!
    const argument = inspectExpression.slice(
      inspectExpression.indexOf('(') + 1,
      inspectExpression.lastIndexOf(')'),
    )
    // Two JSON hops: the driver embeds a JSON string as a JS string literal.
    expect(JSON.parse(JSON.parse(argument) as string)).toEqual({
      kind: 'measure',
      pageId: 'checkout',
      selector: '.card',
    })
  })

  it('revokes the capture grant however the call ends', async () => {
    const before = liveCaptureGrantCount()
    await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      { launchBrowser: fakeLauncher(), baseUrl: 'http://localhost:3001' },
    )
    expect(liveCaptureGrantCount()).toBe(before)

    await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      { launchBrowser: fakeLauncher({ inspectResponse: 42 }), baseUrl: 'http://localhost:3001' },
    )
    expect(liveCaptureGrantCount()).toBe(before)
  })

  it('names a browser that will not launch, so the caller can fall back for the RIGHT reason', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      { launchBrowser: fakeLauncher({ launchError: 'no chromium here' }), baseUrl: 'http://localhost:3001' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('headless-browser-unavailable')
    expect(out.error).toContain('no chromium here')
  })

  it('reports a frame that failed to render as that frame\'s own error, not as a missing page', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      {
        launchBrowser: fakeLauncher({
          report: { status: 'ready', frames: [{ pageId: 'checkout', ok: false, error: 'never settled' }] },
        }),
        baseUrl: 'http://localhost:3001',
      },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('headless-page-error')
    expect(out.error).toBe('never settled')
  })

  it('reports a page that no longer exists rather than answering about a different frame', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      {
        launchBrowser: fakeLauncher({
          report: { status: 'ready', frames: [{ pageId: 'somewhere-else', ok: true, cssWidth: 1, cssHeight: 1, nodeRects: [], warnings: [] }] },
        }),
        baseUrl: 'http://localhost:3001',
      },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('checkout')
  })

  it('refuses an inspect response it cannot validate instead of trusting the browser', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      {
        launchBrowser: fakeLauncher({ inspectResponse: JSON.stringify({ ok: true, result: { kind: 'computedStyles' } }) }),
        baseUrl: 'http://localhost:3001',
      },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('headless-inspect-failed')
    expect(out.error).toContain('could not validate')
  })

  it('surfaces the page\'s own refusal verbatim — it is a sentence, not a protocol error', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      {
        launchBrowser: fakeLauncher({ inspectResponse: JSON.stringify({ ok: false, error: 'No settled frame document for page "checkout".' }) }),
        baseUrl: 'http://localhost:3001',
      },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('headless-inspect-failed')
    expect(out.error).toBe('No settled frame document for page "checkout".')
  })

  it('says the inspect global was missing when the page returns a non-string', async () => {
    const out = await inspectFrameHeadless(
      { userId: 'u1', dir: '/tmp/no-such-project', request: REQUEST },
      { launchBrowser: fakeLauncher({ inspectResponse: null }), baseUrl: 'http://localhost:3001' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('headless-inspect-failed')
    expect(out.error).toContain('inspect global is missing')
  })
})
