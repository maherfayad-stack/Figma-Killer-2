/**
 * Architecture Gate — every measurement tool the Studio agent is offered must
 * be one it can actually call, and the prompt must require the measurement it
 * has.
 *
 * ## The bug this exists to keep closed
 *
 * The fidelity workflow existed on paper — register a design reference,
 * recommend an export dpr, export the frame, diff the two. For the in-canvas
 * agent it was **unreachable**, and nothing said so. `studio_diff_frames`
 * takes its `baseline` as a base64 STRING, while a capture arrives as an MCP
 * *image block*: the model can look at that image, but it cannot transcribe
 * the bytes back into base64 text. There was no sequence of calls that got
 * the agent from "I captured the screen" to "I measured the screen".
 *
 * So the agent did the only thing left — judged its own work by eye — and
 * passed screens whose subtitle overlapped the heading and whose icons
 * rendered as specks. The prompt asking it to measure harder could never have
 * worked, because measuring was not possible.
 *
 * `studio_compare` closes it by capturing server-side, so neither image
 * transits the model. This gate holds three things together:
 *
 *   1. the agent is offered `studio_compare`,
 *   2. it is NOT offered the base64-input tools it cannot satisfy — offering a
 *      tool that can only fail buys wasted turns and teaches the agent that
 *      measurement does not work,
 *   3. the prompt states a passing measurement as the definition of done
 *      rather than as a suggestion.
 */
import { describe, expect, it } from 'bun:test'
import { STUDIO_AGENT_TOOL_NAMES } from '../../../server/ai/tools/studio/agentToolNames'
import { studioAgentTools } from '../../../server/ai/tools/studio'
import { buildStudioAgentSystemPrompt } from '../../../server/ai/tools/studio/systemPrompt'

const staticPrefix = (): string => buildStudioAgentSystemPrompt(null, studioAgentTools)[0]!

describe('the Studio agent can measure its own work', () => {
  it('is offered studio_compare', () => {
    expect(STUDIO_AGENT_TOOL_NAMES).toContain('studio_compare')
  })

  it('is NOT offered a tool whose required input it cannot produce', () => {
    // A capture reaches this agent as an image block, never as text it can
    // echo back. Any tool demanding base64 image bytes as a STRING input is
    // unreachable for it by construction.
    expect(STUDIO_AGENT_TOOL_NAMES).not.toContain('studio_diff_frames')
    expect(STUDIO_AGENT_TOOL_NAMES).not.toContain('studio_export_frames')
  })

  it('every offered name still resolves to a real tool', () => {
    // `studioAgentTools` throws at module load on an orphaned name; this
    // asserts the resolved surface matches the declared one so a rename
    // cannot quietly shrink it.
    expect(studioAgentTools.map((t) => t.name).sort()).toEqual([...STUDIO_AGENT_TOOL_NAMES].sort())
  })

  it('studio_compare captures for itself — it takes page NAMEs, not image bytes', () => {
    const compare = studioAgentTools.find((t) => t.name === 'studio_compare')!
    const props = (compare.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    // mcp-tooling CHANGE A — `page` (singular) became `pages` (a name-resolved
    // batch, same shape `studio_screenshot` already used) so a multi-screen
    // flow can be measured in one call instead of one round trip per screen.
    expect(Object.keys(props)).toContain('pages')
    // The moment `studio_compare` grows a base64 image input, it has
    // reintroduced the exact unreachability this gate exists to prevent.
    expect(Object.keys(props)).not.toContain('baseline')
    expect(Object.keys(props)).not.toContain('reference')
  })

  it('the prompt makes a passing measurement the definition of done, not a suggestion', () => {
    const prompt = staticPrefix()
    expect(prompt).toContain('studio_compare')
    expect(prompt).toContain('pass:true')
  })

  it('the prompt forbids inventing an asset it could not obtain', () => {
    // The other half of the same failure: told to match a design whose assets
    // it had no way to fetch, the agent hand-wrote SVG path data and shaped
    // photos out of CSS rather than naming the gap.
    const prompt = staticPrefix().toLowerCase()
    expect(prompt).toContain('cannot invent an asset')
    expect(prompt).toContain('placeholder')
  })
})
