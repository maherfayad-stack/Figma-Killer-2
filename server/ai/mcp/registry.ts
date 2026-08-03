/**
 * MCP tool registry — the full set of tools an external MCP client may use,
 * filtered to the connector's granted capabilities.
 *
 * Two execution classes are exposed:
 *   - server-resolved tools (`site_list_documents` + `site_read_styles` +
 *     `studio_import_project`, a thin adapter over the Phase 7B GitHub import
 *     engine) run in-process and work with NO editor open;
 *   - browser tools (structure edits, HTML/CSS authoring, design tokens, page
 *     lifecycle, code assets, live-DOM reads) are relayed to the connector
 *     owner's open Site workspace via the live editor bridge
 *     (`./editorBridge`). If that workspace is not connected, the call
 *     returns a clear scope-specific error.
 *
 * The editor's live store is the single source of truth: ALL page editing goes
 * through it (browser tools). There is deliberately no headless DB-mutating
 * page-tree tool — that created a second surface with identical node ids that
 * desynced from the open editor and got clobbered by its autosave.
 *
 * Capability filtering reuses the SAME gate the built-in agent uses
 * (`toolAllowedForCapabilities`): a connector without `ai.tools.write` never
 * sees a mutating tool, and a tool's `requiredCapabilities` (ANY-OF) must be
 * held. An MCP caller can never invoke a tool the granting capabilities
 * couldn't authorize over HTTP.
 */
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../runtime/types'
import { toolAllowedForCapabilities } from '../tools/capabilityGate'
import { siteTools } from '../tools/site'
import { styleMcpTools } from './tools/styleTools'
import { contextMcpTools } from './tools/contextTool'
import { documentMcpTools } from './tools/documentTools'
import { createPublishMcpTool, type McpPublishRuntime } from './tools/publishTool'
import { studioImportMcpTools } from './tools/studioImportTool'
import { studioMcpTools } from './tools/studio'
import { studioAgentTools } from '../tools/studio'
import { mcpServerMcpTools } from './tools/mcpServerTool'

// Server-resolved site read tools whose handlers read the browser-posted
// `ctx.snapshot`, which is null over MCP — they'd return nothing or throw.
// Each is handled one of two ways:
//   - `site_list_tokens` → excluded; `site_read_styles` (headless) replaces it.
//   - `site_list_breakpoints` → shadowed by a headless version in `styleMcpTools`.
//   - `site_list_documents` → shadowed by a headless version in `documentMcpTools`
//     (the snapshot-based one throws on `null.currentDocument`).
// The headless tool sets are ordered ahead of `siteTools` below, so they win
// the de-dup for any shared name.
const MCP_EXCLUDED_TOOLS = new Set<string>(['site_list_tokens'])

function allMcpTools(runtime?: McpPublishRuntime): AiTool[] {
  // De-dup by tool name. Order matters: the headless MCP-specific + content
  // tools win over the site toolset for shared names, so the version that works
  // without an open editor is the one exposed.
  const ordered = [
    ...contextMcpTools,
    ...styleMcpTools,
    ...documentMcpTools,
    ...studioImportMcpTools,
    ...studioMcpTools,
    ...mcpServerMcpTools,
    createPublishMcpTool(runtime),
    ...siteTools,
  ]
  const byName = new Map<string, AiTool>()
  for (const tool of ordered) {
    if (MCP_EXCLUDED_TOOLS.has(tool.name)) continue
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  return [...byName.values()]
}

export function mcpToolsForCapabilities(
  capabilities: readonly CoreCapability[],
  runtime?: McpPublishRuntime,
): AiTool[] {
  return allMcpTools(runtime).filter((t) => toolAllowedForCapabilities(t, capabilities))
}

/**
 * The toolset for a connector BOUND to a Studio project
 * (`connectorWorkspace.ts`) — in practice, the per-turn connector the
 * `claudeCli` driver mints for the in-canvas agent.
 *
 * A bound connector is editing a React repository on disk, with native file
 * tools in hand. It has no use for the CMS `site_*`/`data.rows`/publish
 * toolset, which describes a different product half entirely
 * (`CLAUDE.md`'s "the dormant CMS half"), and offering it is not neutral: the
 * definitions are re-sent every turn, and a model choosing among ~60 tools
 * explores instead of acting. It gets `studioAgentTools` and nothing else —
 * the deliberate subset, composed in `../tools/studio/index.ts`.
 *
 * An UNBOUND connector (a plain external MCP client — Claude Code in a
 * terminal, a remote agent) still sees the full registry above, including the
 * AST edit tools it genuinely needs because it has no filesystem access to the
 * project. Same tool objects, two compositions.
 */
export function mcpToolsForStudioWorkspace(capabilities: readonly CoreCapability[]): AiTool[] {
  return studioAgentTools.filter((t) => toolAllowedForCapabilities(t, capabilities))
}
