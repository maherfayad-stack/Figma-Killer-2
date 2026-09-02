/**
 * "Is the Claude CLI signed in to this MCP server?" — the question Studio's
 * own token store structurally cannot answer.
 *
 * ## Why this exists
 *
 * `mcpOAuthStore.ts` records sessions Studio's OWN browser OAuth flow
 * completed. For a server whose provider runs a closed client allow-list —
 * Figma, which is the one Studio ships — that flow can never succeed, so the
 * sign-in happens through the Claude CLI instead (see `mcpOAuth.ts`'s
 * `closedRegistrationMessage`). The CLI keeps that credential in the macOS
 * Keychain, not in Studio's store and not in any file under
 * `CLAUDE_CONFIG_DIR`.
 *
 * The result was a badge that could never flip: the panel reported "Not
 * signed in" and offered a Sign in button that cannot work, while the agent's
 * Figma tools were live in every chat turn. Studio was reading the one place
 * the sign-in never lands. `claude mcp list` reads the place it does.
 *
 * Reading the right place is only half of it. The CLI keeps its OWN cache of
 * "this server needs authentication" in the config dir, a headless turn trusts
 * that cache over the server itself, and nothing invalidates it when the
 * sign-in finally happens — so a green badge and a turn with zero Figma tools
 * are the SAME state. {@link clearCliNeedsAuthCache} is the other half; its
 * doc comment carries the measurement.
 *
 * ## Why the cwd is a fresh empty directory, and this matters twice
 *
 * `claude mcp list` resolves servers relative to its working directory and
 * health-checks what it finds, so the answer genuinely differs per directory.
 * Measured against one config dir, one endpoint, back to back:
 *
 *     empty tmp dir                  ✔ Connected
 *     studio-workspace/<project>     ✔ Connected      <- what a turn sees
 *     the Studio repo root           ! Needs authentication
 *
 * An empty directory therefore gives the same answer as the project directory
 * Studio actually spawns turns in, which is the answer the badge must report.
 *
 * It is also the SAFE choice, which is the more important half. `claude mcp
 * list`'s own help warns it spawns approved `.mcp.json` stdio servers for
 * health checks, and Studio's entire outbound-MCP posture
 * (`projectMcpServers.ts`) is that a project-declared command is arbitrary
 * code that runs only after a human approves it IN STUDIO. Probing inside a
 * user's project would execute commands from their repo to render a badge,
 * on a consent record Studio does not own. A directory with no `.mcp.json`
 * cannot do that.
 *
 * ## Why it is cached, and never on the turn path
 *
 * The call is a live health check against every configured server: **~10
 * seconds** measured, dominated by network round trips Studio does not
 * control. That is fine for a Settings panel that shows a checking state and
 * unacceptable anywhere near a chat turn. So:
 *
 *   - results are cached per config dir for {@link CACHE_TTL_MS};
 *   - the live probe is only ever reached from an explicit HTTP request;
 *   - the per-turn digest uses {@link readCachedCliMcpConnections}, which
 *     NEVER spawns anything — a cold cache degrades to "unknown", exactly the
 *     "don't buy a guess with latency" rule `liveDigest.ts` already states.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  minimalSubprocessEnv,
  runCappedSubprocess,
  type SubprocessSpawnFn,
} from '../../handlers/studio/subprocessRunner'

/** Generous: the measured call is ~10s and every second of it is a network health check against someone else's server. */
const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_BYTES = 64 * 1024

/** Long enough that opening Settings twice, or a burst of turns, costs one probe; short enough that signing in is reflected without restarting Studio. */
const CACHE_TTL_MS = 60_000

/** Registration writes one config entry and returns immediately — nothing like the health check's network cost. */
const REGISTER_TIMEOUT_MS = 15_000

export type CliMcpConnectionState = 'connected' | 'needs-auth'

/** Server name → state, for every server `claude mcp list` reported. A name absent from the map was not listed at all. */
export type CliMcpConnections = ReadonlyMap<string, CliMcpConnectionState>

interface CacheEntry {
  readonly connections: CliMcpConnections
  readonly at: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Parse `claude mcp list`'s human output.
 *
 * There is no `--json` for this subcommand (checked against `--help`), so the
 * text is the contract. Lines look like:
 *
 *     figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected
 *     claude.ai Dovetail: https://dovetail.com/api/mcp - ! Needs authentication
 *
 * A server NAME may contain spaces and dots but never a newline, and the
 * status is matched on the marker glyph plus the word, so a future wording
 * tweak degrades to "not listed" rather than to a confident wrong answer.
 * Everything unrecognised — headers, the diagnostics block, blank lines — is
 * skipped.
 */
export function parseCliMcpList(stdout: string): CliMcpConnections {
  const connections = new Map<string, CliMcpConnectionState>()
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    const separator = line.indexOf(': ')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    if (!name) continue

    if (line.includes('✔ Connected')) connections.set(name, 'connected')
    else if (line.includes('Needs authentication')) connections.set(name, 'needs-auth')
  }
  return connections
}

export interface ProbeCliMcpOptions {
  readonly configDir: string
  /** Test seam — forwarded to `runCappedSubprocess`. */
  readonly spawn?: SubprocessSpawnFn
  /** Test seam. */
  readonly now?: number
}

/** The cached answer for this config dir, or `null` when there is none or it has expired. Never spawns — safe to call from the per-turn prompt path. */
export function readCachedCliMcpConnections(
  configDir: string,
  now: number = Date.now(),
): CliMcpConnections | null {
  const entry = cache.get(configDir)
  if (!entry) return null
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(configDir)
    return null
  }
  return entry.connections
}

/**
 * Run `claude mcp list` against `configDir` and report what it connected to.
 * Returns the cached answer when one is fresh. Never throws: a missing
 * binary, a timeout, or unparseable output all resolve to an EMPTY map, which
 * callers read as "nothing known", never as "nothing connected".
 */
export async function probeCliMcpConnections(options: ProbeCliMcpOptions): Promise<CliMcpConnections> {
  const now = options.now ?? Date.now()
  const cached = readCachedCliMcpConnections(options.configDir, now)
  if (cached) return cached

  let cwd: string | null = null
  try {
    cwd = mkdtempSync(join(tmpdir(), 'studio-mcp-probe-'))
    const result = await runCappedSubprocess(['claude', 'mcp', 'list'], {
      cwd,
      env: minimalSubprocessEnv(['HOME', 'PATH'], { CLAUDE_CONFIG_DIR: options.configDir }),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdoutBytes: PROBE_MAX_BYTES,
      maxStderrBytes: PROBE_MAX_BYTES,
      spawn: options.spawn,
    })
    // A non-zero exit still prints the server list in practice, and the
    // diagnostics block it appends is skipped by the parser — so parse
    // whatever arrived rather than discarding a usable answer over an exit
    // code. A timeout, by contrast, means the output is a fragment: an
    // unlisted server would read as "not connected", which is exactly the
    // confident wrong answer this module exists to stop making.
    if (result.timedOut) return new Map()
    const connections = parseCliMcpList(result.stdout)
    cache.set(options.configDir, { connections, at: now })
    return connections
  } catch (err) {
    console.error('[ai/cliMcpConnectionProbe] could not ask the Claude CLI what it is signed in to:', err)
    return new Map()
  } finally {
    if (cwd) {
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        // Best-effort; an empty directory in os.tmpdir() is harmless.
      }
    }
  }
}

/**
 * Make sure the CLI has this server registered at USER scope, so a sign-in
 * performed once is visible from every working directory — including the
 * neutral one {@link probeCliMcpConnections} probes from and the project
 * directories turns actually run in.
 *
 * Studio runs this itself rather than printing it, because it is the half of
 * the setup that needs no human: `claude mcp add` is non-interactive,
 * idempotent (an existing entry answers "already exists" and exits 0), and
 * writes a server DEFINITION — a name and a URL Studio already ships — never a
 * credential. What is left for the user is the one step that genuinely cannot
 * be automated: the interactive `/mcp` authorization, which needs a TTY and a
 * browser consent screen.
 *
 * Scope matters and is not cosmetic: without `-s user` the CLI writes a
 * LOCAL-scope entry keyed to the working directory, which is invisible
 * everywhere else. Measured: a local-scope registration reported `! Needs
 * authentication` in the directory that owned it while user scope reported
 * `✔ Connected` from everywhere.
 *
 * Never throws, and never reports failure — a missing binary or an
 * unwritable config is exactly the situation where the printed fallback
 * instructions are the answer, and this is best-effort on the way there.
 */
export async function ensureCliMcpServerRegistered(options: {
  readonly configDir: string
  readonly name: string
  readonly url: string
  readonly spawn?: SubprocessSpawnFn
}): Promise<void> {
  let cwd: string | null = null
  try {
    cwd = mkdtempSync(join(tmpdir(), 'studio-mcp-register-'))
    await runCappedSubprocess(
      ['claude', 'mcp', 'add', '-s', 'user', '--transport', 'http', options.name, options.url],
      {
        cwd,
        env: minimalSubprocessEnv(['HOME', 'PATH'], { CLAUDE_CONFIG_DIR: options.configDir }),
        timeoutMs: REGISTER_TIMEOUT_MS,
        maxStdoutBytes: PROBE_MAX_BYTES,
        maxStderrBytes: PROBE_MAX_BYTES,
        spawn: options.spawn,
      },
    )
  } catch (err) {
    console.error('[ai/cliMcpConnectionProbe] could not register the server with the Claude CLI:', err)
  } finally {
    if (cwd) {
      try {
        rmSync(cwd, { recursive: true, force: true })
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * A REMEMBERED sign-in — the in-memory cache's durable counterpart.
 *
 * The 60-second cache exists to keep a ~10 second health check off repeated
 * requests. It cannot answer the question a fresh project asks on its very
 * first turn: "has this user signed in to Figma?" — a question whose answer
 * changes about once ever, and which decides whether the connector works at
 * all (`recordBuiltInSignIn`). Recomputing it would mean either a 10 second
 * stall on the turn path or a connector that works only when a cache happens
 * to be warm; both are worse than a note on disk.
 *
 * So an observed `connected` is written once, into Studio's own per-user CLI
 * data directory — the same 0700 tree `claudeCliEnv.ts` already owns, removed
 * wholesale by `deleteClaudeCliConfigDir`, so forgetting the CLI login also
 * forgets this. It records only server NAMES; there is no credential here and
 * never can be, because Studio does not hold one.
 *
 * It is deliberately one-way: nothing here erases a name. A probe that fails,
 * times out, or runs while the network is down must not read as "signed out"
 * and quietly revoke a working connector — and a real sign-out is expressed
 * by revoking the approval in Settings, which is a human action with a human's
 * intent behind it.
 */
const REMEMBERED_FILE = 'studio-mcp-signin.json'

function rememberedPath(configDir: string): string {
  return join(configDir, REMEMBERED_FILE)
}

export function rememberCliSignIn(configDir: string, name: string): void {
  try {
    const current = recallCliSignIns(configDir)
    if (current.includes(name)) return
    writeFileSync(rememberedPath(configDir), JSON.stringify([...current, name]), { mode: 0o600 })
  } catch (err) {
    console.error('[ai/cliMcpConnectionProbe] could not remember the CLI sign-in:', err)
  }
}

/** Server names previously observed as signed in. Free to call — one small file read — and safe on the per-turn path. Never throws. */
export function recallCliSignIns(configDir: string): readonly string[] {
  try {
    const path = rememberedPath(configDir)
    if (!existsSync(path)) return []
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * The CLI's OWN cache of "this server told me it needs authentication", which
 * outlives the sign-in that fixes it.
 *
 * ## The failure this closes, measured
 *
 * The CLI writes `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json` when a server
 * answers a turn unauthenticated, and a headless (`-p`) turn then trusts that
 * file INSTEAD of trying the server again. `claude mcp list` does not — it
 * health-checks live. So the two disagree, permanently, in the one direction
 * that matters. Captured against one config dir, one endpoint, minutes apart,
 * after a completed `/mcp` sign-in:
 *
 *     claude mcp list                     figma: ✔ Connected
 *     headless turn (system/init)         {"name":"figma","status":"needs-auth"}, zero figma tools
 *
 * Deleting the `figma` key from that file — changing nothing else, no
 * re-authentication — flipped the same headless turn to
 * `{"name":"figma","status":"connected"}` with the full `mcp__figma__*` tool
 * surface registered.
 *
 * That is exactly the symptom this whole module was built to explain: Settings
 * reports "Signed in via the Claude CLI" (it asks `claude mcp list`, which is
 * right) while every actual turn reports `No such tool available:
 * mcp__figma__…` (it reads the stale cache). The user did the one manual step
 * Studio asked of them, and it silently bought them nothing.
 *
 * It is also self-perpetuating rather than transient: one turn taken before
 * the sign-in — or during a network blip — poisons the file, and nothing in a
 * later turn ever re-checks. Waiting it out is not a strategy; the entry has
 * no TTL Studio can rely on.
 *
 * ## Why Studio may prune it
 *
 * This is a CACHE of a verdict, not a credential and not user intent, in a
 * directory Studio creates, owns, and deletes wholesale
 * (`claudeCliEnv.ts`'s `deleteClaudeCliConfigDir`) — the same directory Studio
 * already writes a server DEFINITION into via `ensureCliMcpServerRegistered`.
 * Removing one key is strictly narrower than what the CLI does to the file
 * itself, and the worst case is one extra live connection attempt.
 *
 * Deliberately name-scoped: only servers the caller has POSITIVE evidence for
 * — a live `connected` from the probe, or a remembered sign-in — are pruned.
 * Nothing here touches a server Studio has never seen work, so a genuinely
 * unauthenticated server keeps its cached verdict and its fast, honest
 * "needs-auth" answer.
 *
 * Never throws: a missing file, a corrupt one, or an unwritable directory all
 * mean "leave it alone", and this sits on the turn path.
 */
const NEEDS_AUTH_CACHE_FILE = 'mcp-needs-auth-cache.json'

export function clearCliNeedsAuthCache(configDir: string, names: readonly string[]): void {
  if (names.length === 0) return
  try {
    const path = join(configDir, NEEDS_AUTH_CACHE_FILE)
    if (!existsSync(path)) return
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const entries = parsed as Record<string, unknown>
    let changed = false
    for (const name of names) {
      if (Object.hasOwn(entries, name)) {
        delete entries[name]
        changed = true
      }
    }
    if (!changed) return
    writeFileSync(path, JSON.stringify(entries))
  } catch (err) {
    console.error('[ai/cliMcpConnectionProbe] could not prune the CLI needs-auth cache:', err)
  }
}

/** Drop every cached answer — called after a sign-out so the next read re-probes instead of serving a stale "connected". */
export function clearCliMcpConnectionCache(): void {
  cache.clear()
}
