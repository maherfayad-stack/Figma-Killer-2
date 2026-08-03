/**
 * The Studio system prompt names the valid `subagent_type` values. Those names
 * must stay in sync with the roster `agentRoster.ts` actually generates.
 *
 * ## Why the prompt names them at all
 *
 * `Task` is one of only two native tools the driver grants
 * (`resolveNativeToolAllowlist`), and the CLI does NOT error on an unknown
 * `subagent_type` — it silently falls back to its own built-in
 * `general-purpose` agent, whose description advertises "file editing,
 * writing, and bash". None of those exist under this session's `--tools`
 * ceiling, so the fallback runs, writes nothing, and returns as if it had
 * worked. Observed exactly that way: the agent delegated screen authoring to
 * an invented `studio-implementer`, reported ten files written in detail, and
 * every one of them was still an untouched scaffold.
 *
 * A silent fallback plus an invented name is unrecoverable at runtime, so the
 * defence is to tell the model the real names up front — which only helps
 * while the list is true. Hence this gate.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStudioAgentSystemPrompt } from '../../../server/ai/tools/studio/systemPrompt'

const ROSTER_SOURCE = join(import.meta.dir, '../../../server/handlers/studio/agentRoster.ts')

/** Every `name: '<kebab-case>'` an agent definition in `agentRoster.ts` declares. */
function rosterAgentNames(): string[] {
  const source = readFileSync(ROSTER_SOURCE, 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/^\s*name: '([a-z][a-z0-9-]*)',$/gm)) {
    names.add(match[1]!)
  }
  return [...names].sort()
}

describe('Studio system prompt names the real subagent roster', () => {
  it('finds the roster definitions at all', () => {
    // Guards the regex itself: a refactor that changes how agents declare
    // their name would otherwise make this whole file vacuously pass.
    expect(rosterAgentNames().length).toBeGreaterThanOrEqual(9)
  })

  it('mentions every generated agent, so the model never has to invent one', () => {
    const staticPrefix = buildStudioAgentSystemPrompt(null)[0]!
    const missing = rosterAgentNames().filter((name) => !staticPrefix.includes(name))

    expect(missing).toEqual([])
  })

  it('states that subagents have no write tools either', () => {
    const staticPrefix = buildStudioAgentSystemPrompt(null)[0]!
    // The specific misconception that produced the fabricated report: that
    // delegating obtains a Write/Edit the parent lacks.
    expect(staticPrefix).toContain('NO subagent has Write, Edit, or Bash')
  })
})
