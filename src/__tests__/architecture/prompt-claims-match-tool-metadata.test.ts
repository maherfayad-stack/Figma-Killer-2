/**
 * Architecture Gate — the system prompt may not describe a tool wrongly.
 *
 * ## The bug this exists to keep closed (A11, plan §7 item 15)
 *
 * The static prefix carried a hand-written sentence: "The tools that
 * genuinely require the open board are studio_computed_styles and
 * studio_page_diagnostics." That was true when it was written. `mcp-20` moved
 * `studio_computed_styles` to a headless-first path with the live tab as a
 * mere fallback, and the sentence stayed — because a prompt string has no
 * compiler and no test was watching it.
 *
 * The cost of that particular lie is asymmetric. A prompt that omits a tool
 * loses you a capability you can still rediscover; a prompt that says a
 * WORKING tool needs something you do not have produces no error at all. The
 * agent simply stops calling it, concludes the board is required, and reports
 * "the project is not open" on a question that would have been answered off
 * disk.
 *
 * So the sentence is generated from each tool's own `execution` metadata —
 * the SAME field `executeAiTool` / `mcp/server.ts` dispatch on — and this gate
 * asserts the generated text names **exactly** the `bridge`-only set: nothing
 * missing, and nothing extra.
 *
 * It also asserts the metadata itself is coherent, because generating from a
 * wrong field would just relocate the lie.
 */
import { describe, expect, it } from 'bun:test'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { buildStudioAgentSystemPrompt } from '../../../server/ai/tools/studio/systemPrompt'
import { buildBoardRequirementParagraph } from '../../../server/ai/tools/studio/boardRequirementClaim'
import {
  toolDispatchesInProcess,
  toolRequiresOpenBoard,
  toolsRequiringOpenBoard,
  toolsWithBridgeFallback,
} from '../../../server/ai/runtime/toolExecution'
import { mcpToolsForCapabilities } from '../../../server/ai/mcp/registry'
import { CORE_CAPABILITIES } from '../../../src/core/capabilities'

const ALL_TOOLS = mcpToolsForCapabilities([...CORE_CAPABILITIES])

describe('the prompt\'s live-tab claim is generated, not asserted by hand', () => {
  it('names exactly the bridge-only tools — no more, no fewer', () => {
    const paragraph = buildBoardRequirementParagraph(studioAgentTools)
    const required = toolsRequiringOpenBoard(studioAgentTools)

    expect(required.length).toBeGreaterThan(0)

    // The sentence that makes the claim, isolated so a tool merely MENTIONED
    // elsewhere in the paragraph (the headless half names several) cannot
    // accidentally satisfy this.
    const claim = paragraph.slice(paragraph.indexOf('genuinely require the open board'))

    for (const name of required) {
      expect(claim, `${name} requires the open board but the prompt does not say so`).toContain(name)
    }
    for (const tool of studioAgentTools) {
      if (toolRequiresOpenBoard(tool)) continue
      expect(
        claim,
        `${tool.name} works without a board (execution: '${tool.execution}') but the prompt claims it needs one`,
      ).not.toContain(tool.name)
    }
  })

  it('names the headless-first tools as NOT needing a tab', () => {
    const paragraph = buildBoardRequirementParagraph(studioAgentTools)
    const headless = toolsWithBridgeFallback(studioAgentTools)
    expect(headless.length).toBeGreaterThan(0)
    const headlessHalf = paragraph.slice(0, paragraph.indexOf('genuinely require the open board'))
    for (const name of headless) {
      expect(headlessHalf, `${name} is headless-first but the prompt does not say so`).toContain(name)
    }
  })

  it('studio_computed_styles specifically is no longer claimed to need the board', () => {
    // The exact regression. Named on its own so the failure message says what
    // actually broke instead of "a set mismatched".
    const claim = buildBoardRequirementParagraph(studioAgentTools)
    const boardHalf = claim.slice(claim.indexOf('genuinely require the open board'))
    expect(boardHalf).not.toContain('studio_computed_styles')
  })

  it('the generated paragraph is actually in the prompt the driver sends', () => {
    // Generating a correct sentence nobody splices in would pass every
    // assertion above and change nothing.
    const [prefix] = buildStudioAgentSystemPrompt(null, studioAgentTools)
    expect(prefix).toContain(buildBoardRequirementParagraph(studioAgentTools))
  })

  it('a caller offered no bridge tool is told so, rather than shown a dangling list', () => {
    const headlessOnly = studioAgentTools.filter((t) => !toolRequiresOpenBoard(t))
    const paragraph = buildBoardRequirementParagraph(headlessOnly)
    expect(paragraph).toContain('Nothing you have been offered this turn requires the open board')
  })
})

describe('the execution metadata the prompt is generated from is itself coherent', () => {
  it('every tool declares one of the three documented execution values', () => {
    for (const tool of ALL_TOOLS) {
      expect(
        ['server', 'server-with-bridge-fallback', 'bridge'],
        `${tool.name} declares execution '${tool.execution}'`,
      ).toContain(tool.execution)
    }
  })

  it('every in-process tool has a handler to dispatch to', () => {
    for (const tool of ALL_TOOLS) {
      if (!toolDispatchesInProcess(tool)) continue
      expect(typeof tool.handler, `${tool.name} is dispatched in-process but declares no handler`).toBe('function')
    }
  })

  it('a relayed tool declares no handler, and is scoped to a workspace that has a bridge', () => {
    // `mcp/server.ts` refuses a relayed tool whose scope is not 'site' — this
    // catches that at build time rather than at call time.
    for (const tool of ALL_TOOLS) {
      if (toolDispatchesInProcess(tool)) continue
      expect(tool.handler, `${tool.name} is relayed whole, so its handler would never run`).toBeUndefined()
      expect(tool.scope, `${tool.name} is relayed but scoped '${tool.scope}', which has no bridge`).toBe('site')
    }
  })

  it('a bridge tool dispatches in-process only where that is an enumerated decision', () => {
    // The direction the rest of this block does not cover. `bridge` + a
    // handler is the ONE shape whose dispatch flipped with A11: it used to be
    // relayed (the handler was dead code under `execution === 'browser'`) and
    // now runs server-side. That is right for `studio_page_diagnostics`, whose
    // handler owns its own relay — and silently wrong for a tool that grows a
    // handler expecting the runner to still forward the call, which would then
    // execute in-process while the prompt tells the model it needs the board.
    // Enumerated, so adding one is a decision somebody makes on purpose.
    const declared = new Set(['studio_page_diagnostics'])

    for (const tool of ALL_TOOLS) {
      if (tool.execution !== 'bridge' || tool.handler === undefined) continue
      expect(
        declared.has(tool.name),
        `${tool.name} is execution:'bridge' WITH a handler, so the runner dispatches it in-process rather than relaying it. `
          + 'If its handler does its own relay (and owns the "no board is connected" message), add it to this list. '
          + 'If it expected to be relayed whole, drop the handler.',
      ).toBe(true)
    }

    // And the list cannot outlive the shape it describes.
    for (const name of declared) {
      const tool = ALL_TOOLS.find((t) => t.name === name)
      expect(tool, `${name} is listed here but is not a registered tool`).toBeDefined()
      expect(tool!.execution).toBe('bridge')
      expect(typeof tool!.handler).toBe('function')
    }
  })

  it('no tool claims a bridge fallback it cannot take', () => {
    // `server-with-bridge-fallback` is a promise that the tool keeps working
    // without a tab. A tool making that claim with no handler at all could
    // only ever be relayed, i.e. it needs the tab absolutely.
    for (const tool of ALL_TOOLS) {
      if (tool.execution !== 'server-with-bridge-fallback') continue
      expect(typeof tool.handler, `${tool.name} claims a headless path but has no server handler`).toBe('function')
    }
  })
})
