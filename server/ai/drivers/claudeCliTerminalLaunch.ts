/**
 * Claude CLI "click to authorize" terminal launcher — follow-up to WS-11
 * step 2's L1 login path.
 *
 * `claude auth login`/`claude setup-token` are Ink TUIs that die immediately
 * on piped or `/dev/null` stdin — `claudeCliEnv.ts`'s own doc comment records
 * that finding, and it's why this repo has no PTY dependency
 * (`node-pty`) and never will just to work around it. What Studio CAN do,
 * when the HTTP request originates from the same machine the server is
 * running on, is open a REAL, separate, visible terminal window running the
 * login command with `CLAUDE_CONFIG_DIR` already pointed at the caller's own
 * per-user config directory. The CLI then opens the user's browser itself
 * and the user authorizes there — a genuine click-to-authorize flow. Studio
 * never sees a token: `claudeCliStatus.ts`'s existing `claude auth status
 * --json` poll (`claudeCliProbe.ts`) is the only thing that ever reads the
 * outcome, and it reports only `{ loggedIn: boolean }`.
 *
 * `resolveTerminalLaunchSupport` is the availability check (surfaced via
 * `GET .../claude-cli/status`'s `terminalLogin` field, so the dialog can
 * decide whether to offer the button at all); `launchClaudeCliLoginTerminal`
 * is the actual spawn, called from `POST .../claude-cli/login-terminal`.
 *
 * ── What was actually verified, not assumed (Windows is the dev platform) ──
 *
 * Spawning `cmd /c start "Title" cmd /k "…"` directly could not be visually
 * confirmed inside this task's sandboxed shell (a Job Object/window-station
 * artifact of that harness, not of Windows itself — `[Environment]::
 * UserInteractive` and the session id both read as a normal interactive
 * session). What DID verify cleanly, end to end, via `Get-Process` picking up
 * a real windowed host process with the exact requested title: PowerShell's
 * `Start-Process -FilePath <path-to-a-.bat-file> -WindowStyle Normal`, run
 * from an OUTER `powershell.exe -WindowStyle Hidden` so only the target
 * window (not a second PowerShell console) is visible. On this Windows 11
 * box the window that opens is hosted by `WindowsTerminal.exe` (the OS
 * default terminal app's association for `.bat`/console-subsystem exes) —
 * Windows 10 or a machine with a different default terminal would host it in
 * `conhost.exe` instead, which is transparent to this code either way; only
 * `Start-Process` is depended on, not which console host answers for it.
 *
 * The Linux path (best-effort chain over common terminal emulators) is
 * UNVERIFIED — no Linux host was available to test against — and is written
 * defensively: any binary that isn't on `PATH` is skipped (ENOENT, the same
 * synchronous-throw contract `claudeCliProbe.ts` already relies on), and
 * exhausting the list degrades to the manual/paste-a-token path with a
 * stated reason rather than silently doing nothing.
 *
 * macOS never reaches this module in practice — `claudeCliPlatformSupport()`
 * already disables the whole `claudeCli` provider there (the Keychain can't
 * be relocated by `CLAUDE_CONFIG_DIR`), so the "Log in with Claude" button
 * never renders. `resolveTerminalLaunchSupport` still answers `darwin`
 * defensively (unavailable, with a reason) rather than silently guessing.
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync } from 'node:fs'
import {
  minimalSubprocessEnv,
  runCappedSubprocess,
  type SubprocessSpawnFn,
} from '../../handlers/studio/subprocessRunner'

const LAUNCH_TIMEOUT_MS = 10_000
const LAUNCH_MAX_BYTES = 4 * 1024

export interface TerminalLaunchSupport {
  readonly available: boolean
  /** Present only when `available` is false — shown in the dialog. */
  readonly reason?: string
}

/**
 * Whether Studio can even attempt to open a terminal for this request.
 * Two independent gates:
 *
 *   1. The request must be loopback (see `security.ts`'s `isLoopbackRequest`
 *      doc comment for why `X-Forwarded-For` is never trusted for this) —
 *      opening a terminal on the server is meaningless, and would silently
 *      do nothing useful, for a caller on a different machine.
 *   2. The host platform must have a known, reliable way to open one.
 */
export function resolveTerminalLaunchSupport(
  platform: NodeJS.Platform,
  isLoopback: boolean,
): TerminalLaunchSupport {
  if (!isLoopback) {
    return {
      available: false,
      reason: 'Studio is running on a remote host — a terminal opened here would open on the server, not on your machine. Paste a setup-token instead.',
    }
  }
  if (platform === 'win32' || platform === 'linux') {
    return { available: true }
  }
  if (platform === 'darwin') {
    return {
      available: false,
      reason: 'The Claude CLI provider is unavailable on macOS (see the provider note above) — there is no terminal to open.',
    }
  }
  return {
    available: false,
    reason: `Opening a terminal automatically isn't supported on "${platform}" yet — paste a setup-token instead.`,
  }
}

export interface LaunchClaudeCliLoginTerminalOptions {
  readonly configDir: string
  readonly platform?: NodeJS.Platform
  /** Test seam — forwarded to the underlying capped subprocess runner. */
  readonly spawn?: SubprocessSpawnFn
  /**
   * Test seam — resolves a binary's absolute path on `PATH`. Defaults to
   * `Bun.which`. Exists so tests can deterministically exercise both "claude
   * is on PATH" and "claude is missing" without depending on whatever
   * happens to be installed on the machine running the suite.
   */
  readonly which?: (bin: string) => string | null
}

export interface LaunchClaudeCliLoginTerminalResult {
  readonly ok: boolean
  /** Present only when `ok` is false — safe to show the caller (never a raw path, stderr, or secret). */
  readonly reason?: string
}

/**
 * Open a detached, visible terminal window running `claude auth login` with
 * `CLAUDE_CONFIG_DIR` set to `configDir`. Never throws — every failure mode
 * resolves to `{ ok: false, reason }` with a caller-safe reason (raw spawn
 * errors and paths are logged server-side only, never returned).
 */
export async function launchClaudeCliLoginTerminal(
  options: LaunchClaudeCliLoginTerminalOptions,
): Promise<LaunchClaudeCliLoginTerminalResult> {
  const platform = options.platform ?? process.platform
  const which = options.which ?? ((bin: string) => Bun.which(bin))
  if (platform === 'win32') return launchWindowsTerminal(options.configDir, options.spawn, which)
  if (platform === 'linux') return launchLinuxTerminal(options.configDir, options.spawn)
  return {
    ok: false,
    reason: `Opening a terminal automatically isn't supported on "${platform}" — paste a setup-token instead.`,
  }
}

// ---------------------------------------------------------------------------
// Windows — verified (see module doc comment)
// ---------------------------------------------------------------------------

async function launchWindowsTerminal(
  configDir: string,
  spawn: SubprocessSpawnFn | undefined,
  which: (bin: string) => string | null,
): Promise<LaunchClaudeCliLoginTerminalResult> {
  // `configDir` is server-derived (`resolveClaudeCliConfigDir`'s own
  // containment + safe-userId checks — never client-supplied), but the
  // script below embeds it into a batch `set` assignment. Refuse rather than
  // risk breaking out of the quoted value on the extremely unlikely chance
  // it ever contains one.
  if (configDir.includes('"')) {
    console.error('[claudeCliTerminalLaunch] refusing to embed a config dir containing a quote')
    return { ok: false, reason: 'Could not prepare a login script for this account.' }
  }

  // The batch cannot rely on ANY inherited environment. PowerShell's
  // `Start-Process` uses ShellExecute, and the process it creates does not
  // receive this server's environment — verified by running a batch through
  // that exact chain and finding even `where` (System32) unresolvable, i.e.
  // PATH is effectively empty in there. So `claude` was never going to be
  // found, which is precisely the "'claude' is not recognized" the login
  // window reported. Both the binary and PATH are therefore written INTO the
  // script, the same way CLAUDE_CONFIG_DIR already was.
  //
  // PATH matters as much as the binary: on Windows `claude` is `claude.cmd`,
  // an npm shim that invokes `node`, so an absolute path to the shim with no
  // PATH would fail one step later looking for its own interpreter.
  const claudeBin = which('claude')
  if (!claudeBin) {
    console.error('[claudeCliTerminalLaunch] could not resolve the claude binary on this host')
    return {
      ok: false,
      reason: 'Could not find the `claude` CLI on this machine. Install it, then try again.',
    }
  }
  if (claudeBin.includes('"')) {
    console.error('[claudeCliTerminalLaunch] refusing to embed a claude path containing a quote')
    return { ok: false, reason: 'Could not prepare a login script on this host.' }
  }
  // `%` is the batch variable sigil; double it so a literal `%` in either
  // value cannot expand into something else when the script runs.
  const batchLiteral = (value: string): string => value.replaceAll('%', '%%')

  const scriptPath = join(tmpdir(), `studio-claude-login-${randomUUID()}.bat`)
  const script = [
    '@echo off',
    'title Claude Code login',
    `set "PATH=${batchLiteral(process.env.PATH ?? '')}"`,
    `set "CLAUDE_CONFIG_DIR=${batchLiteral(configDir)}"`,
    `call "${claudeBin}" auth login`,
    'echo.',
    'echo Login finished. You can close this window.',
    'pause >nul',
    // Self-delete, LAST and via `(goto)`. cmd.exe does NOT read a running
    // batch file into memory — it keeps a file handle and seeks line by line,
    // so deleting the file mid-script makes the very next line unreadable:
    // cmd prints "The batch file cannot be found." and exits immediately.
    // A plain `del "%~f0"` placed before `pause` therefore killed the window
    // the instant login was attempted, which looked exactly like the login
    // failing. `(goto) 2>nul` forces cmd out of the batch context first,
    // releasing the handle, and the `&` command still runs. Verified: with a
    // plain del, the following line never executes; with this, it does.
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n')

  try {
    await Bun.write(scriptPath, script)
  } catch (err) {
    console.error('[claudeCliTerminalLaunch] failed to write the Windows login script:', err)
    return { ok: false, reason: 'Could not prepare a login script on this host.' }
  }

  // Outer `powershell.exe -WindowStyle Hidden` stays invisible; it only asks
  // the OS to open a SEPARATE window for the `.bat` file (`-WindowStyle
  // Normal`) and exits — the login window itself is fully independent
  // afterward, so it survives this outer process's own capped timeout.
  const escapedScriptPath = scriptPath.replace(/'/g, "''")
  const psCommand = `Start-Process -FilePath '${escapedScriptPath}' -WindowStyle Normal`

  try {
    const result = await runCappedSubprocess(
      ['powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCommand],
      {
        cwd: tmpdir(),
        env: minimalSubprocessEnv(),
        timeoutMs: LAUNCH_TIMEOUT_MS,
        maxStdoutBytes: LAUNCH_MAX_BYTES,
        maxStderrBytes: LAUNCH_MAX_BYTES,
        spawn,
      },
    )
    if (result.exitCode !== 0) {
      console.error('[claudeCliTerminalLaunch] powershell exited', result.exitCode, result.stderr)
      return { ok: false, reason: 'Could not open a terminal window on this host.' }
    }
    return { ok: true }
  } catch (err) {
    console.error('[claudeCliTerminalLaunch] spawn failed:', err)
    return { ok: false, reason: 'Could not open a terminal window on this host.' }
  }
}

// ---------------------------------------------------------------------------
// Linux — best-effort, UNVERIFIED (see module doc comment)
// ---------------------------------------------------------------------------

/** Tried in order; the first one present on `PATH` wins. */
const LINUX_TERMINAL_CANDIDATES: readonly string[] = [
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'xterm',
]

async function launchLinuxTerminal(
  configDir: string,
  spawn: SubprocessSpawnFn | undefined,
): Promise<LaunchClaudeCliLoginTerminalResult> {
  const scriptPath = join(tmpdir(), `studio-claude-login-${randomUUID()}.sh`)
  const script = [
    '#!/bin/sh',
    `export CLAUDE_CONFIG_DIR=${shQuote(configDir)}`,
    'claude auth login',
    'echo',
    'echo "Login finished. You can close this window."',
    'rm -f -- "$0"',
    'read -r _dummy 2>/dev/null || true',
    '',
  ].join('\n')

  try {
    await Bun.write(scriptPath, script)
    chmodSync(scriptPath, 0o700)
  } catch (err) {
    console.error('[claudeCliTerminalLaunch] failed to write the Linux login script:', err)
    return { ok: false, reason: 'Could not prepare a login script on this host.' }
  }

  for (const bin of LINUX_TERMINAL_CANDIDATES) {
    try {
      const result = await runCappedSubprocess([bin, '-e', scriptPath], {
        cwd: tmpdir(),
        env: minimalSubprocessEnv(['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']),
        timeoutMs: LAUNCH_TIMEOUT_MS,
        maxStdoutBytes: LAUNCH_MAX_BYTES,
        maxStderrBytes: LAUNCH_MAX_BYTES,
        spawn,
      })
      if (result.exitCode === 0) return { ok: true }
      // A terminal that starts detached and immediately hands back control
      // (the common case) exits 0 before the login flow even begins; a
      // nonzero exit here means THIS specific binary failed to launch at
      // all — try the next candidate rather than giving up outright.
      console.error('[claudeCliTerminalLaunch]', bin, 'exited', result.exitCode, result.stderr)
    } catch {
      // ENOENT (binary not on PATH) — same synchronous-throw contract
      // `claudeCliProbe.ts` documents for a direct, shell-less spawn. Try
      // the next candidate.
      continue
    }
  }
  return {
    ok: false,
    reason: 'No terminal emulator was found on this host — paste a setup-token instead.',
  }
}

/** POSIX shell single-quoting: end quote, escape the embedded quote, reopen. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
