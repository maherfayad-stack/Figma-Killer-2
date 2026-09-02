/**
 * Agent-facing MCP-server tools — orientation (list) and a PROPOSE-ONLY write.
 *
 * `mcp_propose_server` is deliberately the only mutating tool here, and it is
 * structurally incapable of the three things that would defeat
 * `projectMcpServers.ts`'s entire consent model:
 *
 *   1. It cannot APPROVE the server it proposes. Its handler calls ONLY
 *      `addRegisteredMcpServer` — never `approveRegisteredMcpServer` (or
 *      `revokeRegisteredMcpServer`, or the project-declared equivalents in
 *      `projectMcpServers.ts`). `addRegisteredMcpServer` itself has no
 *      parameter that could grant approval; there is no code path here that
 *      even IMPORTS the approve/revoke functions.
 *   2. It cannot SUPPLY a secret value. Its input schema is exactly
 *      `RegisteredMcpServerDefinitionSchema` — the same one
 *      `.studio/meta.json` persists — which carries only `secretEnvVarNames`
 *      / `secretHeaderNames` (field NAMES a human must later fill in via the
 *      Settings UI), never a `secretValue`-shaped field. This module never
 *      imports `mcpServerSecretStore.ts` at all.
 *   3. Redefining an already-approved name via this tool still cannot
 *      preserve trust — `addRegisteredMcpServer` itself revokes any prior
 *      approval whenever a name's definition changes (see that function's
 *      own doc comment), so even a same-name "re-propose" cannot smuggle a
 *      changed command past a human who approved the old one.
 *
 * Approval is a human action taken in Settings → AI → MCP Servers
 * (`../handlers/registeredServers.ts`), the same posture
 * `projectMcpServers.ts` already established for `.mcp.json` entries: an
 * agent proposing a server is exactly as consequential as a repo declaring
 * one in `.mcp.json` — informative, never self-authorizing.
 *
 * `mcpServerTool.test.ts` proves this boundary two ways: behaviourally (even
 * a crafted input carrying extra `approved`/`secretValue`-shaped keys has zero
 * effect on the persisted state) and structurally (this file's own source
 * never references an approve/revoke/secret-setting symbol).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { AiTool } from '../../runtime/types'
import { resolveProjectDir } from '../../../handlers/studioProjects'
import { listProjectMcpServers } from '../../drivers/projectMcpServers'
import {
  listRegisteredMcpServers,
  addRegisteredMcpServer,
  ReservedMcpServerNameError,
} from '../../drivers/registeredMcpServers'
import { RegisteredMcpServerDefinitionSchema } from '@core/ai'

// Same convention as every sibling tool in `./studio/projectTools.ts`:
// `resolveProjectDir(dirInput)` is used directly, with no additional
// realpath-containment check here — these tools already sit behind the MCP
// connector's own `studio.write`/capability gate (the caller is an
// authenticated agent turn, not an untrusted browser request), the same
// trust boundary every other `studio_*` tool in this family relies on.

const DirInputSchema = Type.Object({
  dir: Type.Optional(
    Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
  ),
})

// ---------------------------------------------------------------------------
// mcp_list_project_servers — read-only orientation
// ---------------------------------------------------------------------------

const listServersTool: AiTool = {
  name: 'mcp_list_project_servers',
  scope: 'shared',
  execution: 'server',
  description:
    'List every MCP server currently connected or connectable for this project\'s chat turns: both project-declared servers (from the repo\'s own .mcp.json) and Studio-registered servers (added directly in Studio, for servers that need a secret .mcp.json cannot safely hold). Each entry reports its name, transport, a one-line summary of its command line or URL, whether a human has approved it (only approved servers are actually merged into a turn), and — for a registered server — which field names it declares as secret (never the secret VALUES, which this tool never sees). Read-only: reachable by any caller, no approval or secret ever surfaced or changed.',
  inputSchema: DirInputSchema,
  handler: async (input) => {
    const { dir: dirInput } = input as Static<typeof DirInputSchema>
    const dir = resolveProjectDir(dirInput)

    const project = listProjectMcpServers(dir).map((s) => ({
      name: s.name,
      source: 'project' as const,
      approved: s.approved,
      summary: s.summary,
    }))
    const registered = listRegisteredMcpServers(dir).map((s) => ({
      name: s.name,
      source: 'registered' as const,
      approved: s.approved,
      summary: s.summary,
      secretFieldNames: [...s.secretFieldNames],
    }))

    return { ok: true, dir, servers: [...project, ...registered] }
  },
}

// ---------------------------------------------------------------------------
// mcp_propose_server — PROPOSE ONLY, see file doc comment for the boundary
// ---------------------------------------------------------------------------

const ProposeServerInputSchema = Type.Object({
  dir: Type.Optional(
    Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
  ),
  name: Type.String({ minLength: 1, description: 'A short, unique name for this server (cannot be "studio" — reserved).' }),
  definition: RegisteredMcpServerDefinitionSchema,
}, { additionalProperties: false })

const proposeServerTool: AiTool = {
  name: 'mcp_propose_server',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Propose a new MCP server for this project — for example, a design-system or Figma server the user mentioned but that is not already declared in the repo\'s .mcp.json. This registers the NON-secret definition only (transport, command/args/url, non-secret env/headers, and the NAMES of any env var or header whose value is secret) — it is saved as UNAPPROVED and can NEVER be approved, enabled, or given a secret value by this tool or by you. A human must open Settings → AI → MCP Servers, review the exact command line or URL, supply any secret value it needs, and explicitly approve it before it is merged into any chat turn. Do not tell the user the server is "set up" or "ready" — tell them it is proposed and needs their review.',
  inputSchema: ProposeServerInputSchema,
  handler: async (input) => {
    const { dir: dirInput, name, definition } = input as Static<typeof ProposeServerInputSchema>
    const dir = resolveProjectDir(dirInput)

    try {
      addRegisteredMcpServer(dir, { name, definition })
    } catch (err) {
      if (err instanceof ReservedMcpServerNameError) {
        return { ok: false, error: err.message }
      }
      return { ok: false, error: `Could not propose this server: ${err instanceof Error ? err.message : String(err)}` }
    }

    return {
      ok: true,
      name,
      approved: false,
      message:
        'Proposed as an unapproved Studio-registered MCP server. It will NOT be used in any chat turn until a human reviews it and explicitly approves it in Settings → AI → MCP Servers (and supplies any secret value it needs, which you cannot see or set).',
    }
  },
}

export const mcpServerMcpTools: AiTool[] = [listServersTool, proposeServerTool]
