/**
 * agentRosterMcpTools — the fix for the structural blocker that made naming
 * ANY external MCP tool in a generated subagent throw and silently degrade
 * the whole turn to "no subagents at all".
 *
 * ## The blocker
 *
 * `assertKnownTools` (formerly inline in `agentRoster.ts`) threw on any tool
 * name not present in `studioAgentTools` — Studio's own native tool
 * registry. That is correct for Studio's own tools, but it means a subagent
 * could never be given an approved PROJECT MCP server's tool (e.g. a Figma
 * MCP server the user approved in Settings → AI → MCP Servers) — every such
 * name is, by construction, absent from `studioAgentTools`. Naming one in a
 * roster definition threw inside `generateStudioAgentRoster`'s try/catch,
 * which is caught and silently degrades the WHOLE turn to zero subagents —
 * so this wasn't just "that one agent is unavailable," it made writing a
 * Figma-capable specialist impossible without breaking every other subagent
 * too.
 *
 * ## What "vetted" means here
 *
 * The CLI exposes an external MCP server's tools to a subagent's `tools:`
 * frontmatter as `mcp__<server>__<tool>` (confirmed via this driver's own
 * `--permission-prompt-tool mcp__studio__permission_request` wiring —
 * `claudeCli.ts`). Naively accepting ANY string matching that shape would
 * let a roster entry name a tool from a server the PROJECT has never
 * approved — the exact hole `projectMcpServers.ts`/`registeredMcpServers.ts`
 * exist to close for the main agent. So "vetted" here means tied to what is
 * ACTUALLY approved for THIS project, checked the same two ways the CLI
 * itself receives an approved server: `.mcp.json` names in `.studio/
 * meta.json`'s `approvedMcpServers`, and Studio-registered servers in its
 * `approvedRegisteredMcpServers`. `resolveApprovedMcpServerNames` reads
 * exactly those two lists — the SAME functions (`listProjectMcpServers`/
 * `listRegisteredMcpServers`) `claudeCli.ts` itself calls to decide what
 * reaches the CLI's `--mcp-config` at all — never a broader guess.
 *
 * This is checked per-SERVER, not per-tool: `mcp__figma__anything` is vetted
 * once "figma" is approved, without this generator needing to know the
 * server's actual tool names (it has no live connection to that server —
 * generation happens synchronously, before the CLI ever spawns). That is not
 * a weaker guarantee than per-tool vetting: the main agent's own
 * `--mcp-config` merge (`claudeCli.ts`'s `buildMcpConfig`) is ALSO scoped at
 * server granularity, not tool granularity — once "figma" is approved, the
 * main agent can already call every tool that server exposes, unrestricted
 * by `--tools` (`resolveNativeToolAllowlist` only ever bounds the CLI's
 * native BUILT-INS — Task/Read — never an MCP-sourced tool name). A subagent
 * naming one or two specific tools from an approved server therefore still
 * satisfies "hold no tool the main agent itself does not have" — it is
 * always a STRICT SUBSET of what the main agent can already reach on that
 * server, never a wider grant.
 *
 * What this explicitly does NOT do: verify the named tool actually exists on
 * the connected server (impossible without a live MCP handshake at
 * generation time), or widen access to an unapproved server under any
 * spelling. An entry naming `mcp__<unapproved>__anything` still throws here,
 * exactly like an unknown native tool name always has.
 */
import { studioAgentTools } from '../../ai/tools/studio'
import { listProjectMcpServers } from '../../ai/drivers/projectMcpServers'
import { listRegisteredMcpServers } from '../../ai/drivers/registeredMcpServers'
import type { StudioAgentDef } from './agentRosterTypes'

const NATIVE_TOOL_NAMES = new Set(studioAgentTools.map((t) => t.name))

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

/** `mcp__<server>__<tool>` where `<server>` is one of `approvedServers` and `<tool>` is non-empty. Matched by literal prefix against each REAL approved name, never a generic regex — a server name may itself contain underscores, so there is no ambiguity-free way to split `mcp__a_b__c` into (server, tool) without already knowing which names are real. */
function isVettedMcpToolName(name: string, approvedServers: ReadonlySet<string>): boolean {
  for (const server of approvedServers) {
    const prefix = `mcp__${server}__`
    if (name.startsWith(prefix) && name.length > prefix.length) return true
  }
  return false
}

/**
 * The single gate every generated `StudioAgentDef`'s `tools` list passes
 * through. Throws — same as before this fix — for a name that is neither a
 * real `studioAgentTools` entry nor a vetted `mcp__<approved-server>__<tool>`
 * name for THIS project.
 */
export function assertKnownAgentTools(def: StudioAgentDef, approvedMcpServers: ReadonlySet<string>): StudioAgentDef {
  for (const name of def.tools) {
    if (NATIVE_TOOL_NAMES.has(name)) continue
    if (isVettedMcpToolName(name, approvedMcpServers)) continue
    throw new Error(
      `[agentRoster] "${def.name}" names an unknown tool "${name}" — not in studioAgentTools, and not a vetted mcp__<approved-server>__<tool> name for this project.`,
    )
  }
  return def
}

/**
 * A cheap, stable witness of every approved-server fact the roster's OUTPUT
 * depends on (which subagents get an `mcp__*` grant at all, and the Figma
 * reference/subagent's very presence) — folded into `computeRosterFingerprint`
 * (`agentRosterManifest.ts`) so approving, revoking, or renaming a project
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
