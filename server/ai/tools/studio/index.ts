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
 *   - **Most of it is now dead weight.** The agent authors whole files: with
 *     native `Read`/`Write`/`Edit`/`Glob`/`Grep` inside the project `cwd`
 *     on the `claude` CLI (`claudeCliToolSurface.ts`), and with the Studio
 *     file tools on the HTTP drivers (`studioHttpAgentTools`, below). The AST
 *     edit API (`studio_apply_edits`, `studio_codemod`, `studio_create_page`,
 *     `studio_find_nodes`) is strictly slower than that and pushed the model
 *     toward one enormous inline `style={{…}}`. It stays in the MCP registry
 *     for external clients; it is not what the in-canvas agent is offered.
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
import { studioAgentFileWriteTools } from '../../mcp/tools/studio/fileWriteTools'
import { STUDIO_AGENT_TOOL_NAMES, STUDIO_HTTP_AGENT_FILE_TOOL_NAMES } from './agentToolNames'

const byName = new Map([...studioMcpTools, ...studioAgentFileWriteTools].map((tool) => [tool.name, tool]))

function resolveAgentTool(name: string): AiTool {
  const tool = byName.get(name)
  if (!tool) {
    // A rename in `mcp/tools/studio/*.ts` that orphans a name here would
    // otherwise silently drop a capability from the agent's surface, and the
    // only symptom would be the model working around a tool it was never
    // offered. Fail loudly at module load instead.
    throw new Error(`[ai/tools/studio] "${name}" is named for the agent's surface but is not a registered Studio tool.`)
  }
  return tool
}

/** What the in-canvas agent gets on the `claude` CLI path, which brings its own native file tools. */
export const studioAgentTools: AiTool[] = STUDIO_AGENT_TOOL_NAMES.map(resolveAgentTool)

/**
 * What the in-canvas agent gets on an HTTP driver: everything above, plus the
 * file tools an HTTP driver has no native equivalent of (P4-C, AI-2 — see
 * `STUDIO_HTTP_AGENT_FILE_TOOL_NAMES`).
 */
export const studioHttpAgentTools: AiTool[] = [
  ...studioAgentTools,
  ...STUDIO_HTTP_AGENT_FILE_TOOL_NAMES.map(resolveAgentTool),
]

export { STUDIO_AGENT_TOOL_NAMES, STUDIO_HTTP_AGENT_FILE_TOOL_NAMES, agentFileAccessFor } from './agentToolNames'
export type { AgentFileAccess } from './agentToolNames'
export {
  buildStudioAgentSystemPrompt,
  studioPromptContextFromProfile,
  StudioPromptContextSchema,
} from './systemPrompt'
export type { StudioPromptContext } from './systemPrompt'
