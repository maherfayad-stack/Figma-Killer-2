/**
 * Prompt ⇄ registry parity gate (WS-12 §9) — mirrors
 * `mcp/tools/studio/fidelityCodes.test.ts`'s doc⇄code pattern. Every
 * `studio_*`-shaped token in the Studio system prompt's static prefix must
 * be a REAL tool name in `studioAgentTools` — a prompt naming a renamed or
 * removed tool is invisible until an agent fails at runtime, exactly the
 * failure mode this gate exists to catch before it ships.
 */
import { describe, expect, it } from 'bun:test'
import { buildStudioAgentSystemPrompt } from './systemPrompt'
import { studioAgentTools } from './index'

/** Every `studio_snake_case` token appearing anywhere in `text`, de-duplicated. */
function extractToolLikeTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/\bstudio_[a-z_]+\b/g)) {
    tokens.add(match[0])
  }
  return tokens
}

describe('Studio system prompt — tool registry parity', () => {
  it('builds the cacheable 3-element form', () => {
    const prompt = buildStudioAgentSystemPrompt(null)
    expect(prompt).toHaveLength(3)
    expect(prompt[1]).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  })

  it('every studio_* token named in the static prefix is a real registered tool', () => {
    const [prefix] = buildStudioAgentSystemPrompt(null)
    const named = extractToolLikeTokens(prefix!)
    const registered = new Set(studioAgentTools.map((t) => t.name))
    // The prefix must actually reference tools — an empty extraction would
    // make every assertion below vacuously true and hide a real drift.
    expect(named.size).toBeGreaterThan(0)
    for (const name of named) {
      expect(registered.has(name)).toBe(true)
    }
  })

  it('the "Tools available" line lists every registered tool by name', () => {
    const [prefix] = buildStudioAgentSystemPrompt(null)
    for (const tool of studioAgentTools) {
      expect(prefix).toContain(tool.name)
    }
  })

  it('has no duplicate tool names in the registry', () => {
    const names = studioAgentTools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
