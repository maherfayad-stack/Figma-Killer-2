/**
 * MCP tool registry — the full set of tools an external MCP client may use,
 * filtered to the connector's granted capabilities.
 *
 * Three execution classes are exposed — one `AiTool.execution` value each,
 * defined and read through `../runtime/toolExecution.ts`:
 *   - `server` tools (`site_list_documents` + `site_read_styles` +
 *     `studio_import_project`, a thin adapter over the Phase 7B GitHub import
 *     engine) run in-process and work with NO editor open;
 *   - `server-with-bridge-fallback` tools (the visual-audit family —
 *     `studio_screenshot`, `studio_compare`, `studio_computed_styles`,
 *     `studio_export_frames`) also run in-process, headless, and reach for an
 *     open board only when the headless browser cannot run or when the caller
 *     explicitly wants the live tab's own unsaved state. They never REQUIRE
 *     a board;
 *   - `bridge` tools (structure edits, HTML/CSS authoring, design tokens,
 *     page lifecycle, code assets, live-frame reads) need the connector owner's open Site workspace via the
 *     live editor bridge (`./editorBridge`). If that workspace is not
 *     connected, the call returns a clear scope-specific error.
 *
 * That third class — and only that third class — is what the Studio system
 * prompt's "these tools need the open board" sentence is generated from, so
 * the prompt cannot describe a tool's requirement differently from the way it
 * is dispatched.
 *
 * The editor's live store is the single source of truth: ALL page editing goes
 * through it (`bridge` tools). There is deliberately no headless DB-mutating
 * page-tree tool — that created a second surface with identical node ids that
 * desynced from the open editor and got clobbered by its autosave.
 *
 * Capability filtering reuses the SAME gate the built-in agent uses
 * (`toolAllowedForCapabilities`): a connector without `ai.tools.write` never
 * sees a `requiresWrite` tool, and a tool's `requiredCapabilities` (ANY-OF)
 * must be held. An MCP caller can never invoke a tool the granting capabilities
 * couldn't authorize over HTTP.
 *
 * ## Why no CMS `site_*` WRITE tool is in this catalog
 *
 * See {@link CMS_SITE_WRITE_TOOLS_WITHHELD}. Every one of them is a `bridge`
 * tool, and every editor bridge scope is `site:<projectKey>` — a Studio
 * project on disk. There is no workspace on this fork for a CMS page-tree
 * write to land in honestly.
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

/**
 * The CMS `site_*` WRITE tools, withheld from every MCP connector.
 *
 * Derived from `siteTools` rather than spelled out, so a tool renamed or
 * added in `../tools/site/writeTools.ts` cannot re-enter this catalog by
 * escaping a hand-maintained name list. `sideEffects === 'write'` is the
 * exact predicate: `site/index.ts` stamps it, and the seven browser-backed
 * READS that live in `writeTools.ts` for bridge-dispatch reasons are stamped
 * `'none'` there — so `site_read_document`, `site_get_node_html`,
 * `site_render_snapshot` and their siblings are unaffected. `site_publish` is not in `siteTools` at all
 * (it is `createPublishMcpTool`, server-resolved and separately gated by
 * `pages.publish`), so it is unaffected too.
 *
 * ## Why they cannot work here, not merely why they are unwanted
 *
 * Every tool in this set is `execution: 'bridge'` — it has no server handler
 * and is relayed to the connector owner's open workspace. The only thing that
 * ever registers a workspace is the Studio editor (`SitePage.tsx` →
 * `useMcpWorkspaceBridge`), which registers under
 * `editorBridgeScope(studioProjectDir)` — an `EditorBridgeScope`, whose type
 * IS `` `site:${string}` ``. So the only tree an MCP write can ever reach is a
 * studio-imported one, whose source of truth is `.tsx` on disk:
 *
 *   - `site_insert_html` / `site_replace_node_html` already REFUSE there by
 *     name (`HTML_IMPORT_ON_SOURCE_REFUSAL`, `store-13`): an HTML fragment has
 *     no honest single source form, and half of it is a `<style>` block that
 *     targets a stylesheet rather than the `.tsx`.
 *   - `site_add_page` / `site_duplicate_page` / `site_delete_page` /
 *     `site_rename_page` and the two template verbs address `data_rows`
 *     pages, which no file in the user's repository describes.
 *   - the node verbs and the token/code-asset writers address CMS state whose
 *     Studio counterpart lives in the repo or in `.studio/`.
 *
 * The replacements are in this same catalog: `studio_apply_edits` and
 * `studio_codemod` write real JSX and return addressable node ids,
 * `studio_create_page` scaffolds a real route file, `studio_upload_asset`
 * lands a real file. An external client has no filesystem access to the
 * project, which is exactly why those tools stay here while the in-canvas
 * agent's own subset (`mcpToolsForStudioWorkspace`) drops them.
 *
 * This is the same conclusion `mcpToolsForStudioWorkspace` already reached for
 * a BOUND connector, applied one step wider — and strictly narrower than that
 * rule, which drops the CMS reads and publish as well.
 */
export const CMS_SITE_WRITE_TOOLS_WITHHELD: ReadonlySet<string> = new Set(
  siteTools.filter((tool) => tool.sideEffects === 'write').map((tool) => tool.name),
)

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
    if (CMS_SITE_WRITE_TOOLS_WITHHELD.has(tool.name)) continue
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
