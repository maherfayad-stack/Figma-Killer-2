/**
 * claudeCliSystemPrompt — Studio's system prompt reaches the CLI, whole, on
 * both the warm and the cold path, and a changed prompt never reuses a warm
 * process that was started with the old one (audit 06, AI-1).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../runtime/types'
import { buildStudioAgentSystemPrompt } from '../tools/studio/systemPrompt'
import { studioAgentTools } from '../tools/studio'
import { FIDELITY_MODES } from '../../handlers/studio/fidelityMode'
import { DESIGN_POLICIES } from '../../handlers/studio/designPolicy'
import { buildClaudeCliArgv } from './claudeCliArgv'
import { appendedSystemPromptText, claudeCliSystemPrompt } from './claudeCliSystemPrompt'
import { runClaudeCliTurns } from './claudeCli.testHelpers'

/** `CreateProcess`'s limit on the WHOLE command line, in UTF-16 code units. */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767

const prompt = (prefix: string, suffix: string) => [prefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, suffix]

describe('claudeCliSystemPrompt', () => {
  it('splits at the boundary and appends the live state after the static prefix', () => {
    const parts = claudeCliSystemPrompt(prompt('PREFIX', 'SUFFIX'))!
    expect(parts.staticPrefix).toBe('PREFIX')
    expect(parts.dynamicSuffix).toBe('SUFFIX')
    expect(appendedSystemPromptText(parts)).toBe(['PREFIX', 'SUFFIX'].join('\n\n'))
  })

  it('returns null without a boundary rather than guessing which half is which', () => {
    expect(claudeCliSystemPrompt(['a CMS prompt'])).toBeNull()
  })

  it('versions the static prefix only — a new board digest is not a new prompt', () => {
    const a = claudeCliSystemPrompt(prompt('PREFIX', 'board: 1 page'))!
    const b = claudeCliSystemPrompt(prompt('PREFIX', 'board: 2 pages'))!
    const c = claudeCliSystemPrompt(prompt('PREFIX CHANGED', 'board: 1 page'))!
    expect(a.version).toBe(b.version)
    expect(a.version).not.toBe(c.version)
  })
})

describe('the prompt goes through a file because it cannot go through argv', () => {
  it('the real prompts sit within reach of the whole Windows command line, so argv would fail on some turns', () => {
    // The reason `--append-system-prompt <text>` is not an option. The largest
    // static prefix alone is within a few KB of the limit, and the dynamic
    // suffix after it (the board digest, the selection's excerpts, the
    // capability lines) adds kilobytes that vary per turn. On argv the spawn
    // would work on one turn and fail outright on the next, depending on the
    // board — a size-dependent failure, which is why the prompt goes through a
    // file on EVERY turn rather than switching mechanism at a threshold.
    let largest = 0
    for (const mode of FIDELITY_MODES) {
      for (const policy of DESIGN_POLICIES) {
        const [staticPrefix] = buildStudioAgentSystemPrompt(null, studioAgentTools, null, mode, policy)
        largest = Math.max(largest, staticPrefix!.length)
      }
    }
    expect(largest).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT * 0.9)
  })

  it('the argv that carries it stays far below that limit', () => {
    const argv = buildClaudeCliArgv({
      modelId: 'opus',
      effort: 'medium',
      permissionMode: 'bypassPermissions',
      nativeTools: 'Read,Write,Edit,Glob,Grep,Task',
      addDirs: ['C:\\Users\\someone\\AppData\\Local\\Temp\\studio-attachments\\conversation'],
      mcpConfigPath: 'C:\\Users\\someone\\AppData\\Local\\Temp\\studio-claude-cli-mcp-config-abc\\mcp-config.json',
      appendSystemPromptFile: 'C:\\Users\\someone\\AppData\\Local\\Temp\\studio-claude-cli-system-prompt-abc\\append-system-prompt.md',
      sessionFlag: '--session-id',
      sessionId: '00000000-0000-0000-0000-000000000000',
      inputFormat: 'stream-json',
    })
    expect(argv.join(' ').length).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT / 8)
    expect(argv).not.toContain('--append-system-prompt')
  })
})

describe('the warm pool never serves a turn on a stale prompt', () => {
  const MODE_A = prompt('# Fidelity: CREATIVE', 'board: 1 page')
  const MODE_B = prompt('# Fidelity: STRICT', 'board: 1 page')

  it('respawns when the static prompt changes (a mode or policy switch), and the new process gets the new prompt', async () => {
    const { turns, spawns } = await runClaudeCliTurns([MODE_A, MODE_B], { warm: true })
    expect(spawns).toBe(2)
    expect(turns[0]!.appendedSystemPrompt).toContain('# Fidelity: CREATIVE')
    expect(turns[1]!.appendedSystemPrompt).toContain('# Fidelity: STRICT')
    expect(turns[1]!.appendedSystemPrompt).not.toContain('CREATIVE')
  })

  it('reuses the process when only the live state changed, and carries the new state in the message', async () => {
    const { turns, spawns } = await runClaudeCliTurns([MODE_A, prompt('# Fidelity: CREATIVE', 'board: 2 pages')], {
      warm: true,
    })
    expect(spawns).toBe(1)
    expect(turns[1]!.prompt).toContain('board: 2 pages')
    expect(turns[1]!.prompt).not.toContain('# Fidelity')
  })

  it('leaves no prompt file behind once a cold turn or a warm session ends', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('studio-claude-cli-system-prompt-')))
    const cold = await runClaudeCliTurns([MODE_A], { warm: false })
    const warm = await runClaudeCliTurns([MODE_A], { warm: true })
    for (const { turns } of [cold, warm]) {
      const argv = turns[0]!.argv
      const path = argv[argv.indexOf('--append-system-prompt-file') + 1]!
      expect(existsSync(path)).toBe(false)
    }
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('studio-claude-cli-system-prompt-'))
    expect(after.filter((name) => !before.has(name))).toEqual([])
  })
})
