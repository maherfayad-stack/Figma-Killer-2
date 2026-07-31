/**
 * Studio MCP tool — 9.2 `studio_render_reference`, Tier 2 of the visual-audit
 * trio (WS-9.2). Boots the OPEN PROJECT's own dev server and screenshots a
 * route through a real headless browser — the "compare against the live one"
 * half of requirement 10.
 *
 * **Tier 2, not Tier 0/1.** Every other Studio MCP tool reads source
 * statically or writes it back; this one EXECUTES the project's own code —
 * whatever `scripts.dev` runs, including every dependency it imports. That is
 * exactly the blast-radius `studio.run.project` exists to gate: never granted
 * by default, never implicit to a connector (`mcp-tooling.md`'s "Never let a
 * tool publish, deploy, or run project code without an explicit, separately-
 * gated capability").
 *
 * **`route`, not `pageId`.** A Studio page (one parsed screen FILE) does not
 * always correspond to an addressable URL in the project's own dev server —
 * confirmed against the real eSIM corpus, whose `App.jsx` exposes exactly 3
 * of its 15 screens via a `?page=` query param; the rest (`ActivationFlowScreen`,
 * `DevicePickerSheet`, `SelectPackageSheet`, …) are reached only by simulating
 * in-app interaction (tapping "Install", picking a device), which this tool
 * does not drive. Guessing a route from a Studio slug would silently produce
 * a wrong reference image for most projects; requiring an explicit `route`
 * keeps the honesty this family is built on — the caller supplies whatever
 * addressing scheme the project's OWN router/URL-state actually uses.
 *
 * **Dev-server discovery, not a forced port.** Frameworks disagree on how to
 * request an ephemeral port (Vite: `--port`; Next: `--port`/`-p`; CRA: `PORT`
 * env) and some ignore a taken port by auto-incrementing (Vite). Forcing a
 * flag that doesn't apply to a given framework would silently do nothing —
 * more true to "any React repo" is to spawn the script UNCHANGED and parse
 * the URL it actually prints (`waitForServerUrl` below), which works
 * regardless of which port the framework picked or why.
 *
 * **Idle-timeout reuse.** A dev server is expensive to boot (module graph +
 * cold Vite/webpack compile), so a project's server is kept running and
 * reused across calls, torn down after `idleTimeoutMs` of no further
 * `studio_render_reference` calls for that project — never left running
 * forever, never re-booted on every single call either.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiTool } from '../../../runtime/types'
import { resolveProjectDir } from '../../../../handlers/studioProjects'
import { resolveAppRoot } from '../../../../handlers/studio/appRoot'
import { detectPackageManager, type PackageManager } from '../../../../handlers/studio/installDeps'
import { minimalSubprocessEnv, type SpawnedProcessLike } from '../../../../handlers/studio/subprocessRunner'

const BOOT_TIMEOUT_MS = 30_000
const NAV_TIMEOUT_MS = 20_000
/** Grace period after `load` for client-side React mount/render to settle — see the `goto` call site. */
const NAV_SETTLE_MS = 500
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000
const MAX_LOG_BYTES = 32_000
const DEV_SERVER_ENV_EXTRA_KEYS = ['APPDATA', 'LOCALAPPDATA', 'npm_config_cache'] as const

// Matches the printed "Local:" URL every mainstream React dev server emits
// (Vite, Next.js, CRA/webpack-dev-server, Remix) — deliberately generic
// rather than framework-specific regexes, see module doc.
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'<>]*/i

// Strips ANSI SGR escape sequences (`\x1b[...m`) before URL matching.
// CONFIRMED NECESSARY against the real eSIM corpus (Vite v8): Vite colorizes
// its "Local:" line by wrapping just the PORT DIGITS in their own escape
// codes — `http://localhost:\x1b[1m5173\x1b[22m/\x1b[39m` — which splits the
// `:` from the digits that follow it. Without stripping first, `:\d+` in
// `URL_PATTERN` never matches (the character right after `:` is an escape
// byte, not a digit), the optional port group is skipped entirely, and
// `[^\s"'<>]*` still greedily swallows the raw escape bytes into the
// "matched" URL — producing a garbage host Playwright's `page.goto` then
// hangs on (an invalid host takes its own long DNS/connect timeout to fail,
// rather than failing fast) instead of a clean navigation.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g // eslint-disable-line no-control-regex -- strips terminal color codes before URL matching

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '')
}

interface DevServerEntry {
  appRoot: string
  proc: SpawnedProcessLike
  packageManager: PackageManager
  baseUrl: string | null
  urlPromise: Promise<string | null>
  log: string
  idleTimer: ReturnType<typeof setTimeout> | null
}

/** Injectable seams for tests — never touched by real callers. */
export interface ReferenceRenderOverrides {
  spawn?: (argv: string[], options: { cwd: string; env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'; stdin: 'ignore' }) => SpawnedProcessLike
  launchBrowser?: () => Promise<PlaywrightLikeBrowser>
  bootTimeoutMs?: number
  navTimeoutMs?: number
}

/** The minimal `playwright-core` surface this tool needs — real `chromium.launch()` output satisfies it. */
export interface PlaywrightLikeBrowser {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor?: number }): Promise<PlaywrightLikePage>
  close(): Promise<void>
}
export interface PlaywrightLikePage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  screenshot(options: { type: 'png' }): Promise<Buffer>
  close(): Promise<void>
}

const defaultSpawn: NonNullable<ReferenceRenderOverrides['spawn']> = (argv, options) =>
  Bun.spawn(argv, options) as unknown as SpawnedProcessLike

const defaultLaunchBrowser = async (): Promise<PlaywrightLikeBrowser> => {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ headless: true })
  return browser as unknown as PlaywrightLikeBrowser
}

/** Per-process registry, keyed by resolved app root — one dev server per project, reused across calls. */
const servers = new Map<string, DevServerEntry>()

function devScriptFor(appRoot: string): string | null {
  const pkgPath = join(appRoot, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const scripts = (parsed as Record<string, unknown>).scripts
    if (!scripts || typeof scripts !== 'object') return null
    const map = scripts as Record<string, unknown>
    if (typeof map.dev === 'string') return 'dev'
    if (typeof map.start === 'string') return 'start'
    return null
  } catch {
    return null
  }
}

function capText(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length > MAX_LOG_BYTES ? combined.slice(combined.length - MAX_LOG_BYTES) : combined
}

/** Continuously drains stdout/stderr for the process's lifetime so a chatty dev server never stalls on a full pipe buffer — resolves `urlPromise` the first time a Local URL is seen, keeps draining after. */
function pumpAndWatch(entry: DevServerEntry, resolveUrl: (url: string | null) => void): void {
  let resolved = false
  const settle = (url: string | null) => {
    if (resolved) return
    resolved = true
    resolveUrl(url)
  }
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const chunk = decoder.decode(value, { stream: true })
        entry.log = capText(entry.log, chunk)
        if (!entry.baseUrl) {
          const cleanChunk = stripAnsi(chunk)
          const match = URL_PATTERN.exec(cleanChunk) ?? URL_PATTERN.exec(stripAnsi(entry.log))
          if (match) {
            entry.baseUrl = match[0].replace(/\/$/, '')
            settle(entry.baseUrl)
          }
        }
      }
    } catch {
      // stream errored/closed — nothing more to drain
    }
  }
  void pump(entry.proc.stdout)
  void pump(entry.proc.stderr)
  void entry.proc.exited.then(() => settle(null))
}

function scheduleTeardown(entry: DevServerEntry, appRoot: string, idleTimeoutMs: number): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  // Deliberately NOT `.unref()`'d — on this Bun version, unref-ing a timer
  // created inside an async function that's the last live handle can starve
  // it of ever firing at all (confirmed empirically: the identical boot-race
  // timer below hung indefinitely with `.unref()` and fired correctly
  // without it). The admin server process this actually runs in is already
  // kept alive by `Bun.serve`'s listening socket regardless.
  entry.idleTimer = setTimeout(() => {
    servers.delete(appRoot)
    try {
      entry.proc.kill()
    } catch {
      // already exited
    }
  }, idleTimeoutMs)
}

async function getOrStartDevServer(
  appRoot: string,
  overrides: ReferenceRenderOverrides,
): Promise<{ ok: true; baseUrl: string } | { ok: false; error: string; log: string }> {
  const existing = servers.get(appRoot)
  if (existing?.baseUrl) return { ok: true, baseUrl: existing.baseUrl }

  const devScript = devScriptFor(appRoot)
  if (!devScript) {
    return {
      ok: false,
      error: `No "dev" or "start" script found in package.json at ${appRoot}.`,
      log: '',
    }
  }
  const packageManager = detectPackageManager(appRoot)
  const spawn = overrides.spawn ?? defaultSpawn
  const proc = spawn([packageManager, 'run', devScript], {
    cwd: appRoot,
    env: minimalSubprocessEnv(DEV_SERVER_ENV_EXTRA_KEYS),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  let resolveUrl!: (url: string | null) => void
  const urlPromise = new Promise<string | null>((resolve) => { resolveUrl = resolve })
  const entry: DevServerEntry = { appRoot, proc, packageManager, baseUrl: null, urlPromise, log: '', idleTimer: null }
  servers.set(appRoot, entry)
  pumpAndWatch(entry, resolveUrl)

  const bootTimeoutMs = overrides.bootTimeoutMs ?? BOOT_TIMEOUT_MS
  let bootTimer: ReturnType<typeof setTimeout> | undefined
  // Deliberately NOT `.unref()`'d — see `scheduleTeardown`'s comment above.
  const timedOut = await Promise.race([
    urlPromise.then(() => false),
    new Promise<boolean>((resolve) => {
      bootTimer = setTimeout(() => resolve(true), bootTimeoutMs)
    }),
  ])
  if (bootTimer) clearTimeout(bootTimer)

  if (timedOut || !entry.baseUrl) {
    servers.delete(appRoot)
    try {
      proc.kill()
    } catch {
      // already exited
    }
    return {
      ok: false,
      error: timedOut
        ? `Dev server ("${packageManager} run ${devScript}") did not print a Local URL within ${bootTimeoutMs}ms.`
        : `Dev server ("${packageManager} run ${devScript}") exited before printing a Local URL.`,
      log: entry.log,
    }
  }

  return { ok: true, baseUrl: entry.baseUrl }
}

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
    ),
    route: Type.String({
      minLength: 1,
      description:
        'The path (+ optional query string) this project\'s OWN dev server serves the screen at, e.g. "/" or "/?page=homepage" — NOT necessarily the Studio page\'s slug. Call studio_project_profile / read the project\'s router or URL-state code first if unsure which routes exist.',
    }),
    width: Type.Optional(Type.Integer({ minimum: 200, maximum: 4000, description: 'Viewport width in px. Default 390.' })),
    height: Type.Optional(Type.Integer({ minimum: 200, maximum: 4000, description: 'Viewport height in px. Default 844.' })),
    dpr: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3, description: 'Device scale factor for the screenshot. Default 1.' })),
    idleTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 5_000, maximum: 30 * 60_000, description: 'How long to keep this project\'s dev server running after the last call before tearing it down. Default 120000 (2 min).' }),
    ),
  },
  { additionalProperties: false },
)

export function createReferenceRenderTool(overrides: ReferenceRenderOverrides = {}): AiTool {
  return {
    name: 'studio_render_reference',
    scope: 'shared',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ['studio.run.project'],
    description:
      'Tier 2: boots the OPEN PROJECT\'s own dev server (its "dev" or "start" script, via the detected package manager) and screenshots `route` through a real headless browser at the given viewport — the ground truth to compare a studio_export_frames capture against. Requires studio.run.project (never granted by default, never implicit) because this EXECUTES the project\'s own code, unlike every other Studio tool. `route` must be a path this project\'s OWN dev server actually serves (its router or URL-state, not necessarily the Studio page slug) — not every parsed Studio page has one; screens reached only via in-app interaction (a tap, a picked option) are not reachable this way. The dev server is reused across calls for the same project and torn down after `idleTimeoutMs` of inactivity. If the dev server fails to boot, returns ok:false with the captured stdout/stderr tail — never a synthetic result.',
    inputSchema: InputSchema,
    handler: async (input) => {
      const {
        dir: dirInput,
        route,
        width = 390,
        height = 844,
        dpr,
        idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
      } = input as {
        dir?: string
        route: string
        width?: number
        height?: number
        dpr?: number
        idleTimeoutMs?: number
      }

      const dir = resolveProjectDir(dirInput)
      const appRoot = resolveAppRoot(dir)

      const server = await getOrStartDevServer(appRoot, overrides)
      if (!server.ok) {
        // `error` is populated (not just `message`) so an MCP caller sees the
        // real reason — `server.ts`'s CallToolResult builder only forwards
        // `output.error` on an `ok:false` result, dropping any other field.
        return {
          ok: false,
          error: server.error,
          code: 'dev-server-failed-to-boot',
          message: server.error,
          log: server.log,
          dir,
          appRoot,
        }
      }
      const entry = servers.get(appRoot)
      if (entry) scheduleTeardown(entry, appRoot, idleTimeoutMs)

      const normalizedRoute = route.startsWith('/') ? route : `/${route}`
      const url = `${server.baseUrl}${normalizedRoute}`

      const launchBrowser = overrides.launchBrowser ?? defaultLaunchBrowser
      let browser: PlaywrightLikeBrowser | null = null
      try {
        browser = await launchBrowser()
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
        try {
          // `waitUntil: 'networkidle'` never fires against a dev server — Vite
          // (and every comparable dev server) keeps a persistent HMR WebSocket
          // open, so the network is never "idle." `'load'` fires once the
          // document + its initial resources finish loading; a short settle
          // delay afterward covers client-side React mount/render, which
          // completes after the load event, not as part of it.
          await page.goto(url, { waitUntil: 'load', timeout: overrides.navTimeoutMs ?? NAV_TIMEOUT_MS })
          await page.waitForTimeout(NAV_SETTLE_MS)
          const buffer = await page.screenshot({ type: 'png' })
          return aiToolOk(
            { ok: true, dir, appRoot, url, width, height, capturedAt: Date.now() },
            [{ mimeType: 'image/png', data: buffer.toString('base64') }],
          )
        } finally {
          await page.close()
        }
      } catch (err) {
        return aiToolError(
          `Could not render ${url}: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        if (browser) await browser.close()
      }
    },
  }
}

export const referenceRenderTool: AiTool = createReferenceRenderTool()
export const studioReferenceMcpTools: AiTool[] = [referenceRenderTool]
