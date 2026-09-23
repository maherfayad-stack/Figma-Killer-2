/**
 * Studio's system prompt, as the `claude` CLI receives it.
 *
 * ## What reaches the CLI
 *
 * `req.systemPrompt` for a Studio-project turn is `[staticPrefix,
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]`
 * (`buildStudioAgentSystemPrompt`). The static prefix is the role, the
 * workflow, the failure list, the "Parallel work" subagent contract, and the
 * two per-session blocks: `MODE_BLOCK[fidelityMode]` and
 * `DESIGN_POLICY_BLOCK[designPolicy]`. The suffix is the live board state.
 *
 * The CLI gets ALL of it, appended after its own base prompt. It used to get
 * only the suffix, on the theory that the project's generated `CLAUDE.md`
 * "covers the same ground". It did not: the mode and design-policy controls
 * had no effect on the default path, the subagent contract never reached the
 * only path that holds `Task`, and `CLAUDE.md` carried policy that
 * contradicted the user's own choice ("always use the design system, there is
 * no third option" under a FREE policy). Audit 06, AI-1 and AI-3. `CLAUDE.md`
 * now carries project FACTS only (`projectGuide.ts`); the prompt carries the
 * guidance, on both paths, from one source.
 *
 * ## Why a file, and never argv
 *
 * The static prefix alone is ~34-36 KB for every (mode, policy) pair.
 * Windows' `CreateProcess` caps the whole command line at 32,767 characters,
 * so `--append-system-prompt <text>` cannot carry it: the spawn fails outright.
 * `--append-system-prompt-file <path>` (print mode only, which every Studio
 * turn is) reads the same text from a file, so the text goes in a file on
 * every platform. One path, not a size-dependent branch: a prompt that grows
 * past the limit later would otherwise change delivery mechanism silently.
 * The CLI refuses `--append-system-prompt` and `--append-system-prompt-file`
 * together, so the dynamic suffix rides in the same file, after the prefix.
 *
 * The file holds no secret (no token, no credential; the board digest is the
 * user's own project state), but it is still written into a fresh
 * `mkdtemp` directory with an exclusive 0600 create, so nothing else can
 * plant or swap it between write and spawn.
 *
 * ## Lifetime
 *
 * A cold turn writes it, spawns, and deletes it in its `finally`. A warm
 * session writes it at spawn and deletes it in `dispose`, because the process
 * was started from it and outlives the turn.
 *
 * ## The prompt version
 *
 * `version` is a sha256 of the static prefix, and the warm pool's reuse
 * fingerprint carries it (`claudeCliWarmTurn.ts`). The static prefix is
 * fixed at spawn: a warm process has no way to receive a new one. So a change
 * of fidelity mode, of design policy, or of the prompt source itself (a
 * Studio upgrade, a capability change that alters the "Tools available"
 * line) must respawn, never reuse a process running on stale guidance. A
 * content hash is the version that cannot be forgotten: a hand-bumped
 * constant is correct only until the first edit that does not bump it. The
 * dynamic suffix is deliberately NOT in it — it changes every turn, and a
 * warm turn carries a changed one in the user message instead.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../runtime/types'
import { writePrivateFileExclusive } from '../credentials/privateTempDir'

export interface ClaudeCliSystemPrompt {
  /** Everything before the boundary: prefix, mode block, policy block. Fixed for a process's lifetime. */
  readonly staticPrefix: string
  /** sha256 of `staticPrefix` — the prompt version the warm pool's fingerprint carries. */
  readonly version: string
  /** The live board state after the boundary, or `null` when it is empty. */
  readonly dynamicSuffix: string | null
}

/**
 * Split a Studio system prompt into the parts the CLI needs, or `null` when
 * there is no boundary marker. Every real Studio-project turn has one
 * (`buildStudioAgentSystemPrompt`'s contract); a missing marker means this is
 * not a Studio prompt, and guessing which half is which would be worse than
 * sending nothing.
 */
export function claudeCliSystemPrompt(systemPrompt: readonly string[]): ClaudeCliSystemPrompt | null {
  const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (boundaryIndex === -1) return null
  const staticPrefix = systemPrompt.slice(0, boundaryIndex).join('\n\n').trim()
  const suffix = systemPrompt.slice(boundaryIndex + 1).join('\n\n').trim()
  return {
    staticPrefix,
    version: createHash('sha256').update(staticPrefix, 'utf8').digest('hex'),
    dynamicSuffix: suffix.length > 0 ? suffix : null,
  }
}

/** The exact text the CLI appends to its own system prompt at spawn: the static prefix, then the live state. */
export function appendedSystemPromptText(prompt: ClaudeCliSystemPrompt): string {
  return prompt.dynamicSuffix ? `${prompt.staticPrefix}\n\n${prompt.dynamicSuffix}` : prompt.staticPrefix
}

const SYSTEM_PROMPT_DIR_PREFIX = 'studio-claude-cli-system-prompt-'
const SYSTEM_PROMPT_FILE_NAME = 'append-system-prompt.md'

export interface SystemPromptFile {
  /** The directory holding just this one file — removed wholesale on cleanup. */
  readonly dir: string
  /** Absolute path to pass as `--append-system-prompt-file <path>`. */
  readonly path: string
}

/**
 * Write the appended prompt to a fresh file, or return `null` (logged) when
 * that fails. A turn that cannot get the file runs on the CLI's own prompt and
 * `CLAUDE.md` alone rather than failing: the same fail-soft posture a failed
 * MCP config write already has (`tryWriteMcpConfigFile`), shared by the warm
 * and cold paths so they cannot drift on it.
 */
export function tryWriteSystemPromptFile(prompt: ClaudeCliSystemPrompt): SystemPromptFile | null {
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), SYSTEM_PROMPT_DIR_PREFIX))
    const path = join(dir, SYSTEM_PROMPT_FILE_NAME)
    writePrivateFileExclusive(path, appendedSystemPromptText(prompt))
    return { dir, path }
  } catch (err) {
    if (dir) cleanupSystemPromptFile(dir)
    console.error('[ai/claudeCli] failed to write the system prompt file — continuing without Studio guidance:', err)
    return null
  }
}

/** Delete the file's directory. Never throws: a failed cleanup must not become a turn-level error. */
export function cleanupSystemPromptFile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.error('[ai/claudeCli] failed to clean up the system prompt file — continuing:', err)
  }
}
