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
 *
 * **A ready dev server outlives this process, and is adopted back (`live-11`).**
 * The registry is in-memory, but the Vite child is not: `bun --watch`
 * restarts this server in place on every source change (and a crash or a
 * deploy restarts it for real), and each restart used to forget every child
 * it had spawned. The children kept running — one orphaned Vite per restart,
 * still bound to its port — while the proxy answered `'stopped'` and the
 * next board open spawned yet another. So the moment an entry reaches
 * `'ready'` its `{pid, baseUrl, projectKey}` is written to
 * `devServerStateDir()` (`.tmp/dev-servers/`, machine-local, never inside
 * the user's project), and `ensureEntry` on a registry miss first tries to
 * ADOPT that record: the pid must still be alive, and the recorded origin
 * must still answer at the project's own base path. An adopted entry has no
 * stdout to pump — it is watched by polling its pid — and is otherwise a
 * first-class entry: same phases, same `stop`, same exit demotion.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { STUDIO_PARENT_ORIGINS_ENV, STUDIO_PROJECT_KEY_ENV } from '@core/studio-runtime'
import { registeredMcpServerProjectKey } from '../../ai/drivers/registeredMcpServers'
import { readServerConfig } from '../../config'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { resolveAppRoot } from './appRoot'
import {
  deleteDevServerRecord,
  isProcessAlive,
  probeDevServerOrigin,
  readDevServerRecord,
  writeDevServerRecord,
} from './devServerRecords'
import { resolveDevScript, resolveLiveCapability } from './liveCapability'
import { detectPackageManager, type PackageManager } from './packageManager'
import { minimalSubprocessEnv, type SpawnedProcessLike } from './subprocessRunner'
import { requireTrustTier } from './trustGate'

/**
 * Env var name the spawned dev-server subprocess reads its live-origin base
 * path from — exact string, shared by the spawn call below and the
 * generated `vite.config.js` template's `process.env` read
 * (`prototypeShell/shellFiles.ts`'s `VITE_CONFIG`, which imports this
 * constant rather than repeating the string literal, so the two can never
 * drift apart).
 */
export const STUDIO_LIVE_BASE_PATH_ENV = 'STUDIO_LIVE_BASE_PATH'

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
  /** Whether a recorded pid is still running — adoption's first check. Default: signal 0. */
  isProcessAlive?: (pid: number) => boolean
  /** Whether a recorded origin still serves the project at `basePath` — adoption's second check. Default: one bounded `fetch`. */
  probe?: (baseUrl: string, basePath: string) => Promise<boolean>
}

const defaultSpawn: NonNullable<DevServerOverrides['spawn']> = (argv, options) =>
  Bun.spawn(argv, options) as unknown as SpawnedProcessLike

/** How often an adopted process's pid is re-checked, standing in for the `exited` promise a spawned child has. */
const ADOPTED_EXIT_POLL_MS = 1_000

interface DevServerEntry {
  appRoot: string
  proc: SpawnedProcessLike
  packageManager: PackageManager
  /** `registeredMcpServerProjectKey(dir)` — the base path the child was told to serve under, kept so the record can be checked against it on adoption. */
  projectKey: string
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
            // `localhost` is pinned to IPv4 here for the same reason the
            // generated `vite.config.js` pins `server.host`: the name can
            // resolve to ::1 for the dev server and 127.0.0.1 for this proxy,
            // and then the two are talking about different sockets. A config
            // the user edited may still print `localhost`; the proxy must not
            // guess which stack it bound.
            entry.baseUrl = match[0].replace(/\/$/, '').replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1')
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
    deleteDevServerRecord(appRoot)
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
  writeDevServerRecord({
    appRoot,
    projectKey: entry.projectKey,
    pid: entry.pid ?? 0,
    baseUrl: entry.baseUrl,
    startedAt: entry.startedAt,
    packageManager: entry.packageManager,
    devScript: entry.devScript,
  })

  // A process that dies AFTER it was ready — Vite crashing on an HMR socket
  // reset, the user killing it from a terminal — used to stay `'ready'` in
  // this registry for good: the live-origin proxy kept forwarding to a port
  // nobody listened on, the board's frames sat on an error document, and
  // `GET status` could not tell anyone. `'failed'` is the honest phase, and
  // the next `ensureEntry` clears a failed entry and respawns.
  void entry.proc.exited.then((code) => {
    if (servers.get(appRoot) !== entry || entry.phase !== 'ready') return
    entry.phase = 'failed'
    entry.error = `Dev server ("${entry.packageManager} run ${entry.devScript}") exited with code ${code} after it was ready.`
    entry.log += `\n[studio] ${entry.error}\n`
    deleteDevServerRecord(appRoot)
  })
}

/**
 * `dir` is the ORIGINAL project directory — the one `ensureDevServer`/
 * `startDevServer` received, BEFORE `resolveAppRoot(dir)` narrows it to a
 * possibly-nested app root. `registeredMcpServerProjectKey` must be computed
 * from `dir`, not `appRoot`: it is the SAME key `server/liveOrigin.ts` uses
 * for the `/p/<projectKey>` URL segment, keyed off the project directory
 * itself. Deriving it from a monorepo's narrowed `apps/web/` app root instead
 * would silently compute a different, wrong key for exactly the one case
 * (a nested app root) this distinction exists to handle.
 *
 * Also injects `STUDIO_PROJECT_KEY_ENV`/`STUDIO_PARENT_ORIGINS_ENV`
 * (`@core/studio-runtime`) — the two env vars `virtual:studio-runtime`
 * (`vitePlugin.ts`'s `runtimeConfigPlugin`) reads at `load()` time to build
 * `STUDIO_RUNTIME_CONFIG`, which `main.jsx` gates
 * `createStudioRuntimeBridge(...)` on. `projectKey` reuses the SAME
 * `registeredMcpServerProjectKey(dir)` call this function already makes for
 * `STUDIO_LIVE_BASE_PATH_ENV`, so the two can never disagree. The parent
 * origins are `readServerConfig(process.env).liveFrameAncestors` — the SAME
 * list `liveOriginSecurityHeaders` puts in `frame-ancestors`, so the set of
 * documents allowed to frame a live frame and the set it will talk to are
 * one list, and a local install with no `PUBLIC_ORIGIN` gets its own admin
 * and dev origins in both. (It used to be `PUBLIC_ORIGIN` alone: unset
 * locally, so the bridge never booted and the CSP blocked the frame — the
 * two failed together, and Live had never worked on a local install.)
 */
function spawnEntry(appRoot: string, dir: string, overrides: DevServerOverrides): { ok: true; entry: DevServerEntry } | { ok: false; error: string } {
  // The gate that keeps a Tier-2-by-default board from running an arbitrary
  // repository's `dev`/`start` script the moment it opens: Studio only ever
  // runs `vite`, because `vite` is the only thing it can frame (`sec-20`;
  // the rule and its reasons live in `liveCapability.ts`).
  if (!resolveLiveCapability(dir).capable) {
    return { ok: false, error: `Live needs Vite: this project's dev/start script is not a vite invocation, so Studio does not run it (${appRoot}).` }
  }
  const devScript = resolveDevScript(appRoot)
  if (!devScript) {
    return { ok: false, error: `No "dev" or "start" script found in package.json at ${appRoot}.` }
  }

  const packageManager = detectPackageManager(appRoot)
  const projectKey = registeredMcpServerProjectKey(dir)
  const extraEnv: Record<string, string> = {
    [STUDIO_LIVE_BASE_PATH_ENV]: `/p/${projectKey}/`,
    [STUDIO_PROJECT_KEY_ENV]: projectKey,
    [STUDIO_PARENT_ORIGINS_ENV]: readServerConfig(process.env).liveFrameAncestors.join(','),
  }
  const spawn = overrides.spawn ?? defaultSpawn
  const proc = spawn([packageManager, 'run', devScript.name], {
    cwd: appRoot,
    env: minimalSubprocessEnv(DEV_SERVER_ENV_EXTRA_KEYS, extraEnv),
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
    projectKey,
    devScript: devScript.name,
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

/**
 * A dev server a PREVIOUS run of this process left ready (`live-11`), re-entered
 * into the registry without spawning anything — or `null` when there is no
 * record, the record is for a different base path, or its pid is gone. A
 * record whose pid is alive but whose origin no longer answers is judged by
 * the same `raceBoot` a fresh spawn goes through: the probe stands in for the
 * "Local URL" line, and a failed probe is a failed boot.
 *
 * The adopted process is never signalled unless the probe PROVED it is the
 * dev server the record describes — a pid can be reused by an unrelated
 * process between two runs, and killing that would be worse than an orphan.
 */
function adoptEntry(
  appRoot: string,
  dir: string,
  overrides: DevServerOverrides,
  /** Whether a stale record may be replaced by a fresh spawn — true for a START, never for a status poll or a proxied request, which must not start processes. */
  respawnIfStale: boolean,
): DevServerEntry | null {
  const record = readDevServerRecord(appRoot)
  if (!record) return null
  const projectKey = registeredMcpServerProjectKey(dir)
  const isAlive = overrides.isProcessAlive ?? isProcessAlive
  if (record.projectKey !== projectKey || !isAlive(record.pid)) {
    deleteDevServerRecord(appRoot)
    return null
  }

  let verified = false
  let exitPoll: ReturnType<typeof setInterval> | null = null
  const exited = new Promise<number>((resolveExited) => {
    // Deliberately NOT `.unref()`'d — see `scheduleTeardownInternal`'s comment.
    exitPoll = setInterval(() => {
      if (isAlive(record.pid)) return
      if (exitPoll) clearInterval(exitPoll)
      exitPoll = null
      resolveExited(0)
    }, ADOPTED_EXIT_POLL_MS)
  })
  const proc: SpawnedProcessLike = {
    stdout: null,
    stderr: null,
    exited,
    pid: record.pid,
    kill: () => {
      if (exitPoll) clearInterval(exitPoll)
      exitPoll = null
      if (!verified) return
      try {
        process.kill(record.pid)
      } catch {
        // already gone
      }
    },
  }

  const probe = overrides.probe ?? probeDevServerOrigin
  const entry: DevServerEntry = {
    appRoot,
    proc,
    packageManager: record.packageManager as PackageManager,
    projectKey,
    devScript: record.devScript,
    phase: 'booting',
    baseUrl: null,
    urlPromise: Promise.resolve(null),
    // No URL in this line, deliberately: `pumpAndWatch` falls back to scanning
    // the whole log for the "Local:" URL, and a respawn after a stale record
    // prefixes this log onto the fresh entry's — the fresh server's URL was
    // being read off THIS line (old port, trailing `).`) instead of its own
    // output (`live-14`).
    log: `[studio] adopted the dev server a previous run left ready (pid ${record.pid}, port ${new URL(record.baseUrl).port}).\n`,
    error: null,
    pid: record.pid,
    startedAt: record.startedAt,
    idleTimer: null,
    settled: Promise.resolve(),
  }
  entry.urlPromise = probe(record.baseUrl, `/p/${projectKey}/`).then((ok) => {
    if (!ok) return null
    verified = true
    entry.baseUrl = record.baseUrl
    return record.baseUrl
  })
  servers.set(appRoot, entry)
  void exited.then(() => {
    // Mirrors `pumpAndWatch`: a process that dies mid-probe settles the boot as failed.
    if (!entry.baseUrl) entry.urlPromise = Promise.resolve(null)
  })
  // A record that turns out stale — the origin gone, the pid dead mid-probe —
  // is not a failed BOOT, it is a missing server, and the caller asked for
  // one. Fall straight through to the spawn `ensureEntry` would have done
  // had there been no record, instead of parking the project on `'failed'`
  // until somebody presses start again.
  entry.settled = raceBoot(entry, appRoot, overrides.bootTimeoutMs ?? BOOT_TIMEOUT_MS).then(() => {
    if (!respawnIfStale || servers.get(appRoot) !== entry || entry.phase !== 'failed') return
    servers.delete(appRoot)
    const fresh = spawnEntry(appRoot, dir, overrides)
    if (!fresh.ok) {
      entry.error = fresh.error
      servers.set(appRoot, entry)
      return
    }
    fresh.entry.log = `${entry.log}[studio] the recorded server no longer answered; started a new one.\n${fresh.entry.log}`
    return fresh.entry.settled
  })
  return entry
}

/** Reuses a live (`'booting'`/`'ready'`) entry; clears and respawns a `'failed'` one; adopts a recorded survivor or spawns fresh otherwise. */
function ensureEntry(appRoot: string, dir: string, overrides: DevServerOverrides): { ok: true; entry: DevServerEntry } | { ok: false; error: string } {
  const existing = servers.get(appRoot)
  if (existing && existing.phase !== 'failed') return { ok: true, entry: existing }
  if (existing) servers.delete(appRoot)
  const adopted = adoptEntry(appRoot, dir, overrides, true)
  if (adopted) return { ok: true, entry: adopted }
  return spawnEntry(appRoot, dir, overrides)
}

/** Empties the registry WITHOUT killing anything — a test's stand-in for this process restarting. */
export function forgetDevServersForTest(): void {
  servers.clear()
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
  const created = ensureEntry(appRoot, dir, overrides)
  if (!created.ok) return { ok: false, error: created.error, log: '' }

  await created.entry.settled
  // An adopted entry whose record was stale has been REPLACED by a fresh
  // spawn while we waited (`adoptEntry`) — read the registry, not the handle.
  const entry = servers.get(appRoot) ?? created.entry
  if (entry.phase === 'ready' && entry.baseUrl) {
    return { ok: true, baseUrl: entry.baseUrl }
  }
  return { ok: false, error: entry.error ?? 'Dev server failed to boot.', log: entry.log }
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
  return statusOf(lookupEntry(dir))
}

/**
 * The registry entry for `dir` — adopting a recorded survivor on a miss, so a
 * status poll or a proxied frame request right after this process restarted
 * finds the dev server that is still running instead of `'stopped'`. Nothing
 * here spawns: adoption only re-enters a process a previous run started.
 */
function lookupEntry(dir: string): DevServerEntry | undefined {
  const appRoot = resolveAppRoot(dir)
  return servers.get(appRoot) ?? adoptEntry(appRoot, dir, {}, false) ?? undefined
}

/**
 * `dir`'s dev server's own origin (e.g. `http://127.0.0.1:5173`), or `null`
 * if it is not currently `'ready'`.
 *
 * **Server-internal only — never send this over HTTP to a browser.** This
 * is the one caller that legitimately needs the address: `server/liveOrigin.ts`
 * (L2) is the SAME server PROCESS proxying a request in-process, not a
 * browser round-trip, so handing it the raw origin here does not violate
 * `DevServerStatus`'s own wire contract (`phase`/`pid`/`startedAt`/`log`
 * only) — that contract is about what `tryServeStudioDevServer`'s HTTP
 * routes put in a JSON response body, which this function never touches.
 */
export function getDevServerUpstreamUrl(dir: string): string | null {
  const entry = lookupEntry(dir)
  return entry && entry.phase === 'ready' ? entry.baseUrl : null
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
  const created = ensureEntry(appRoot, dir, overrides)
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
  deleteDevServerRecord(appRoot)
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
