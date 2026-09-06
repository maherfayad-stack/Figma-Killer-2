/**
 * Agent-turn benchmark — everything a Studio chat turn costs on the server,
 * from the guide it regenerates before the subprocess exists to the capture
 * and compare loop the agent runs to check its own work.
 *
 * Four things are measured, in the order a turn pays for them:
 *
 *  1. **Project guide** (`generateStudioProjectGuide`) — called synchronously,
 *     on the critical path, on every real turn against an open project. Cold
 *     (no `.claude/`, no digest cache, no persisted `ProjectProfile`) and warm
 *     (everything already written, nothing changed — what every turn after the
 *     first pays, forever), plus `resolveProjectProfile` and the design-system
 *     digest underneath it.
 *
 *  2. **Turn → first stream line** — the real `streamClaudeCli` with a FAKE
 *     `claude` at the `spawn` seam (`lib/fakeClaudeCli.ts`), cold-spawned vs.
 *     served from the warm session pool. The fake answers instantly, so what
 *     is left in the number is exactly Studio's own pre-spawn work. Read it as
 *     "how much of a turn Studio pays for before the model has said a word",
 *     never as "how long a turn takes".
 *
 *  3. **MCP attachment per turn** — spawns, connector mints, MCP config writes
 *     and servers-per-config, counted off the real config file each spawn was
 *     handed. Servers × spawns is the per-turn MCP handshake count, and it is
 *     the number the warm session pool exists to drive to zero.
 *
 *  4. **Headless capture + `studio_compare`** — the innermost loop of the
 *     agent's fix-verify cycle, run for real: a real Chromium against the real
 *     capture route (served in-process, see `lib/captureHost.ts`), a real
 *     ts-morph parse behind the payload, real `sharp` clamping, real
 *     `pixelmatch` diffing. Single frame and a five-page batch, then a
 *     five-page `studio_compare` cold and cache-served.
 *
 * ## What runs where
 *
 * 1–3 are offline and deterministic: no network, no browser, no database, no
 * real `claude` binary. 4 needs a built `dist/` (for the capture entry) and a
 * Chromium Playwright can launch; without either it reports `skipped` with the
 * reason rather than failing the suite — the same posture `benches/browser.ts`
 * and `studioBoard.bench.ts` take. `bun run bench:browser:install` provides
 * the browser; `bun run build` provides the `dist/`.
 *
 * Fixture: a fresh copy of `studio-workspace/__canonical-fixture` into
 * `.tmp/benchmarks/`, made once per run. NEVER mutates anything under
 * `studio-workspace/` — it copies first, every run, and every mutation below
 * (board geometry, registered references, generated guides) lands in the copy.
 */
import { performance } from 'node:perf_hooks'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import type { BenchModule, BenchResult, BenchRow, BenchSection, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtNum, fmtBytes } from '../lib/stats'
import { log } from '../lib/log'
import { startCaptureHost } from '../lib/captureHost'
import { fakeClaudeCliSpawn, newFakeCliCounters, type FakeCliCounters } from '../lib/fakeClaudeCli'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

/**
 * The checked-in parser corpus: seven screens, a 46-file imported design
 * system, a real `.studio/` (boards, framework, meta with approved MCP
 * servers). It is the only fixture this bench needs and the only one it is
 * allowed to assume — an earlier revision preferred `studio-workspace/untitled`,
 * a project that no longer exists, and silently measured the fallback instead.
 */
const FIXTURE_REL = 'studio-workspace/__canonical-fixture'

/**
 * The five screens the capture batch and `studio_compare` run against — every
 * one of them backed by a real `.tsx` in the fixture. (`home` has a board frame
 * but no source file, so it is deliberately not one of them: it would resolve
 * to no page and quietly shrink the batch to four.)
 */
const BATCH_PAGE_IDS = ['page', 'page2', 'canonical-screen', 'non-canonical-screen', 'esim-activation'] as const
/** Frame width forced onto those five, so a 2x reference lands on dpr 2 exactly. */
const FRAME_W = 390

// ── Fixture plumbing ────────────────────────────────────────────────────────

/** Fresh copy, excluding `node_modules`/`.git`. Never touches `source` itself. */
function freshFixtureCopy(source: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop()
      return base !== 'node_modules' && base !== '.git'
    },
  })
}

/** Every artefact `generateStudioProjectGuide` owns — `CLAUDE.md` at the root included, or a "cold" run would find the guide already written and measure the wrong thing. */
function wipeGenerated(dir: string): void {
  rmSync(join(dir, '.claude'), { recursive: true, force: true })
  rmSync(join(dir, 'CLAUDE.md'), { force: true })
  rmSync(join(dir, '.studio', 'cache'), { recursive: true, force: true })
}

/** Strips any persisted `profile` key from `.studio/meta.json` so the next `resolveProjectProfile` call is a genuine cold probe. Always called between iterations, never inside a timed one. */
function stripPersistedProfile(dir: string): void {
  const path = join(dir, '.studio', 'meta.json')
  if (!existsSync(path)) return
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'profile' in parsed) {
      const { profile: _drop, ...rest } = parsed as Record<string, unknown>
      writeFileSync(path, JSON.stringify(rest, null, 2))
    }
  } catch {
    // Not parsable — leave it; the module under test degrades to {} itself.
  }
}

/**
 * Pin the five batch frames to one authored width in the COPY's `boards.json`,
 * so `captureDprFor` resolves a 2x reference to dpr 2 for every one of them and
 * the compare numbers are diff cost rather than resampling cost. Height is left
 * alone: a frame renders to its content's real height regardless, which is
 * exactly why the references below are sized from a probe capture instead of
 * from the authored geometry.
 */
function pinBatchFrameWidth(dir: string): void {
  const path = join(dir, '.studio', 'boards.json')
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const file = raw as { boards: Array<{ frames: Array<Record<string, unknown>> }> }
  for (const board of file.boards) {
    for (const frame of board.frames) {
      if (BATCH_PAGE_IDS.includes(frame.pageId as (typeof BATCH_PAGE_IDS)[number])) frame.width = FRAME_W
    }
  }
  writeFileSync(path, JSON.stringify(file, null, 2))
}

function solidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png)
}

function timeMs(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

async function timeMsAsync(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

function summaryRow(label: string, samples: number[], notes?: string): BenchRow {
  const s = summarize([...samples])
  return {
    label,
    inputs: { n: s.count },
    metrics: { mean: fmtMs(s.mean), p50: fmtMs(s.p50), p95: fmtMs(s.p95), max: fmtMs(s.max) },
    ...(notes ? { notes } : {}),
  }
}

function skippedSection(title: string, reason: string): BenchSection {
  return {
    title,
    rows: [{ label: 'skipped', metrics: { reason } }],
  }
}

// ── 1. Project guide ────────────────────────────────────────────────────────

async function guideSections(ctx: BenchContext, dir: string): Promise<{ sections: BenchSection[]; headline: Record<string, string> }> {
  const { generateStudioProjectGuide } = await import('../../../server/handlers/studio/projectGuide')
  const { resolveProjectProfile, reprobeProjectProfile } = await import('../../../server/handlers/studio/projectProbe')
  const { getOrBuildDesignSystemDigest } = await import('../../../server/handlers/studio/designSystemDigest')

  const coldIters = ctx.quick ? 3 : 5
  log.step(`generateStudioProjectGuide cold x${coldIters}`)
  const coldSamples: number[] = []
  for (let i = 0; i < coldIters; i++) {
    wipeGenerated(dir)
    stripPersistedProfile(dir)
    coldSamples.push(timeMs(() => generateStudioProjectGuide(dir)))
  }

  const warmIters = ctx.quick ? 10 : 30
  log.step(`generateStudioProjectGuide warm x${warmIters}`)
  wipeGenerated(dir)
  stripPersistedProfile(dir)
  generateStudioProjectGuide(dir) // establish — first call, not timed
  const warmSamples: number[] = []
  for (let i = 0; i < warmIters; i++) {
    warmSamples.push(timeMs(() => generateStudioProjectGuide(dir)))
  }

  const profileIters = ctx.quick ? 10 : 30
  log.step(`resolveProjectProfile uncached x${profileIters}`)
  const profileUncachedSamples: number[] = []
  for (let i = 0; i < profileIters; i++) {
    stripPersistedProfile(dir) // every call is a fresh cold probe
    profileUncachedSamples.push(timeMs(() => resolveProjectProfile(dir)))
  }

  log.step(`resolveProjectProfile cached (persisted) x${profileIters}`)
  reprobeProjectProfile(dir) // persists a profile once
  const profileCachedSamples: number[] = []
  for (let i = 0; i < profileIters; i++) {
    profileCachedSamples.push(timeMs(() => resolveProjectProfile(dir)))
  }

  const digestIters = ctx.quick ? 10 : 30
  log.step(`getOrBuildDesignSystemDigest warm x${digestIters}`)
  const profile = resolveProjectProfile(dir)
  getOrBuildDesignSystemDigest(dir, profile.designSystems ?? []) // establish cache
  const digestSamples: number[] = []
  for (let i = 0; i < digestIters; i++) {
    digestSamples.push(timeMs(() => getOrBuildDesignSystemDigest(dir, profile.designSystems ?? [])))
  }

  const cold = summarize([...coldSamples])
  const warm = summarize([...warmSamples])
  return {
    headline: { 'guide cold (mean)': fmtMs(cold.mean), 'guide warm (p50)': fmtMs(warm.p50) },
    sections: [
      {
        title: 'generateStudioProjectGuide',
        intro: `Fixture: ${FIXTURE_REL}. Cold = no .claude/, no digest cache, no persisted profile. Warm = everything already written, nothing changed since — the case every turn after the first pays.`,
        rows: [summaryRow('cold (first-ever call)', coldSamples), summaryRow('warm (nothing changed)', warmSamples)],
      },
      {
        title: 'resolveProjectProfile',
        intro:
          'Uncached = no persisted profile in .studio/meta.json (a project with no package.json/node_modules never gets one healed automatically). Cached = after something has persisted one.',
        rows: [
          summaryRow('uncached (fresh probe every call)', profileUncachedSamples),
          summaryRow('cached (persisted profile)', profileCachedSamples),
        ],
      },
      {
        title: 'getOrBuildDesignSystemDigest (warm)',
        intro: 'Cache already built — pays the stat-based cache-key scan (readdir + stat per CSS file) plus a cache-file read.',
        rows: [summaryRow('warm', digestSamples)],
      },
    ],
  }
}

// ── 2 + 3. Turn → first stream line, and per-turn MCP attachment ────────────

async function turnSections(
  ctx: BenchContext,
  projectsRoot: string,
  dir: string,
): Promise<{ sections: BenchSection[]; headline: Record<string, string> }> {
  const { streamClaudeCli } = await import('../../../server/ai/drivers/claudeCli')
  const { disposeAllWarmSessions } = await import('../../../server/ai/drivers/claudeCliSessionPool')
  const { endClaudeCliConversation } = await import('../../../server/ai/drivers/claudeCliWarmTurn')
  const { studioMcpTools } = await import('../../../server/ai/mcp/tools/studio')

  const dataRoot = join(ctx.outputDir, 'agent-turn-cli-data')
  rmSync(dataRoot, { recursive: true, force: true })
  mkdirSync(dataRoot, { recursive: true })

  type StreamRequest = Parameters<typeof streamClaudeCli>[0]
  type StreamOptions = Parameters<typeof streamClaudeCli>[1]

  const request = (conversationId: string): StreamRequest => ({
    systemPrompt: ['Bench prefix.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Tighten the padding on the checkout header.' }] }],
    tools: [],
    modelId: 'sonnet',
    modelCapabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
    credentials: { id: 'bench-cred', providerId: 'claudeCli', authMode: 'apiKey', apiKey: 'bench-token', baseUrl: null },
    signal: new AbortController().signal,
    bridge: { async callBrowser() { return { ok: false, error: 'no bridge in this bench' } } },
    workspaceDir: dir,
    toolContextBase: {
      db: {} as never,
      userId: 'bench-user',
      capabilities: ['ai.chat'],
      conversationId,
      snapshot: null,
    },
  })

  const options = (counters: FakeCliCounters, warm: boolean): StreamOptions => ({
    // Injected, never inherited: `claudeCliPlatformSupport()` disables this
    // provider on macOS (Keychain-held credentials), which would turn every
    // measurement below into one refusal event.
    platformSupport: { supported: true as const },
    spawn: fakeClaudeCliSpawn(counters),
    dataRoot,
    projectsRoot,
    serverPort: 3001,
    mintConnector: async () => ({ connectorId: 'bench-connector', token: 'bench-session-token' }),
    revokeConnector: async () => {},
    ...(warm ? {} : { disableWarmSession: true as const }),
  })

  /** One turn, timed to the first CLI-produced text event. */
  async function runTurn(req: StreamRequest, opts: StreamOptions): Promise<number> {
    const t0 = performance.now()
    let firstText = Number.NaN
    for await (const event of streamClaudeCli(req, opts)) {
      // `routing` is emitted before anything spawns; `text` is the first thing
      // that could only have come from the process.
      if (event.type === 'text' && Number.isNaN(firstText)) firstText = performance.now() - t0
    }
    return Number.isNaN(firstText) ? performance.now() - t0 : firstText
  }

  const iters = ctx.quick ? 4 : 12

  log.step(`cold turn → first stream line x${iters}`)
  const coldCounters = newFakeCliCounters()
  const coldSamples: number[] = []
  for (let i = 0; i < iters; i++) {
    // A new conversation each time: a cold turn is what a conversation's FIRST
    // turn pays, and reusing one id would leave a CLI transcript behind that
    // turns the next iteration into a resume.
    coldSamples.push(await runTurn(request(`bench-cold-${i}`), options(coldCounters, false)))
  }

  log.step(`warm turn → first stream line x${iters}`)
  const warmCounters = newFakeCliCounters()
  const warmOptions = options(warmCounters, true)
  const warmConversation = 'bench-warm'
  // The spawning turn — not timed: it is a cold turn by definition, and the
  // number this section is about is what every turn AFTER it costs.
  const spawnTurnMs = await runTurn(request(warmConversation), warmOptions)
  const warmSamples: number[] = []
  for (let i = 0; i < iters; i++) {
    warmSamples.push(await runTurn(request(warmConversation), warmOptions))
  }
  await endClaudeCliConversation(warmConversation)
  await disposeAllWarmSessions()

  const cold = summarize([...coldSamples])
  const warm = summarize([...warmSamples])

  const toolSchemaBytes = studioMcpTools.reduce(
    (total, tool) => total + JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length,
    0,
  )
  const serversPerSpawn = warmCounters.serversPerSpawn[0] ?? coldCounters.serversPerSpawn[0] ?? 0
  const turnsWarm = warmCounters.turnsServed

  return {
    headline: { 'turn cold (p50)': fmtMs(cold.p50), 'turn warm (p50)': fmtMs(warm.p50) },
    sections: [
      {
        title: 'Turn → first stream line (Studio-side only)',
        intro:
          'The real driver with a fake `claude` at the spawn seam, so the model contributes nothing to these numbers. What is left is the work Studio does before a subprocess could answer: guide regeneration, containment + routing, config dir, session-id derivation and transcript probe, connector mint, MCP config file, argv. Cold = a fresh conversation, warm = the same conversation served by its pooled process. This is NOT how long a turn takes; it is how much of one Studio pays for before the model has said a word.',
        rows: [
          summaryRow('cold (fresh conversation, new process)', coldSamples),
          summaryRow('warm (pooled process, same conversation)', warmSamples),
          {
            label: 'warm session spawning turn (once per conversation)',
            metrics: { elapsed: fmtMs(spawnTurnMs) },
            notes: 'Untimed in the warm sample above on purpose — a conversation pays this once.',
          },
        ],
        highlights: [
          `Warm is ${cold.p50 > 0 ? (cold.p50 / Math.max(warm.p50, 0.001)).toFixed(1) : '—'}x cheaper at p50 on Studio-side work alone, before the process-startup and MCP-handshake time a real binary would add on the cold path.`,
        ],
      },
      {
        title: 'MCP attachment per turn',
        intro:
          'Counted off the real `--mcp-config` file each spawn was handed, at spawn time. Every server in that file is one `initialize` + `tools/list` handshake the CLI performs at startup, so `spawns x servers` is the per-turn MCP round-trip count — the number the warm session pool exists to drive to zero.',
        rows: [
          {
            label: 'cold path',
            inputs: { turns: coldCounters.turnsServed },
            metrics: {
              spawns: fmtNum(coldCounters.spawns),
              'mcp config writes': fmtNum(coldCounters.mcpConfigWrites),
              'servers/spawn': fmtNum(serversPerSpawn),
              'handshakes/turn': fmtNum(coldCounters.turnsServed > 0 ? (coldCounters.spawns * serversPerSpawn) / coldCounters.turnsServed : 0),
            },
          },
          {
            label: 'warm path',
            inputs: { turns: turnsWarm },
            metrics: {
              spawns: fmtNum(warmCounters.spawns),
              'mcp config writes': fmtNum(warmCounters.mcpConfigWrites),
              'servers/spawn': fmtNum(serversPerSpawn),
              'handshakes/turn': (warmCounters.spawns * serversPerSpawn / Math.max(turnsWarm, 1)).toFixed(2),
            },
          },
          {
            label: 'servers attached',
            metrics: { names: [...warmCounters.serverNames].join(', ') || '—' },
            notes: 'From the fixture: Studio\'s own connector plus whatever `.studio/meta.json` has approved.',
          },
          {
            label: 'Studio tool surface (one `tools/list` per handshake)',
            inputs: { tools: studioMcpTools.length },
            metrics: { 'schema bytes': fmtBytes(toolSchemaBytes) },
          },
        ],
      },
    ],
  }
}

// ── 4. Headless capture + studio_compare ────────────────────────────────────

interface CaptureOutcome {
  sections: BenchSection[]
  headline: Record<string, string>
}

async function captureSections(ctx: BenchContext, dir: string): Promise<CaptureOutcome> {
  const staticDir = resolve(process.env.STATIC_DIR ?? join(REPO_ROOT, 'dist'))
  if (!existsSync(join(staticDir, 'agent-capture.html'))) {
    const reason = 'no built dist/agent-capture.html — run `bun run build` first'
    log.warn(reason)
    return {
      headline: { capture: 'skipped' },
      sections: [skippedSection('Headless capture', reason), skippedSection('studio_compare (5 pages)', reason)],
    }
  }

  const { captureFramesHeadless } = await import('../../../server/ai/mcp/capture/headlessCapture')
  const { closeWarmCaptureBrowser } = await import('../../../server/ai/mcp/capture/browserPool')
  const { registerDesignReference } = await import('../../../server/handlers/studio/designReferenceStore')
  const { studioCompareTool } = await import('../../../server/ai/mcp/tools/studio/compare')

  const previousOrigin = process.env.STUDIO_CAPTURE_ORIGIN
  const host = startCaptureHost(staticDir)
  process.env.STUDIO_CAPTURE_ORIGIN = host.baseUrl

  const restore = async (): Promise<void> => {
    await closeWarmCaptureBrowser()
    host.stop()
    if (previousOrigin === undefined) delete process.env.STUDIO_CAPTURE_ORIGIN
    else process.env.STUDIO_CAPTURE_ORIGIN = previousOrigin
  }

  try {
    const userId = 'bench-user'
    const first = BATCH_PAGE_IDS[0]

    // The first capture pays the Chromium launch. Timed on its own — a
    // self-hosted install pays it once per idle window, not once per compare.
    // It doubles as the sizing probe for the references registered below: a
    // frame renders to its CONTENT's height, which no authored geometry
    // predicts, and a reference of the wrong aspect makes `studio_compare`
    // refuse the page instead of measuring it.
    log.step('headless capture — first call (includes Chromium launch)')
    const t0 = performance.now()
    const probe = await captureFramesHeadless({
      userId,
      dir,
      pageIds: [...BATCH_PAGE_IDS],
      dpr: 2,
      purpose: 'measurement',
    })
    const launchInclusiveMs = performance.now() - t0
    if (!probe.ok) {
      const reason = `${probe.code}: ${probe.error.split('\n')[0]}`
      log.warn(`headless capture unavailable — ${reason}`)
      await restore()
      return {
        headline: { capture: 'skipped' },
        sections: [skippedSection('Headless capture', reason), skippedSection('studio_compare (5 pages)', reason)],
      }
    }
    const probedFrames = (probe.output.data as { frames: Array<{ pageId: string; ok: boolean; width?: number; height?: number }> }).frames
    const capturedSize = new Map(probedFrames.filter((f) => f.ok).map((f) => [f.pageId, { width: f.width ?? 0, height: f.height ?? 0 }]))

    const iters = ctx.quick ? 2 : 5

    log.step(`headless capture — single frame x${iters}`)
    const singleSamples: number[] = []
    for (let i = 0; i < iters; i++) {
      singleSamples.push(await timeMsAsync(() => captureFramesHeadless({ userId, dir, pageIds: [first] })))
    }

    log.step(`headless capture — ${BATCH_PAGE_IDS.length}-page batch x${iters}`)
    const batchSamples: number[] = []
    for (let i = 0; i < iters; i++) {
      batchSamples.push(await timeMsAsync(() => captureFramesHeadless({ userId, dir, pageIds: [...BATCH_PAGE_IDS] })))
    }

    // ── studio_compare, five pages ──────────────────────────────────────────
    log.step('registering a design reference per page')
    for (const pageId of BATCH_PAGE_IDS) {
      const size = capturedSize.get(pageId)
      if (!size || size.width === 0 || size.height === 0) {
        throw new Error(`the sizing probe produced no frame for "${pageId}" — cannot register a matching reference`)
      }
      // Exactly the bytes dpr 2 produced, so `captureDprFor` picks dpr 2 and
      // the comparison is exact rather than resampled or refused on aspect.
      const registered = await registerDesignReference(dir, new Uint8Array(solidPng(size.width, size.height)), { pageId })
      if (!registered.ok) throw new Error(`could not register a reference for ${pageId}: ${registered.error}`)
    }

    const compareCtx = { userId, signal: new AbortController().signal } as never
    const compareInput = { dir, pages: [...BATCH_PAGE_IDS], includeImages: false }
    interface CompareData { pass: boolean; passCount: number; errorCount: number; capturedVia: string; results: unknown[] }
    let lastCompare: { ok: boolean; data?: CompareData; error?: string } | null = null

    const compareIters = ctx.quick ? 2 : 3
    log.step(`studio_compare — ${BATCH_PAGE_IDS.length} pages, forced recapture x${compareIters}`)
    const compareColdSamples: number[] = []
    for (let i = 0; i < compareIters; i++) {
      compareColdSamples.push(
        await timeMsAsync(async () => {
          lastCompare = (await studioCompareTool.handler!({ ...compareInput, forceRecapture: true }, compareCtx)) as typeof lastCompare
        }),
      )
    }

    log.step(`studio_compare — ${BATCH_PAGE_IDS.length} pages, verdict cache x${compareIters}`)
    const compareCachedSamples: number[] = []
    for (let i = 0; i < compareIters; i++) {
      compareCachedSamples.push(await timeMsAsync(() => studioCompareTool.handler!(compareInput, compareCtx)))
    }

    const data = (lastCompare as { data?: CompareData } | null)?.data
    const verdict = data
      ? `capturedVia=${data.capturedVia}, ${data.passCount}/${data.results.length} passed, ${data.errorCount} errored`
      : 'no verdict returned'

    const single = summarize([...singleSamples])
    const batch = summarize([...batchSamples])
    const compareCold = summarize([...compareColdSamples])

    await restore()

    return {
      headline: {
        'capture 1 frame (p50)': fmtMs(single.p50),
        [`capture ${BATCH_PAGE_IDS.length} frames (p50)`]: fmtMs(batch.p50),
        'compare 5 pages (p50)': fmtMs(compareCold.p50),
      },
      sections: [
        {
          title: 'Headless capture (real Chromium, real route, no editor tab)',
          intro:
            'A real browser against the real `/admin/agent-capture` route, served in-process so the capture grant resolves (see `lib/captureHost.ts`). Everything behind it is real too: the ts-morph parse in the payload, the settle wait, element rasterisation, and the `sharp` resolution clamp. Frames are pinned to 390px wide and render to their content height.',
          rows: [
            {
              label: `first capture (${BATCH_PAGE_IDS.length} frames at dpr 2, includes Chromium launch)`,
              metrics: { elapsed: fmtMs(launchInclusiveMs) },
              notes: 'The Chromium launch is paid once per idle window by the warm browser pool, not once per capture. This call doubles as the sizing probe for the references below.',
            },
            summaryRow('single frame (warm browser)', singleSamples),
            summaryRow(`${BATCH_PAGE_IDS.length}-page batch (warm browser)`, batchSamples, 'One navigation for the whole batch — the reason a flow costs far less than N single captures.'),
            {
              label: 'per-frame cost in the batch',
              metrics: { mean: fmtMs(batch.mean / BATCH_PAGE_IDS.length) },
            },
          ],
        },
        {
          title: `studio_compare (${BATCH_PAGE_IDS.length} pages)`,
          intro:
            'The whole tool: board sync, page load, reference resolution, batched capture, pixelmatch diff, region scoring, verdict composition and cache write. Each page carries a reference at exactly the bytes its own dpr-2 capture produced, so every comparison is exact rather than resampled.',
          rows: [
            summaryRow('forced recapture (cache bypassed)', compareColdSamples),
            summaryRow('verdict cache served', compareCachedSamples, 'No capture, no diff — what a repeat call on an untouched page costs.'),
            {
              label: 'verdict',
              metrics: { result: verdict },
              notes:
                'The references are solid white, so every page legitimately FAILS its comparison — which is the point: a failing page walks the whole diff, region-scoring and worst-region path, and a bench that measured the cheap answer would be measuring the wrong thing. `errored` is the number that must stay 0.',
            },
          ],
        },
      ],
    }
  } catch (err) {
    await restore()
    throw err
  }
}

// ── Bench module ────────────────────────────────────────────────────────────

export const agentTurnBench: BenchModule = {
  name: 'agent-turn',
  title: 'Agent turn — guide, first stream line, MCP attachment, capture, compare',
  description:
    'Everything a Studio chat turn costs on the server: project-guide generation, Studio-side latency to the first stream line (cold vs warm session, fake CLI), per-turn MCP handshake count, and the real headless capture + studio_compare loop. Capture sections skip gracefully without dist/ or Chromium.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const source = resolve(REPO_ROOT, FIXTURE_REL)
    if (!existsSync(source)) {
      return {
        name: this.name,
        title: this.title,
        headline: { status: 'unavailable' },
        sections: [
          { title: 'Unavailable', rows: [{ label: 'fixture', metrics: { reason: `unavailable: ${FIXTURE_REL} does not exist` } }] },
        ],
      }
    }

    // `projectsRoot` is a real containment boundary for the driver
    // (`resolveClaudeCliWorkspaceCwd`), so the fixture copy has to live INSIDE
    // the root the bench hands it, not beside it.
    const projectsRoot = join(ctx.outputDir, 'agent-turn-projects')
    const dir = join(projectsRoot, 'canonical-fixture')
    log.step(`Copying fixture from ${FIXTURE_REL}`)
    freshFixtureCopy(source, dir)
    pinBatchFrameWidth(dir)

    const guide = await guideSections(ctx, dir)
    const turn = await turnSections(ctx, projectsRoot, dir)
    const capture = await captureSections(ctx, dir)

    return {
      name: this.name,
      title: this.title,
      headline: { ...guide.headline, ...turn.headline, ...capture.headline },
      sections: [...guide.sections, ...turn.sections, ...capture.sections],
    }
  },
}
