/**
 * Project-declared MCP servers — the ones a repo lists in its own `.mcp.json`.
 *
 * Studio spawns the `claude` CLI with `--strict-mcp-config`, which makes it
 * ignore every MCP config on the machine except the one Studio hands it. That
 * flag is load-bearing and stays: without it the CLI merges the user's
 * `~/.claude.json` and the project's `.mcp.json` and connects to whatever it
 * finds (WS-11 §4.0 trap #4). It also, measured, protects the turn from a
 * third-party server with an invalid tool schema, which fails the whole
 * request with `400 input_schema does not support oneOf/allOf/anyOf`.
 *
 * But strictness had a real cost. Projects ship MCP servers precisely because
 * their knowledge is too large to read: the Almosafer design system bundles one
 * whose README says it exists so Claude can "call `list_components` then pull
 * only the components it needs, instead of ingesting all 37 up front". With the
 * flag and no merge, the agent could not reach it — so it fell back to reading
 * the package's 103 KB `CLAUDE.md`, blew the 25k-token read limit five times in
 * a single turn, and shipped a screen that used 2 of the 42 available
 * components and hand-rolled a nav, a divider and three cards that already
 * existed.
 *
 * So: keep the flag, and merge in project servers the user has EXPLICITLY
 * approved by name (`.studio/meta.json`'s `approvedMcpServers`).
 *
 * ## Why approval is per-name and opt-in
 *
 * A `.mcp.json` entry is a command line. `{"command":"node","args":["evil.js"]}`
 * in a cloned repo is arbitrary code execution the moment Studio opens the
 * project. Cloning a repo must never be enough to run its code, so:
 *
 *   - nothing is approved by default, and an absent list means none;
 *   - approval is stored in `.studio/meta.json` (Studio's state), NOT in
 *     `.mcp.json` (which the repo controls) — otherwise a project could
 *     approve itself;
 *   - approval names a server, so adding a new entry to `.mcp.json` later
 *     does not inherit consent from one already granted.
 */
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { readStudioMeta } from '../../handlers/studio/studioMeta'

/**
 * The two transports the CLI understands. Deliberately permissive about extra
 * fields — this is the project's file in the CLI's format, not ours, and a
 * server carrying a key we don't model is passed through untouched rather than
 * rejected.
 */
const StdioServerSchema = Type.Object({
  command: Type.String(),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
}, { additionalProperties: true })

const HttpServerSchema = Type.Object({
  type: Type.Union([Type.Literal('http'), Type.Literal('sse')]),
  url: Type.String(),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
}, { additionalProperties: true })

const ProjectMcpConfigSchema = Type.Object({
  mcpServers: Type.Optional(
    Type.Record(Type.String(), Type.Union([HttpServerSchema, StdioServerSchema])),
  ),
}, { additionalProperties: true })

export type ProjectMcpServerDefinition = Static<typeof StdioServerSchema> | Static<typeof HttpServerSchema>

export interface ProjectMcpServer {
  readonly name: string
  readonly definition: ProjectMcpServerDefinition
  /** True when the user has approved this exact name for this project. */
  readonly approved: boolean
  /** One-line, human-readable summary for an approval prompt — a command line or a URL. */
  readonly summary: string
}

/** Studio's own server key in the generated config; a project may not shadow it. */
const RESERVED_SERVER_NAME = 'studio'

function projectMcpConfigPath(dir: string): string {
  return join(dir, '.mcp.json')
}

/**
 * Every server the project declares, each flagged with whether it is approved.
 * Drives both the merge below and (in future) an approval UI. Never throws —
 * a missing, unreadable, or malformed `.mcp.json` is simply "no servers", not
 * a broken turn.
 */
export function listProjectMcpServers(dir: string): ProjectMcpServer[] {
  const file = projectMcpConfigPath(dir)
  if (!existsSync(file)) return []

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    console.error('[ai/projectMcpServers] could not read .mcp.json:', err)
    return []
  }

  const config = parseJsonWithFallback(raw, ProjectMcpConfigSchema, {})
  const declared = config.mcpServers ?? {}
  const approvedNames = new Set(readStudioMeta(dir).approvedMcpServers ?? [])

  const servers: ProjectMcpServer[] = []
  for (const [name, definition] of Object.entries(declared)) {
    // Studio's own entry is injected by the driver and carries this turn's
    // connector token. A project entry named `studio` would overwrite it and
    // silently redirect every Studio tool call.
    if (name === RESERVED_SERVER_NAME) {
      console.warn(`[ai/projectMcpServers] ignoring project MCP server named "${RESERVED_SERVER_NAME}" — that name is reserved by Studio.`)
      continue
    }
    servers.push({
      name,
      definition,
      approved: approvedNames.has(name),
      summary: describeServer(definition),
    })
  }
  return servers
}

/**
 * The approved subset, shaped for merging straight into the generated
 * `--mcp-config`. Returns `{}` when nothing is approved, which is the default.
 */
export function approvedProjectMcpServers(dir: string): Record<string, ProjectMcpServerDefinition> {
  const approved: Record<string, ProjectMcpServerDefinition> = {}
  for (const server of listProjectMcpServers(dir)) {
    if (server.approved) approved[server.name] = server.definition
  }
  return approved
}

/** What an approval prompt shows the user, so consent is informed rather than a yes/no on a name. */
function describeServer(definition: ProjectMcpServerDefinition): string {
  if ('url' in definition) return `${definition.type.toUpperCase()} ${definition.url}`
  const args = definition.args?.length ? ` ${definition.args.join(' ')}` : ''
  return `runs: ${definition.command}${args}`
}
