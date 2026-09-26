/**
 * Architecture Gate — every tool description fits in 900 characters (AI-29).
 *
 * A tool's description is re-sent to the model on EVERY round of every turn,
 * on both agent paths. The audit (06 §6, AI-29) measured ~81 K characters of
 * descriptions across the surface, with `studio_apply_edits` alone at 7 K:
 * design history, the bug each rule once fixed, and cross-references to
 * other modules. None of that helps a model decide what to call; all of it is
 * paid for, and a smaller model reading a 3 K paragraph misses the one
 * sentence that says what the tool refuses.
 *
 * So a description says three things only — when to use the tool, what it
 * returns, and its refusal codes — and the WHY lives in the tool's own module
 * doc and in `docs/features/agent.md` → "Tool descriptions". Field-level
 * detail belongs on the field (`Type.String({ description })`), where it is
 * read beside the value it describes.
 *
 * The surface checked is every tool any caller can be offered: the full
 * external MCP registry with every capability held, both in-canvas agent
 * surfaces, the CMS `site` toolset, and the HTTP-only tools composed outside
 * the registry (`studio_propose_plan`, `studio_delegate`).
 */
import { describe, expect, it } from 'bun:test'
import { CORE_CAPABILITIES } from '../../core/capabilities'
import { mcpToolsForCapabilities } from '../../../server/ai/mcp/registry'
import { studioHttpAgentTools } from '../../../server/ai/tools/studio'
import { siteTools } from '../../../server/ai/tools/site'
import { selectStudioTools } from '../../../server/ai/tools'
import type { AiTool } from '../../../server/ai/runtime/types'

/** The ceiling, in UTF-16 code units (`String#length`) — the unit every prompt budget in this repo uses. */
const MAX_DESCRIPTION_CHARS = 900

function everyOfferableTool(): AiTool[] {
  const byName = new Map<string, AiTool>()
  const httpPlanSurface = selectStudioTools([...CORE_CAPABILITIES], {
    studioProjectOpen: true,
    fileAccess: 'studio-tools',
    planMode: true,
  })
  for (const tool of [
    ...mcpToolsForCapabilities([...CORE_CAPABILITIES]),
    ...studioHttpAgentTools,
    ...httpPlanSurface,
    ...siteTools,
  ]) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()]
}

describe('tool descriptions are short enough to be read (AI-29)', () => {
  const tools = everyOfferableTool()

  it('covers the HTTP-only tools composed outside the registry', () => {
    const names = new Set(tools.map((tool) => tool.name))
    expect(names.has('studio_propose_plan')).toBe(true)
    expect(names.has('studio_write_file')).toBe(true)
  })

  it(`every description is at most ${MAX_DESCRIPTION_CHARS} characters`, () => {
    const over = tools
      .filter((tool) => tool.description.length > MAX_DESCRIPTION_CHARS)
      .map((tool) => `${tool.name}: ${tool.description.length}`)
      .sort()
    expect(
      over,
      'Trim each to when-to-use, returns and refusal codes; move the rationale to the module doc or docs/features/agent.md.',
    ).toEqual([])
  })

  it('every description is non-empty', () => {
    for (const tool of tools) expect(tool.description.trim().length, tool.name).toBeGreaterThan(0)
  })
})
