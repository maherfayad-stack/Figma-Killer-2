/**
 * `claude` CLI availability probe — WS-11 §4.0.
 *
 * `claude auth status --json` is the ONLY probe this driver uses: exit 0 with
 * `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro",…}`,
 * exit 1 with `{"loggedIn":false,"authMethod":"none"}`. No model call, no
 * cost, no session file. Runs through `runCappedSubprocess`
 * (`subprocessRunner.ts`) — a one-shot call whose only useful result is the
 * fully-captured stdout after exit, unlike a chat turn which needs
 * `claudeCliSpawn.ts`'s incremental reader.
 *
 * `cwd` is deliberately a neutral, empty directory (`os.tmpdir()`), never a
 * real project — WS-11 §4.0's cost warning ("a single trivial prompt in this
 * repo cost $0.168 because it cache-created ~27k tokens of CLAUDE.md and
 * context") is about `-p` prompts specifically, but there is no reason to
 * risk it: a probe that never spends a token should never even sit in a
 * directory that could tempt one.
 *
 * ## What this probe does NOT prove
 *
 * `auth status` answers "is there a credential here?", NOT "does that
 * credential work?" — it never contacts Anthropic. Confirmed empirically: with
 * `CLAUDE_CODE_OAUTH_TOKEN` set to the invented string
 * `sk-ant-oat01-totally-made-up-…`, it exits 0 with
 * `{"loggedIn":true,"authMethod":"oauth_token"}`, while a real turn with that
 * same token dies on `401 Invalid bearer token`.
 *
 * So this is the right probe for the disabled-with-reason state behind the
 * model picker (a config dir with nothing in it genuinely cannot chat), and
 * the WRONG probe for verifying a stored credential — that needs a real turn,
 * which is why `verifyClaudeCliCredential` (`claudeCli.ts`) spawns one instead
 * of calling in here. An earlier version of this module accepted an
 * `oauthToken` option for exactly that misuse; it shipped a "Test" button that
 * passed a token Anthropic rejects. Do not add it back.
 */

import { tmpdir } from 'node:os'
import { parseValue } from '@core/utils/typeboxHelpers'
import { minimalSubprocessEnv, runCappedSubprocess, type SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { ClaudeCliAuthStatusSchema, type ClaudeCliAuthStatus } from './claudeCliEvents'

const PROBE_TIMEOUT_MS = 15_000
const PROBE_MAX_BYTES = 16 * 1024

export type ClaudeCliAvailability =
  | { readonly status: 'logged-in'; readonly authStatus: ClaudeCliAuthStatus }
  | { readonly status: 'logged-out'; readonly authStatus: ClaudeCliAuthStatus }
  | { readonly status: 'not-installed' }
  | { readonly status: 'probe-failed'; readonly reason: string }

export interface ProbeClaudeCliOptions {
  readonly configDir: string
  /** Test seam — forwarded to `runCappedSubprocess`. */
  readonly spawn?: SubprocessSpawnFn
}

/**
 * Run `claude auth status --json` inside `configDir`'s `CLAUDE_CONFIG_DIR`
 * and classify the result. Never throws — every failure mode (binary
 * missing, malformed JSON, timeout) resolves to a `ClaudeCliAvailability`
 * variant the caller can render directly as a disabled-with-reason state.
 */
export async function probeClaudeCliAuth(
  options: ProbeClaudeCliOptions,
): Promise<ClaudeCliAvailability> {
  let result: Awaited<ReturnType<typeof runCappedSubprocess>>
  try {
    result = await runCappedSubprocess(['claude', 'auth', 'status', '--json'], {
      cwd: tmpdir(),
      env: minimalSubprocessEnv([], { CLAUDE_CONFIG_DIR: options.configDir }),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdoutBytes: PROBE_MAX_BYTES,
      maxStderrBytes: PROBE_MAX_BYTES,
      spawn: options.spawn,
    })
  } catch (err) {
    // No shell sits between us and the binary (`subprocessRunner.ts`'s own
    // contract — argv[0] is executed directly), so a missing `claude` binary
    // throws synchronously from the spawn call itself (ENOENT) rather than
    // producing a "command not found" exit — there's no shell to print it.
    const message = err instanceof Error ? err.message : String(err)
    if (looksLikeCommandNotFound(message)) return { status: 'not-installed' }
    return { status: 'probe-failed', reason: message }
  }

  if (result.exitCode === null) {
    // Killed by the timeout, or the spawn itself never produced an exit code
    // (defensive — `runCappedSubprocess` only returns after `proc.exited`
    // resolves, so this path is effectively "the probe hung and was killed").
    return { status: 'probe-failed', reason: result.timedOut ? 'Claude CLI probe timed out.' : 'Claude CLI probe did not exit cleanly.' }
  }

  // A missing binary reads as a non-zero exit with no parseable JSON on
  // either stream on most shells; distinguish it from "installed, logged
  // out" (also non-zero, but WITH a `{"loggedIn":false}` body) by whether the
  // body parses at all.
  const parsed = tryParseAuthStatus(result.stdout)
  if (!parsed) {
    if (looksLikeCommandNotFound(result.stderr)) return { status: 'not-installed' }
    return {
      status: 'probe-failed',
      reason: result.stderr.trim() || 'Claude CLI returned an unrecognised response.',
    }
  }

  return parsed.loggedIn
    ? { status: 'logged-in', authStatus: parsed }
    : { status: 'logged-out', authStatus: parsed }
}

function tryParseAuthStatus(stdout: string): ClaudeCliAuthStatus | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return null
  }
  try {
    return parseValue(ClaudeCliAuthStatusSchema, json)
  } catch {
    return null
  }
}

function looksLikeCommandNotFound(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return (
    lower.includes('command not found')
    || lower.includes('not recognized as an internal or external command')
    || lower.includes('no such file or directory')
    || lower.includes('enoent')
  )
}
