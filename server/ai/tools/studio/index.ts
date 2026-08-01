/**
 * Studio-project tool barrel (WS-12 §3) — the toolset offered to the agent
 * for a turn where a real Studio project is open, as opposed to the CMS
 * `site` toolset (`../site/index.ts`).
 *
 * Every one of these tools is `execution: 'server'` (see `AiTool` in
 * `../../runtime/types.ts`) — Studio's truth is the filesystem, not a live
 * browser store, so there is no browser-bridge round trip the way the CMS
 * `site_*` write tools need. `mutates`/`requiredCapabilities` are already
 * stamped on each tool object at its own definition site (`studio.write` for
 * every write), unlike `site/index.ts`, which stamps the flag externally at
 * assembly time — nothing to do here but compose the list.
 *
 * These are the SAME `AiTool` objects `server/ai/mcp/registry.ts` exposes to
 * external MCP clients over `/_studio/mcp` — one implementation, two
 * consumers (the in-process HTTP-driver tool loop here, and Studio's own MCP
 * server for `claudeCli`/external agents). Fixing a tool's description or
 * behaviour in one of the `server/ai/mcp/tools/studio/*.ts` source files
 * fixes it for both at once.
 */
import type { AiTool } from '../types'
import { studioMcpTools } from '../../mcp/tools/studio'

export const studioAgentTools: AiTool[] = studioMcpTools

export {
  buildStudioAgentSystemPrompt,
  studioPromptContextFromProfile,
  StudioPromptContextSchema,
} from './systemPrompt'
export type { StudioPromptContext } from './systemPrompt'
