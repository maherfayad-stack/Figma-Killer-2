/**
 * projectMcpApprovals — which external MCP servers a project has actually
 * approved, and a cheap witness of that fact for the generated-file
 * regeneration fingerprint (`projectGuideManifest.ts`).
 *
 * ## What "approved" means here
 *
 * Two independent approval lists, both read exactly as `claudeCli.ts` itself
 * reads them when deciding what reaches the CLI's `--mcp-config` at all:
 * `.mcp.json` server names approved in `.studio/meta.json`'s
 * `approvedMcpServers`, and Studio-registered servers in its
 * `approvedRegisteredMcpServers`. Never a broader guess — an unapproved
 * server is invisible to the agent, and this module is one of the places that
 * stays true.
 *
 * Approval is per-SERVER, not per-tool, matching `buildMcpConfig`'s own
 * granularity: once a server is approved, the agent can call every tool it
 * exposes. `resolveNativeToolAllowlist` only ever bounds the CLI's native
 * BUILT-INS, never an MCP-sourced tool name.
 *
 * This module previously also gated a generated subagent roster's `tools:`
 * frontmatter (`assertKnownAgentTools`). That roster is gone — the CLI does
 * not error on an unknown `subagent_type`, it silently substitutes its own
 * `general-purpose` agent and reports success it cannot back up, so `Task`
 * was removed from the session's tool surface entirely
 * (`claudeCliToolSurface.ts`) and what the roster carried now lives in the
 * project's generated `CLAUDE.md` (`projectGuide.ts`). With no subagent
 * definitions left to validate, the gate had nothing to gate.
 */
import { listProjectMcpServers } from '../../ai/drivers/projectMcpServers'
import { listRegisteredMcpServers } from '../../ai/drivers/registeredMcpServers'

/**
 * Every MCP server name this project has approved, from EITHER approval
 * list — `.mcp.json` entries approved by name, and Studio-registered
 * servers approved separately. Both `listProjectMcpServers`/
 * `listRegisteredMcpServers` already refuse the reserved name `studio`
 * (Studio's own entry) at the SOURCE, so it can never appear here — no
 * separate exclusion needed, and Studio's own tools are vetted through
 * `NATIVE_TOOL_NAMES` regardless. Never throws — both source functions
 * degrade a missing/malformed config to `[]` on their own.
 */
export function resolveApprovedMcpServerNames(dir: string): Set<string> {
  const names = new Set<string>()
  for (const server of listProjectMcpServers(dir)) {
    if (server.approved) names.add(server.name)
  }
  for (const server of listRegisteredMcpServers(dir)) {
    if (server.approved) names.add(server.name)
  }
  return names
}

/**
 * A cheap, stable witness of every approved-server fact the generated project
 * guide's OUTPUT depends on — folded into `computeProjectGuideFingerprint`
 * (`projectGuideManifest.ts`) so approving, revoking, or renaming a project
 * MCP server forces a full regeneration instead of silently going stale
 * behind the fast (unchanged-fingerprint) path. Never includes a secret
 * value — `summary` on both source types is already a non-secret,
 * human-readable command line or URL, the same field the Settings UI shows
 * for an approval prompt.
 */
export function mcpServerFingerprintWitness(dir: string): string {
  const project = listProjectMcpServers(dir)
    .map((s) => `${s.name}:${s.approved}:${s.summary}`)
    .sort()
  const registered = listRegisteredMcpServers(dir)
    .map((s) => `${s.name}:${s.approved}:${s.summary}`)
    .sort()
  return JSON.stringify({ project, registered })
}
