/**
 * Credential verification for the `claude` CLI driver — the "Test" action in
 * the Providers tab, plus the free save-time shape gate that runs before a
 * secret is ever stored.
 *
 * Split out of `claudeCli.ts` because it answers a different question than
 * that file does. `claudeCli.ts` streams a chat turn: long-lived, tool-using,
 * MCP-connected, session-resuming. Everything here is the opposite shape — a
 * single throwaway subprocess whose only output is pass or throw, with its own
 * argv, its own scratch config dir, and its own error vocabulary. They share
 * only `runCappedSubprocess` and the CLI's line schema.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { minimalSubprocessEnv, runCappedSubprocess, type SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { parseClaudeCliLine } from './claudeCliEvents'
import type { AiResolvedCredential } from './types'

export interface VerifyClaudeCliCredentialOptions {
  /** Test seam — forwarded to `runCappedSubprocess`. */
  readonly spawn?: SubprocessSpawnFn
}

/**
 * The prefix every `claude setup-token` value carries. The check exists
 * because the login flow shows the user TWO copyable strings and only one of
 * them works here: the browser's one-time authorization code (a
 * `<code>#<state>` pair, no prefix) is meant to be pasted back into the
 * waiting terminal, while the CLI's `setup-token` output (`sk-ant-oat…`) is
 * the long-lived credential this driver stores. Pasting the former is the
 * single most likely user error in this flow — it looks exactly like a token
 * and fails 6 layers later as a bare `401 Invalid bearer token` inside a chat
 * turn. Catching it on shape costs nothing and can say precisely what to do
 * instead.
 */
const SETUP_TOKEN_PREFIX = 'sk-ant-oat'

/**
 * Every OTHER Anthropic secret shares this prefix — `sk-ant-api…` console API
 * keys most of all. A user who lands on an API key here has not made a
 * mistake so much as picked the wrong row in the provider list: the key is
 * real and works, just under `anthropic`, which bills per token instead of
 * riding a Pro/Max subscription. Saying "that isn't a setup-token" to someone
 * holding a valid API key is technically true and useless — this prefix
 * exists so the message can name where the key DOES belong.
 */
const ANTHROPIC_SECRET_PREFIX = 'sk-ant-'

/** Shared by the save-time gate (`validateSecretShape`) and the paid verification below. */
export function assertLooksLikeSetupToken(secret: string): void {
  if (secret.startsWith(SETUP_TOKEN_PREFIX)) return
  if (secret.startsWith(ANTHROPIC_SECRET_PREFIX)) {
    throw new Error(
      'That looks like an Anthropic API key, not a Claude Code setup-token. An API key belongs '
      + 'under the "Anthropic" provider — add it there and it works immediately, billed per token. '
      + '"Claude Code (subscription)" is the different thing: it runs the local `claude` CLI on '
      + 'your Pro/Max plan, and its credential is the `sk-ant-oat…` value that `claude setup-token` '
      + 'prints in the terminal.',
    )
  }
  throw new Error(
    'That value is not a Claude setup-token. Run `claude setup-token` in a terminal and paste the '
    + '`sk-ant-oat…` value it prints — the code the browser shows during login is a one-time '
    + 'authorization code for the terminal that is waiting on it, and Anthropic rejects it here.',
  )
}

const VERIFY_TURN_TIMEOUT_MS = 60_000
const VERIFY_TURN_MAX_BYTES = 64 * 1024

/**
 * Prove a stored L2 setup-token actually authenticates, by running the
 * smallest possible REAL turn with it.
 *
 * ## Why this spawns a real turn instead of probing `auth status`
 *
 * `claude auth status --json` cannot answer this question — it reports
 * `{"loggedIn":true}` for a token that is pure invention, because it never
 * contacts Anthropic (see `claudeCliProbe.ts`'s "What this probe does NOT
 * prove"). A "Test" built on it passes every syntactically plausible string
 * and then leaves the user to discover the truth as a `401` in the middle of
 * a chat turn — which is exactly what shipped, and exactly what this replaces.
 * A check that cannot fail is worse than no check: it converts "unknown" into
 * a confident wrong answer.
 *
 * ## Why this one is cheap enough to run on a button press
 *
 * The turn is stripped to nothing: `--tools ""` drops every tool definition,
 * `--system-prompt` replaces the (large, cache-created) default, `haiku` +
 * `--effort low` keep generation minimal, and the `cwd` is a neutral temp dir
 * so no `CLAUDE.md` is discovered. Measured at **$0.001** per call (298 input
 * / ~160 output tokens), versus $0.0099 for the same turn with the defaults
 * left on. Not free, but a tenth of a cent for a truthful answer.
 *
 * ## Why a throwaway config dir
 *
 * A stored credential IS the token, so the question is whether THAT token
 * works — not whether this machine happens to hold a separate (L1) login.
 * Spawning against an empty scratch dir means only the token can produce a
 * pass, so a green result can never be borrowed from an unrelated host
 * session. Always cleaned up, success or failure.
 */
export async function verifyClaudeCliCredential(
  credentials: AiResolvedCredential,
  options: VerifyClaudeCliCredentialOptions = {},
): Promise<void> {
  const token = credentials.apiKey
  if (!token) {
    throw new Error('This credential has no setup-token stored to verify.')
  }
  assertLooksLikeSetupToken(token)

  const scratchConfigDir = mkdtempSync(join(tmpdir(), 'studio-claude-verify-'))
  let result: Awaited<ReturnType<typeof runCappedSubprocess>>
  try {
    result = await runCappedSubprocess(verificationTurnArgv(), {
      cwd: tmpdir(),
      env: minimalSubprocessEnv([], {
        CLAUDE_CONFIG_DIR: scratchConfigDir,
        CLAUDE_CODE_OAUTH_TOKEN: token,
      }),
      timeoutMs: VERIFY_TURN_TIMEOUT_MS,
      maxStdoutBytes: VERIFY_TURN_MAX_BYTES,
      maxStderrBytes: VERIFY_TURN_MAX_BYTES,
      spawn: options.spawn,
    })
  } catch (err) {
    // No shell sits between us and the binary, so a missing `claude` throws
    // from the spawn call itself rather than exiting with a message.
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      message.toLowerCase().includes('enoent')
        ? 'The `claude` CLI is not installed on this machine.'
        : `Could not run the Claude CLI to verify this credential: ${message}`,
      { cause: err },
    )
  } finally {
    rmSync(scratchConfigDir, { recursive: true, force: true })
  }

  assertVerificationTurnSucceeded(result)
}

/**
 * The smallest turn that still exercises real authentication. `--output-format
 * json` (not `stream-json`) because there is nothing to stream — one result
 * object is the entire answer.
 */
function verificationTurnArgv(): string[] {
  return [
    'claude',
    '-p',
    'ping',
    '--output-format',
    'json',
    '--model',
    'haiku',
    '--effort',
    'low',
    '--system-prompt',
    'Reply with the single word OK.',
    // Variadic flag; the empty string is the CLI's own documented "no tools"
    // value. Confirmed to survive Windows argv quoting through `Bun.spawn`.
    '--tools',
    '',
    '--disable-slash-commands',
    // Same reason as a chat turn: never inherit the user's own MCP config.
    '--strict-mcp-config',
    // A verification turn is not a conversation — leave no session behind.
    '--no-session-persistence',
  ]
}

/** Turns the verification turn's captured output into pass-or-throw. */
function assertVerificationTurnSucceeded(result: Awaited<ReturnType<typeof runCappedSubprocess>>): void {
  if (result.timedOut) {
    throw new Error('The Claude CLI did not respond within 60s, so this credential could not be verified.')
  }

  const line = parseClaudeCliLine(result.stdout)
  if (!line) {
    throw new Error(
      `Could not verify this credential — the Claude CLI returned an unrecognised response. ${
        result.stderr.trim() || `Exit code ${result.exitCode ?? 'unknown'}.`
      }`,
    )
  }
  if (!line.is_error) return

  if (line.api_error_status === 401) {
    throw new Error(
      'Anthropic rejected this token (401 Invalid bearer token). Run `claude setup-token` again and '
      + 'paste the new `sk-ant-oat…` value — a setup-token can also be revoked or expire.',
    )
  }
  throw new Error(line.result?.trim() || 'The Claude CLI rejected this credential.')
}
