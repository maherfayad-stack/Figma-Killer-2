/**
 * devServerOutput — where a spawned dev server's output goes and how the
 * manager reads it back (`live-16`). Split out of `devServer.ts` so the
 * registry/route module stays inside the 700-line budget; the survival
 * property (a FILE, never a pipe — see `spawnDevServerProcess`) lives here.
 */
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { readDevServerLogSince } from './devServerRecords'
import type { SpawnedProcessLike } from './subprocessRunner'

export const MAX_LOG_BYTES = 32_000

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

/** What a dev server is spawned with: where to run, what it sees, and the file its output goes to. */
export interface DevServerSpawnOptions {
  cwd: string
  env: Record<string, string>
  logPath: string
}

/**
 * The real spawn. stdout and stderr share ONE descriptor on `logPath`, opened
 * fresh (truncating a previous server's output) and closed again here as soon
 * as the child holds its own copy — the child then writes to a file the OS
 * keeps open for it, and nothing about this process's lifetime can turn that
 * write into an EPIPE. Exported for its own test: this is the one place the
 * survival property lives.
 */
export function spawnDevServerProcess(argv: string[], options: DevServerSpawnOptions): SpawnedProcessLike {
  mkdirSync(dirname(options.logPath), { recursive: true })
  const fd = openSync(options.logPath, 'w')
  try {
    return Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdout: fd, stderr: fd, stdin: 'ignore' }) as unknown as SpawnedProcessLike
  } finally {
    closeSync(fd)
  }
}

/** How often the log file is re-read. The child writes to a file, not to this process, so its output is polled rather than streamed. */
const LOG_TAIL_POLL_MS = 200

/** The slice of a registry entry the tail reads and writes. */
export interface TailedDevServerEntry {
  logPath: string
  log: string
  baseUrl: string | null
  proc: { exited: Promise<number> }
}

function capText(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length > MAX_LOG_BYTES ? combined.slice(combined.length - MAX_LOG_BYTES) : combined
}

/**
 * Follows `entry.logPath` while `isCurrent()` holds (the caller's registry still
 * points at this entry): appends new output to the
 * capped status log and, when `discoverUrl`, resolves `resolveUrl` the first
 * time a Local URL appears (ANSI-stripped, and re-scanned over the whole log
 * so a URL split across two reads is still found). Stops on its own once the
 * entry has left the registry or its process has exited — after one last
 * read, so an exit message is not lost. The timer is unref'd: the loop must
 * not keep a `bun test` worker alive after a test leaves a ready entry
 * behind, and while URL discovery matters `raceBoot`'s own ref'd boot timer
 * keeps the event loop running for it.
 */
export function tailAndWatch(entry: TailedDevServerEntry, isCurrent: () => boolean, discoverUrl: boolean, resolveUrl: (url: string | null) => void, startOffset = 0): void {
  let offset = startOffset
  let resolved = !discoverUrl
  let exited = false
  void entry.proc.exited.then(() => {
    exited = true
  })
  const settle = (url: string | null) => {
    if (resolved) return
    resolved = true
    resolveUrl(url)
  }
  const read = () => {
    const next = readDevServerLogSince(entry.logPath, offset)
    offset = next.offset
    if (!next.chunk) return
    entry.log = capText(entry.log, next.chunk)
    if (resolved || entry.baseUrl) return
    const match = URL_PATTERN.exec(stripAnsi(next.chunk)) ?? URL_PATTERN.exec(stripAnsi(entry.log))
    if (!match) return
    // `localhost` is pinned to IPv4 here for the same reason the generated
    // `vite.config.js` pins `server.host`: the name can resolve to ::1 for the
    // dev server and 127.0.0.1 for this proxy, and then the two are talking
    // about different sockets. A config the user edited may still print
    // `localhost`; the proxy must not guess which stack it bound.
    entry.baseUrl = match[0].replace(/\/$/, '').replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1')
    settle(entry.baseUrl)
  }
  const tick = () => {
    read()
    if (exited) {
      settle(null)
      return
    }
    if (!isCurrent()) return
    const timer = setTimeout(tick, LOG_TAIL_POLL_MS)
    // happy-dom's `setTimeout` (the test preload's) returns a number; Bun's returns a Timer.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  }
  tick()
}

