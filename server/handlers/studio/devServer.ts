/**
 * devServer — the ONE dev-server process manager for the whole server
 * process. Owns one reused, idle-timed dev-server subprocess per project
 * (`ensureDevServer`, the blocking primitive `server/ai/mcp/tools/studio/
 * referenceRender.ts`'s `studio_render_reference` boots and screenshots
 * against — see that module for WHY a real subprocess is spawned rather
 * than executing anything in-process), plus three HTTP routes
 * (`tryServeStudioDevServer`) so the client can prewarm and observe the same
 * process ahead of the live-runtime canvas frames Track L is building
 * (`STUDIO-LIVE-CANVAS-PLAN.md` §2+).
 *
 * **Extracted from `referenceRender.ts` (L1 of that plan), mechanics
 * unchanged.** Everything below the boot-race — spawning the detected
 * script unmodified, parsing the printed "Local:" URL out of stdout/stderr
 * (ANSI-stripped first; see `stripAnsi`'s doc for the confirmed-necessary
 * regression this guards), capping the log, tearing the process down after
 * an idle window — is the same code that lived there, just no longer
 * duplicated: `referenceRender.ts` is now a CONSUMER of `ensureDevServer`,
 * not a second spawner.
 *
 * **Tier 2 (`run-project`), gated at the HTTP routes, not inside the
 * spawner.** `ensureDevServer` itself carries no trust check — it is the
 * exact same "boot or reuse a dev server" primitive `referenceRender.ts`
 * already called, unchanged in mechanics, and that tool has its own gate
 * (the `studio.run.project` MCP capability, granted per connector, never by
 * default). The two new BROWSER-facing routes that can start a process
 * (`status`, `start`) each call `requireTrustTier` before touching the
 * registry — a browser has no capability system standing in for consent, so
 * the project's own `.studio/meta.json` trust tier is the only gate it has.
 * `stop` is deliberately left ungated: a project demoted to a lower tier
 * mid-session must still be killable, and killing a process is never the
 * side a security boundary needs to protect.
 *
 * **The wire status never carries the dev server's own URL.** `phase`/
 * `pid`/`startedAt`/`log` only — sending a bare `localhost:<port>` to the
 * browser invites the same same-origin misuse the live-origin design (L2)
 * exists to avoid. The URL stays server-internal, read today by
 * `referenceRender.ts` and, later, by L2's proxy.
 *
 * **A `'failed'` entry is retained, not deleted**, so `GET status` can show
 * the boot failure's log tail — the plan's explicit ask. It is cleared on
 * the NEXT start attempt for that project (`ensureEntry` below), never on a
 * plain status poll.
 *
 * **Registry key is the resolved app root, not the raw project dir** — a
 * nested app (`apps/web/` inside the project directory) must not spawn two
 * dev servers for the same project because two different callers passed
 * `dir` and `dir/apps/web`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { resolveAppRoot } from './appRoot'
import { detectPackageManager, type PackageManager } from './installDeps'
import { minimalSubprocessEnv, type SpawnedProcessLike } from './subprocessRunner'
import { requireTrustTier } from './trustGate'

const ROUTE_PREFIX = '/admin/api/studio/dev-server'

/** The tier a browser-initiated dev-server start requires — named once so the gate and the refusal text can never disagree. */
const REQUIRED_TRUST_TIER = 'run-project' as const

const TRUST_REFUSAL_MESSAGE =
  'Running this project’s own dev server needs the highest trust tier (run-project) — promote the project deliberately before starting it.'

const BOOT_TIMEOUT_MS = 30_000
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

/** Injectable seams for tests — never touched by real callers. */
export interface DevServerOverrides {
  spawn?: (argv: string[], options: { cwd: string; env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'; stdin: 'ignore' }) => SpawnedProcessLike
  bootTimeoutMs?: number
}

const defaultSpawn: NonNullable<DevServerOverrides['spawn']> = (argv, options) =>
  Bun.spawn(argv, options) as unknown as SpawnedProcessLike

interface DevServerEntry {
  appRoot: string
  proc: SpawnedProcessLike
  packageManager: PackageManager
  devScript: string
  phase: 'booting' | 'ready' | 'failed'
  baseUrl: string | null
  urlPromise: Promise<string | null>
  log: string
  error: string | null
  pid: number | null
  startedAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Resolves once `phase` has left `'booting'` — `ensureDevServer` awaits it; the HTTP routes never do. */
  settled: Promise<void>
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

/**
 * Idle-teardown timer — reused by `referenceRender.ts` after every
 * successful `ensureDevServer` call, with whichever `idleTimeoutMs` its own
 * caller asked for.
 */
function scheduleTeardownInternal(entry: DevServerEntry, appRoot: string, idleTimeoutMs: number): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  // Deliberately NOT `.unref()`'d — on this Bun version, unref-ing a timer
  // created inside an async function that's the last live handle can starve
  // it of ever firing at all (confirmed empirically: the identical boot-race
  // timer below hung indefinitely with `.unref()` and fired correctly
  // without it). The admin server process this actually runs in is already
  // kept alive by `Bun.serve`'s listening socket regardless.
  entry.idleTimer = setTimeout(() => {
    if (servers.get(appRoot) === entry) servers.delete(appRoot)
    try {
      entry.proc.kill()
    } catch {
      // already exited
    }
  }, idleTimeoutMs)
}

/** `dir` is the project directory — resolves its app root internally, same convention as every other primitive here. */
export function scheduleDevServerIdleTeardown(dir: string, idleTimeoutMs: number): void {
  const appRoot = resolveAppRoot(dir)
  const entry = servers.get(appRoot)
  if (entry) scheduleTeardownInternal(entry, appRoot, idleTimeoutMs)
}

/** Races the printed-URL promise against a boot timeout, mutating `entry.phase` to its terminal value once decided. Never throws. */
async function raceBoot(entry: DevServerEntry, appRoot: string, bootTimeoutMs: number): Promise<void> {
  let bootTimer: ReturnType<typeof setTimeout> | undefined
  // Deliberately NOT `.unref()`'d — see `scheduleTeardownInternal`'s comment above.
  const timedOut = await Promise.race([
    entry.urlPromise.then(() => false),
    new Promise<boolean>((resolve) => {
      bootTimer = setTimeout(() => resolve(true), bootTimeoutMs)
    }),
  ])
  if (bootTimer) clearTimeout(bootTimer)

  // A later start attempt may already have replaced this entry (a 'failed'
  // one is cleared on the next `ensureEntry` call) — only mutate if this
  // entry is still the live one for `appRoot`.
  if (servers.get(appRoot) !== entry) return

  if (timedOut || !entry.baseUrl) {
    entry.phase = 'failed'
    entry.error = timedOut
      ? `Dev server ("${entry.packageManager} run ${entry.devScript}") did not print a Local URL within ${bootTimeoutMs}ms.`
      : `Dev server ("${entry.packageManager} run ${entry.devScript}") exited before printing a Local URL.`
    try {
      entry.proc.kill()
    } catch {
      // already exited
    }
    return
  }

  entry.phase = 'ready'
}

function spawnEntry(appRoot: string, overrides: DevServerOverrides): { ok: true; entry: DevServerEntry } | { ok: false; error: string } {
  const devScript = devScriptFor(appRoot)
  if (!devScript) {
    return { ok: false, error: `No "dev" or "start" script found in package.json at ${appRoot}.` }
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
  const entry: DevServerEntry = {
    appRoot,
    proc,
    packageManager,
    devScript,
    phase: 'booting',
    baseUrl: null,
    urlPromise,
    log: '',
    error: null,
    pid: proc.pid ?? null,
    startedAt: Date.now(),
    idleTimer: null,
    settled: Promise.resolve(),
  }
  servers.set(appRoot, entry)
  pumpAndWatch(entry, resolveUrl)

  const bootTimeoutMs = overrides.bootTimeoutMs ?? BOOT_TIMEOUT_MS
  entry.settled = raceBoot(entry, appRoot, bootTimeoutMs)
  return { ok: true, entry }
}

/** Reuses a live (`'booting'`/`'ready'`) entry; clears and respawns a `'failed'` one; spawns fresh otherwise. */
function ensureEntry(appRoot: string, overrides: DevServerOverrides): { ok: true; entry: DevServerEntry } | { ok: false; error: string } {
  const existing = servers.get(appRoot)
  if (existing && existing.phase !== 'failed') return { ok: true, entry: existing }
  if (existing) servers.delete(appRoot)
  return spawnEntry(appRoot, overrides)
}

export type EnsureDevServerResult =
  | { ok: true; baseUrl: string }
  | { ok: false; error: string; log: string }

/**
 * Blocking: boots (or reuses) `dir`'s dev server and resolves once it is
 * `'ready'` or has definitively failed. `referenceRender.ts`'s
 * `studio_render_reference` is the one caller — no trust check here, see
 * module doc for why.
 */
export async function ensureDevServer(dir: string, overrides: DevServerOverrides = {}): Promise<EnsureDevServerResult> {
  const appRoot = resolveAppRoot(dir)
  const created = ensureEntry(appRoot, overrides)
  if (!created.ok) return { ok: false, error: created.error, log: '' }

  await created.entry.settled
  if (created.entry.phase === 'ready' && created.entry.baseUrl) {
    return { ok: true, baseUrl: created.entry.baseUrl }
  }
  return { ok: false, error: created.entry.error ?? 'Dev server failed to boot.', log: created.entry.log }
}

// ---------------------------------------------------------------------------
// Non-blocking primitives — what the HTTP routes below call. Never await a
// boot: the caller polls `status` for the transition out of `'booting'`.
// ---------------------------------------------------------------------------

const DevServerStatusSchema = Type.Object({
  phase: Type.Union([
    Type.Literal('stopped'),
    Type.Literal('booting'),
    Type.Literal('ready'),
    Type.Literal('failed'),
  ]),
  pid: Type.Union([Type.Number(), Type.Null()]),
  startedAt: Type.Union([Type.Number(), Type.Null()]),
  /** Capped stdout+stderr tail — populated once boot fails, or while booting/ready. Never carries the dev server's own URL; see module doc. */
  log: Type.String(),
})
export type DevServerStatus = Static<typeof DevServerStatusSchema>

const STOPPED_STATUS: DevServerStatus = { phase: 'stopped', pid: null, startedAt: null, log: '' }

function statusOf(entry: DevServerEntry | undefined): DevServerStatus {
  if (!entry) return STOPPED_STATUS
  return { phase: entry.phase, pid: entry.pid, startedAt: entry.startedAt, log: entry.log }
}

/** Pure read of the current in-memory registry — no spawn, no filesystem beyond what `resolveAppRoot` already needs. */
export function getDevServerStatus(dir: string): DevServerStatus {
  const appRoot = resolveAppRoot(dir)
  return statusOf(servers.get(appRoot))
}

/**
 * Starts (or reuses) `dir`'s dev server WITHOUT waiting for it to boot —
 * returns the status immediately (`'booting'` on a fresh spawn, `'ready'` on
 * reuse). A synchronous failure (no dev/start script) reports `'failed'`
 * directly in the response without ever entering the registry — there is
 * nothing to retry against for that project until its `package.json` changes.
 */
export function startDevServer(dir: string, overrides: DevServerOverrides = {}): DevServerStatus {
  const appRoot = resolveAppRoot(dir)
  const created = ensureEntry(appRoot, overrides)
  if (!created.ok) return { phase: 'failed', pid: null, startedAt: null, log: created.error }
  return statusOf(created.entry)
}

/** Kills `dir`'s dev server if one is running and clears the registry entry. Idempotent — stopping an already-stopped project is a no-op. */
export function stopDevServer(dir: string): DevServerStatus {
  const appRoot = resolveAppRoot(dir)
  const entry = servers.get(appRoot)
  if (entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    servers.delete(appRoot)
    try {
      entry.proc.kill()
    } catch {
      // already exited
    }
  }
  return STOPPED_STATUS
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const DevServerActionBodySchema = Type.Object({ dir: Type.Optional(Type.String()) })

function serveStatus(url: URL): Response {
  const dir = resolveProjectDir(url.searchParams.get('dir'))
  const gate = requireTrustTier(dir, REQUIRED_TRUST_TIER, TRUST_REFUSAL_MESSAGE)
  if (!gate.ok) return gate.response
  return jsonResponse(getDevServerStatus(dir))
}

async function serveStart(req: Request, overrides: DevServerOverrides): Promise<Response> {
  const body = await readValidatedBody(req, DevServerActionBodySchema)
  if (!body) return badRequest('invalid dev-server body')
  const dir = resolveProjectDir(body.dir)
  const gate = requireTrustTier(dir, REQUIRED_TRUST_TIER, TRUST_REFUSAL_MESSAGE)
  if (!gate.ok) return gate.response
  return jsonResponse(startDevServer(dir, overrides))
}

async function serveStop(req: Request): Promise<Response> {
  const body = await readValidatedBody(req, DevServerActionBodySchema)
  if (!body) return badRequest('invalid dev-server body')
  const dir = resolveProjectDir(body.dir)
  // Deliberately ungated — see module doc.
  return jsonResponse(stopDevServer(dir))
}

/**
 * `GET  /admin/api/studio/dev-server/status?dir=<abs>` → `DevServerStatus`
 * `POST /admin/api/studio/dev-server/start   body: { dir? }` → `DevServerStatus`
 * `POST /admin/api/studio/dev-server/stop    body: { dir? }` → `DevServerStatus`
 *
 * `status` and `start` refuse below Tier 2 with 409
 * `{ error, code: 'trust-tier-required' }`; `stop` never refuses. See module
 * doc for the full rationale.
 *
 * `overrides` is a TEST-ONLY seam — the real dispatcher (`tryServeStudio` in
 * `../../studio.ts`) always calls sub-routers with exactly `(req, url,
 * pathname)`, so this defaults to `{}` (real `Bun.spawn`) for every
 * production call. A test that needs to drive `start` through a fake dev
 * server calls this function directly with a fourth argument, the same way
 * `installDeps.test.ts`/`deploy.test.ts` inject a fake spawn into the
 * primitive they're testing — this just threads it one layer further, to the
 * route itself, so the trust gate AND the boot mechanics can be exercised
 * through one real HTTP call.
 */
export async function tryServeStudioDevServer(
  req: Request,
  url: URL,
  pathname: string,
  overrides: DevServerOverrides = {},
): Promise<Response | null> {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return null

  try {
    if (pathname === `${ROUTE_PREFIX}/status` && req.method === 'GET') return serveStatus(url)
    if (pathname === `${ROUTE_PREFIX}/start` && req.method === 'POST') return await serveStart(req, overrides)
    if (pathname === `${ROUTE_PREFIX}/stop` && req.method === 'POST') return await serveStop(req)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    console.error('[studio:devServer]', err)
    return jsonResponse({ error: 'The dev server request could not be completed.' }, { status: 500 })
  }

  return null
}
