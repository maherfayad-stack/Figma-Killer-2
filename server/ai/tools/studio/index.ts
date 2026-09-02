/**
 * Studio-project tool barrel — the toolset offered to the in-canvas AGENT for
 * a turn where a real Studio project is open, as opposed to the CMS `site`
 * toolset (`../site/index.ts`) or the full external-client MCP registry
 * (`server/ai/mcp/registry.ts`).
 *
 * ## Why this is a subset, and not simply `studioMcpTools`
 *
 * It used to be exactly that list — all of it, ~35 tools, plus the entire CMS
 * `site_*` toolset the MCP registry also advertises. Two things were wrong
 * with that, and they compounded:
 *
 *   - **Most of it is now dead weight.** The agent authors files with native
 *     `Read`/`Write`/`Edit`/`Glob`/`Grep` inside the project `cwd`
 *     (`claudeCliToolSurface.ts`). Every tool that existed only because the
 *     agent had no filesystem — `studio_read_file`, `studio_list_files`,
 *     `studio_create_page`, `studio_apply_edits`, `studio_codemod`,
 *     `studio_find_nodes`, `studio_get_node_source` — is strictly slower than
 *     the native equivalent and, in the write cases, pushed the model toward
 *     one enormous inline `style={{…}}` because that was the shape the edit
 *     API rewarded. They stay in the MCP registry for external clients that
 *     genuinely have no filesystem access to the project; they are not what
 *     the in-canvas agent is offered.
 *   - **A large toolset is itself a latency and accuracy cost.** Every tool
 *     definition is re-sent on every turn, and a model choosing among ~60
 *     tools — half of them for a CMS this project does not use — picks wrong
 *     and explores instead of acting.
 *
 * What survives is what the filesystem cannot do: SEE the canvas
 * (`studio_screenshot` and the reference/diff family), change board geometry,
 * read the project's design tokens and component catalog, install
 * dependencies behind the trust-tier gate, and pull assets in.
 *
 * `studio_apply_edits` is not deprecated and has not moved — the canvas
 * panels' writeback path (`studioWriteback.ts`) is its real consumer, and that
 * is not agent code.
 *
 * These are the SAME `AiTool` objects `server/ai/mcp/registry.ts` exposes —
 * one implementation, two consumers, one composition each. Fixing a tool's
 * description or behaviour in `server/ai/mcp/tools/studio/*.ts` fixes it for
 * both at once.
 */
import type { AiTool } from '../types'
import { studioMcpTools } from '../../mcp/tools/studio'
import { STUDIO_AGENT_TOOL_NAMES } from './agentToolNames'

const byName = new Map(studioMcpTools.map((tool) => [tool.name, tool]))

export const studioAgentTools: AiTool[] = STUDIO_AGENT_TOOL_NAMES.map((name) => {
  const tool = byName.get(name)
  if (!tool) {
    // A rename in `mcp/tools/studio/*.ts` that orphans a name here would
    // otherwise silently drop a capability from the agent's surface, and the
    // only symptom would be the model working around a tool it was never
    // offered. Fail loudly at module load instead.
    throw new Error(`[ai/tools/studio] STUDIO_AGENT_TOOL_NAMES names "${name}", which is not a registered Studio MCP tool.`)
  }
  return tool
})

export { STUDIO_AGENT_TOOL_NAMES } from './agentToolNames'
export {
  buildStudioAgentSystemPrompt,
  studioPromptContextFromProfile,
  StudioPromptContextSchema,
} from './systemPrompt'
export type { StudioPromptContext } from './systemPrompt'
