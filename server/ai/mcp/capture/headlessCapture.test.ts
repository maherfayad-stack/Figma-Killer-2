/**
 * Headless agent capture, end to end — including W4-2A's definition of done:
 * `studio_compare` across FIVE pages of a real workspace with NO editor bridge
 * connected.
 *
 * ## What is real here, and what is faked
 *
 * **Real:** the fixture workspace on disk (five scaffolded `.tsx` pages, a
 * `.studio/boards.json` with authored frame geometry, registered design
 * references); the actual `tryServeAgentCapture` route handler; capture-token
 * minting, resolution and revocation; the payload builder running the real
 * `loadStudioPages` parse pipeline; the capture driver
 * (`captureFramesHeadless`) and its warm-browser pool; the resolution clamp;
 * and the whole of `studio_compare` — reference resolution, dpr selection,
 * `pixelmatch` diffing, region scoring, verdict composition and the verdict
 * cache.
 *
 * **Faked: Chromium, and only Chromium.** `playwright-core` is mocked at the
 * module boundary, so `defaultLaunchBrowser` gets a fake browser instead of a
 * real one — CI has no browser binary, and installing one would make this
 * suite depend on a ~150MB download. The fake is deliberately not a stub of
 * the capture flow: its `goto` calls the REAL route handler with the token it
 * finds in the navigation URL and validates the response against the shared
 * payload schema, so a broken route, a rejected token, a mis-scoped grant or a
 * malformed payload fails these tests exactly as it would fail a real capture.
 * What the fake replaces is rasterisation: it returns a solid PNG at the size
 * Chromium would have produced for the frame's authored geometry and the
 * requested device scale factor.
 *
 * The route is invoked as a function rather than over a socket because this
 * suite's preload (`src/__tests__/setup.ts`) installs happy-dom's `Response`
 * as the global, which `Bun.serve` cannot serialise — so a real listener would
 * be testing happy-dom, not the route. Wiring a handler into `Bun.serve` is
 * `server/router.ts`'s job and is covered there.
 *
 * So: every server-side hop is exercised for real, and the one thing this
 * environment genuinely cannot run — a browser painting a DOM — is the one
 * thing standing in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { parseBoardsFile, serializeBoardsFile, upsertFrame } from '@core/studio-board'
import { AgentCapturePayloadSchema, type AgentCaptureReport } from '@core/studio-capture'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { createScaffoldedPage } from '../../../handlers/studio/pageScaffold'
import { registerDesignReference } from '../../../handlers/studio/designReferenceStore'
import { tryServeAgentCapture } from './captureRoute'

// ---------------------------------------------------------------------------
// The fake Chromium — see module doc for exactly what it does and does not fake
// ---------------------------------------------------------------------------

interface FakePageState {
  deviceScaleFactor: number
  report: AgentCaptureReport | null
  frameSizes: Map<string, { cssWidth: number; cssHeight: number }>
}

/** Every navigation the fake browser performed, for asserting on the URL the driver built. */
let navigations: string[] = []
/** Set to make `newPage` throw, standing in for a host with no browser binary. */
let launchShouldFail: string | null = null

function makeFakePage() {
  const state: FakePageState = { deviceScaleFactor: 1, report: null, frameSizes: new Map() }

  return {
    state,
    page: {
      async goto(url: string): Promise<unknown> {
        navigations.push(url)
        // The REAL route handler, with the token the driver put in the URL —
        // this is what makes the route, the grant and the payload builder
        // genuinely under test.
        const target = new URL(url)
        const token = target.searchParams.get('token') ?? ''
        const res = await requestCaptureRoute('/admin/api/agent-capture/payload', token)
        if (!res.ok) {
          state.report = { status: 'error', error: `payload endpoint returned ${res.status}` }
          return null
        }
        const parsed = safeParseValue(AgentCapturePayloadSchema, JSON.parse(await res.text()))
        if (!parsed.ok) {
          state.report = { status: 'error', error: `payload failed validation: ${parsed.error}` }
          return null
        }
        // Stand in for "every frame mounted and settled": report each frame at
        // its authored size, with one node rect for the page root so the
        // region→node mapping downstream has something real to work with.
        const payload = parsed.value
        state.report = {
          status: 'ready',
          frames: payload.frames.map((frame) => {
            state.frameSizes.set(frame.pageId, { cssWidth: frame.width, cssHeight: frame.height })
            const page = payload.pages.find((p) => p.id === frame.pageId)
            return {
              pageId: frame.pageId,
              ok: true as const,
              cssWidth: frame.width,
              cssHeight: frame.height,
              nodeRects: page
                ? [{ nodeId: page.rootNodeId, x: 0, y: 0, width: frame.width, height: frame.height }]
                : [],
              warnings: [],
            }
          }),
        }
        return null
      },
      async waitForTimeout(): Promise<void> {},
      async waitForFunction(): Promise<unknown> {
        if (!state.report) throw new Error('never became ready')
        return null
      },
      async evaluate(): Promise<unknown> {
        return JSON.stringify(state.report)
      },
      async $(selector: string) {
        const match = /"(.+)"/.exec(selector)
        const pageId = match?.[1]
        const size = pageId ? state.frameSizes.get(pageId) : undefined
        if (!size) return null
        return {
          async screenshot(): Promise<Buffer> {
            return solidPng(
              Math.round(size.cssWidth * state.deviceScaleFactor),
              Math.round(size.cssHeight * state.deviceScaleFactor),
            )
          },
        }
      },
      async screenshot(): Promise<Buffer> {
        return solidPng(1, 1)
      },
      async close(): Promise<void> {},
    },
  }
}

mock.module('playwright-core', () => ({
  chromium: {
    launch: async () => {
      if (launchShouldFail) throw new Error(launchShouldFail)
      return {
        isConnected: () => true,
        async newPage(options: { deviceScaleFactor?: number }) {
          const fake = makeFakePage()
          fake.state.deviceScaleFactor = options.deviceScaleFactor ?? 1
          return fake.page
        },
        async close(): Promise<void> {},
      }
    },
  },
}))

const { captureFramesHeadless } = await import('./headlessCapture')
const { clearLaunchFailureMemo, closeWarmCaptureBrowser } = await import('./browserPool')
const { liveCaptureGrantCount } = await import('./captureToken')
const { studioCompareTool } = await import('../tools/studio/compare')

function solidPng(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0]
    png.data[i + 1] = rgb[1]
    png.data[i + 2] = rgb[2]
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

// ---------------------------------------------------------------------------
// Fixture workspace + a live server running the real capture route
// ---------------------------------------------------------------------------

let dir: string

/**
 * A capture origin that never actually listens. The driver builds its URL
 * through `captureOrigin.ts` (exercising that helper's override path) and the
 * fake browser routes it to the handler directly — see module doc for why
 * there is no socket.
 */
const CAPTURE_ORIGIN = 'http://127.0.0.1:59999'

/** Call the real capture route the way the server's dispatcher would. */
async function requestCaptureRoute(
  pathname: string,
  token: string,
  init?: { method?: string; search?: string },
): Promise<Response> {
  const search = init?.search ?? `?token=${encodeURIComponent(token)}`
  const url = new URL(`${CAPTURE_ORIGIN}${pathname}${search}`)
  const req = new Request(url.href, { method: init?.method ?? 'GET' })
  const response = await tryServeAgentCapture(req, url, url.pathname)
  // `null` means "not my namespace" — never expected for these paths, and a
  // silent fall-through would look like a 404 in the assertions below.
  if (!response) throw new Error(`capture route did not claim ${pathname}`)
  return response
}

beforeAll(() => {
  process.env.STUDIO_CAPTURE_ORIGIN = CAPTURE_ORIGIN
})

afterAll(async () => {
  delete process.env.STUDIO_CAPTURE_ORIGIN
  await closeWarmCaptureBrowser()
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-headless-capture-'))
  navigations = []
  launchShouldFail = null
  clearLaunchFailureMemo()
})

afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true })
  await closeWarmCaptureBrowser()
})

/** Scaffolds a page and sets its board frame's AUTHORED (CSS px) size. */
function scaffoldPageAt(name: string, width: number, height: number): string {
  const scaffolded = createScaffoldedPage(dir, name)
  if (!scaffolded.ok) throw new Error(scaffolded.conflict)
  const boardsPath = path.join(dir, '.studio', 'boards.json')
  const boardsFile = parseBoardsFile(fs.readFileSync(boardsPath, 'utf8'))
  const board = boardsFile.boards[0]!
  const frame = board.frames.find((f) => f.pageId === scaffolded.pageId)!
  const updatedBoard = upsertFrame(board, { id: frame.id, pageId: frame.pageId, x: frame.x, y: frame.y, width, height })
  fs.writeFileSync(
    boardsPath,
    serializeBoardsFile({ ...boardsFile, boards: boardsFile.boards.map((b) => (b.id === board.id ? updatedBoard : b)) }),
  )
  return scaffolded.pageId
}

interface CapturedFrame {
  pageId: string
  ok: boolean
  width?: number
  height?: number
  imageIndex?: number
  imageScale?: number
  nodeRects?: unknown[]
  error?: string
}

// ---------------------------------------------------------------------------

describe('captureFramesHeadless', () => {
  it('captures a page with no editor tab involved, through the real route and grant', async () => {
    const pageId = scaffoldPageAt('Checkout', 390, 844)

    const result = await captureFramesHeadless({ userId: 'u1', dir, pageIds: [pageId] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.output.data as { frames: CapturedFrame[]; source: string }
    expect(data.source).toBe('headless')
    expect(data.frames).toHaveLength(1)
    const frame = data.frames[0]!
    expect(frame.ok).toBe(true)
    expect(frame.pageId).toBe(pageId)
    expect(frame.width).toBe(390)
    expect(frame.height).toBe(844)
    expect(result.output.images).toHaveLength(1)

    // The navigation carried a token, and it went to the canonical route.
    expect(navigations).toHaveLength(1)
    const navigated = new URL(navigations[0]!)
    expect(navigated.pathname).toBe('/admin/agent-capture')
    expect(navigated.searchParams.get('token')).toMatch(/^icap_/)
  })

  it('revokes the capture grant when the capture ends', async () => {
    const pageId = scaffoldPageAt('Checkout', 390, 844)
    const before = liveCaptureGrantCount()

    await captureFramesHeadless({ userId: 'u1', dir, pageIds: [pageId] })

    // The token in the URL is dead the moment the capture finished — the TTL is
    // only the net, and this is the boundary.
    expect(liveCaptureGrantCount()).toBe(before)
    const token = new URL(navigations[0]!).searchParams.get('token')!
    const res = await requestCaptureRoute('/admin/api/agent-capture/payload', token)
    expect(res.status).toBe(404)
  })

  it('renders at the requested dpr and reports imageScale from the real captured bytes', async () => {
    const pageId = scaffoldPageAt('Checkout', 390, 500)

    const result = await captureFramesHeadless({ userId: 'u1', dir, pageIds: [pageId], dpr: 2, purpose: 'measurement' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const frame = (result.output.data as { frames: CapturedFrame[] }).frames[0]!
    expect(frame.width).toBe(780)
    expect(frame.height).toBe(1000)
    expect(frame.imageScale).toBe(2)
  })

  it('applies the vision cap to a tall frame instead of honouring dpr blindly', async () => {
    // 390x1200 at dpr 2 would be 2400px tall — past the ~1568px vision edge.
    const pageId = scaffoldPageAt('Tall', 390, 1200)

    const result = await captureFramesHeadless({ userId: 'u1', dir, pageIds: [pageId], dpr: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const frame = (result.output.data as { frames: CapturedFrame[] }).frames[0]!
    expect(frame.height!).toBeLessThanOrEqual(1568)
    // `imageScale` must describe the bytes that actually came back, not the dpr
    // that was asked for — otherwise every region→node mapping is wrong.
    expect(frame.imageScale!).toBeCloseTo(frame.width! / 390, 5)
    expect(frame.imageScale!).toBeLessThan(2)

    // `purpose: 'measurement'` lifts that clamp — the same frame keeps true 2x.
    const measured = await captureFramesHeadless({ userId: 'u1', dir, pageIds: [pageId], dpr: 2, purpose: 'measurement' })
    expect(measured.ok).toBe(true)
    if (!measured.ok) return
    const measuredFrame = (measured.output.data as { frames: CapturedFrame[] }).frames[0]!
    expect(measuredFrame.height).toBe(2400)
    expect(measuredFrame.imageScale).toBe(2)
  })

  it('captures five pages in ONE navigation', async () => {
    const ids = ['Home', 'Cart', 'Checkout', 'Confirm', 'Account'].map((n) => scaffoldPageAt(n, 390, 500))

    const result = await captureFramesHeadless({ userId: 'u1', dir, pageIds: ids })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.output.data as { frames: CapturedFrame[] }
    expect(data.frames.map((f) => f.pageId)).toEqual(ids)
    expect(data.frames.every((f) => f.ok)).toBe(true)
    expect(result.output.images).toHaveLength(5)
    // The whole point of rendering the batch on one page: five screens, one
    // browser navigation, instead of five bridge round trips.
    expect(navigations).toHaveLength(1)
  })

  it('names a browser that will not launch, rather than reporting a missing board', async () => {
    const pageId = scaffoldPageAt('Checkout', 390, 844)
    launchShouldFail = 'Executable does not exist at /nope/chrome'

    const result = await captureFramesHeadless({ userId: 'u1', dir, pageIds: [pageId] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('headless-browser-unavailable')
    expect(result.error).toContain('Executable does not exist')
    // Even on the failure path the grant is revoked.
    const token = navigations[0] ? new URL(navigations[0]).searchParams.get('token') : null
    expect(token).toBeNull()
  })

  it('reports a page that no longer exists as a payload failure, not a crash', async () => {
    scaffoldPageAt('Checkout', 390, 844)

    const result = await captureFramesHeadless({ userId: 'u1', dir, pageIds: ['pages/Ghost.tsx'] })

    // The payload endpoint 404s (no requested page resolved), so the page
    // reports an error status and the driver surfaces it verbatim.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('headless-page-error')
    expect(result.error).toContain('404')
  })
})

describe('the capture route', () => {
  it('404s without a token, with a bad token, and for a non-GET', async () => {
    expect((await requestCaptureRoute('/admin/agent-capture', '', { search: '' })).status).toBe(404)
    expect((await requestCaptureRoute('/admin/agent-capture', 'icap_bogus')).status).toBe(404)
    expect((await requestCaptureRoute('/admin/api/agent-capture/payload', 'icap_bogus')).status).toBe(404)
    expect(
      (await requestCaptureRoute('/admin/api/agent-capture/asset', '', { search: '?token=icap_bogus&path=a.png' })).status,
    ).toBe(404)
    // A valid token does not make the namespace accept a write method.
    const { mintCaptureToken, revokeCaptureToken } = await import('./captureToken')
    const token = mintCaptureToken({ userId: 'u1', dir, pageIds: ['p'] })
    try {
      expect((await requestCaptureRoute('/admin/agent-capture', token, { method: 'POST' })).status).toBe(404)
    } finally {
      revokeCaptureToken(token)
    }
  })

  it('serves only the pages the grant names', async () => {
    const wanted = scaffoldPageAt('Checkout', 390, 844)
    scaffoldPageAt('Secret', 390, 844)

    const { mintCaptureToken, revokeCaptureToken } = await import('./captureToken')
    const token = mintCaptureToken({ userId: 'u1', dir, pageIds: [wanted] })
    try {
      const res = await requestCaptureRoute('/admin/api/agent-capture/payload', token)
      expect(res.status).toBe(200)
      const parsed = safeParseValue(AgentCapturePayloadSchema, JSON.parse(await res.text()))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      // A grant is scoped to a page SET, not just a project: the other page in
      // the same workspace is not in the payload.
      expect(parsed.value.pages.map((p) => p.id)).toEqual([wanted])
      expect(parsed.value.frames.map((f) => f.pageId)).toEqual([wanted])
      expect(parsed.value.dir).toBe(dir)
    } finally {
      revokeCaptureToken(token)
    }
  })
})

describe('W4-2A definition of done — studio_compare across 5 pages, no editor bridge', () => {
  it('completes with verdicts for every page and never touches an editor tab', async () => {
    const names = ['Home', 'Cart', 'Checkout', 'Confirm', 'Account']
    const pageIds = names.map((name) => scaffoldPageAt(name, 390, 500))
    for (const pageId of pageIds) {
      // A 780x1000 reference is exactly 2x the 390x500 frame, so `captureDprFor`
      // picks dpr 2 and the comparison is EXACT rather than resampled.
      const registered = await registerDesignReference(dir, new Uint8Array(solidPng(780, 1000)), { pageId })
      if (!registered.ok) throw new Error(registered.error)
    }

    const result = (await studioCompareTool.handler!(
      { dir, pages: names, includeImages: false },
      { userId: 'u1', signal: new AbortController().signal } as never,
    )) as {
      ok: boolean
      data?: {
        pass: boolean
        passCount: number
        errorCount: number
        capturedVia: string
        results: Array<{ ok: boolean; pass?: boolean; capture?: { dimensionMatch: string; dpr: number }; error?: string }>
      }
    }

    expect(result.ok).toBe(true)
    const data = result.data!
    // No bridge exists in this process — `editorBridge`'s registry is empty and
    // nothing registered one. Had the capture needed a tab, this would be an
    // "No Studio board is connected" error instead of five verdicts.
    expect(data.capturedVia).toBe('headless')
    expect(data.results).toHaveLength(5)
    expect(data.errorCount).toBe(0)
    expect(data.passCount).toBe(5)
    expect(data.pass).toBe(true)
    for (const page of data.results) {
      expect(page.ok).toBe(true)
      expect(page.capture!.dimensionMatch).toBe('exact')
      expect(page.capture!.dpr).toBe(2)
    }

    // Five screens measured; the five frames shared one dpr, so one navigation.
    expect(navigations).toHaveLength(1)
    // A generous timeout because this is genuinely five ts-morph parses plus
    // five pixelmatch diffs, running alongside three other worker processes
    // (`bun test --parallel=4`) — the default 5s is CPU contention, not a
    // regression signal.
  }, 60_000)
})
