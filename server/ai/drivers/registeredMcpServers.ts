/**
 * Studio-registered project MCP servers — servers a user adds directly in
 * Studio for a project, NOT declared in that project's own `.mcp.json`.
 *
 * This exists to close the gap `projectMcpServers.ts` documents: a project's
 * `.mcp.json` entry is passed through verbatim, so a server that needs a
 * secret (a Figma/GitHub token, a bearer header) has nowhere safe to put it —
 * the file is git-tracked, and Studio must never push a user toward
 * committing a credential. Registering a server here instead means:
 *
 *   - the NON-secret definition (name, transport, command/args/url, non-secret
 *     env/headers) lives in `.studio/meta.json`, the exact same "Studio's
 *     state, not the project's" home `approvedMcpServers` already uses;
 *   - any secret field VALUE lives encrypted, outside `studio-workspace/**`
 *     entirely, in `../credentials/mcpServerSecretStore.ts` (see that file's
 *     doc comment for exactly why a DB table was not the answer this round).
 *
 * Consent mirrors `projectMcpServers.ts` exactly: nothing is approved by
 * registering it. `approvedRegisteredMcpServers` in `.studio/meta.json` is a
 * SEPARATE opt-in list from `approvedMcpServers` (project-declared), so a
 * project file and a Studio registration can never collide on approval by
 * sharing a name. Approval is a human action taken in the Settings UI
 * (`registeredServers.ts` HTTP handler) — nothing in this module, and
 * critically nothing the agent-facing MCP tool (`mcpServerTool.ts`) calls,
 * can set it. See that tool's own doc comment for the enforced boundary.
 */
import { relative, resolve } from 'node:path'
import { parseValue } from '@core/utils/typeboxHelpers'
import { RESERVED_SERVER_NAME } from './projectMcpServers'
import type { ProjectMcpServerDefinition } from './projectMcpServers'
import {
  RegisteredMcpServerSchema,
  type RegisteredMcpServerDefinition,
  type RegisteredMcpServerEntry,
} from '@core/ai'
import { mergeStudioMeta, readStudioMeta } from '../../handlers/studio/studioMeta'
import { projectsRootDir } from '../../handlers/studioProjects'
import {
  deleteMcpServerSecrets,
  getMcpServerSecret,
  resolveMcpServerSecretsRoot,
  McpServerSecretKeyMismatchError,
} from '../credentials/mcpServerSecretStore'

export type { RegisteredMcpServerDefinition, RegisteredMcpServerEntry }

export interface RegisteredMcpServer {
  readonly name: string
  readonly definition: RegisteredMcpServerDefinition
  readonly approved: boolean
  /** One-line, human-readable summary — a command line or a URL, same framing `projectMcpServers.ts` uses. */
  readonly summary: string
  /** Field names this definition declares as secret — never the values. Drives the approval UI's "set secret" prompts. */
  readonly secretFieldNames: readonly string[]
}

export class ReservedMcpServerNameError extends Error {
  constructor(name: string) {
    super(`"${name}" is reserved by Studio and cannot be used for a registered MCP server.`)
    this.name = 'ReservedMcpServerNameError'
  }
}

/**
 * The stable, filesystem-and-path-safe key `mcpServerSecretStore.ts` scopes a
 * project's secrets under. Studio projects are immediate subfolders of
 * `studio-workspace/`, so the relative path is normally just the folder name;
 * any character outside the secret store's safe-segment alphabet is mapped to
 * `_` rather than rejected — this function must never throw, since it feeds
 * a fail-soft merge path.
 */
export function registeredMcpServerProjectKey(
  dir: string,
  projectsRoot: string = projectsRootDir(),
): string {
  const rel = relative(resolve(projectsRoot), resolve(dir))
  const safe = rel.replace(/[^A-Za-z0-9._-]/g, '_')
  // Guard the two POSIX traversal special cases explicitly: `.` and `..`
  // consist entirely of characters the sanitizer above already allows (a
  // real project/server name may contain a dot), so they survive it
  // unchanged. `mcpServerSecretStore.ts`'s own `assertSafeSegment` rejects
  // both too — this second guard means a pathological `dir` degrades to a
  // deterministic, harmless key instead of ever reaching that throw.
  if (safe.length === 0 || safe === '.' || safe === '..') return 'root'
  return safe
}

function secretFieldNamesOf(definition: RegisteredMcpServerDefinition): readonly string[] {
  if (definition.transport === 'stdio') return definition.secretEnvVarNames ?? []
  return definition.secretHeaderNames ?? []
}

function describeRegisteredServer(definition: RegisteredMcpServerDefinition): string {
  if (definition.transport === 'stdio') {
    const args = definition.args?.length ? ` ${definition.args.join(' ')}` : ''
    return `runs: ${definition.command}${args}`
  }
  return `${definition.transport.toUpperCase()} ${definition.url}`
}

/** Every server the project has registered in Studio, each flagged with whether it is approved. Never throws — a malformed `.studio/meta.json` degrades to `[]` via `readStudioMeta`'s own fallback. */
export function listRegisteredMcpServers(dir: string): RegisteredMcpServer[] {
  const meta = readStudioMeta(dir)
  const entries = meta.registeredMcpServers ?? []
  const approvedNames = new Set(meta.approvedRegisteredMcpServers ?? [])
  return entries.map((entry) => ({
    name: entry.name,
    definition: entry.definition,
    approved: approvedNames.has(entry.name),
    summary: describeRegisteredServer(entry.definition),
    secretFieldNames: secretFieldNamesOf(entry.definition),
  }))
}

/**
 * Add (or redefine) a registered server's NON-secret definition. Structurally
 * cannot grant approval or accept a secret value — there is no parameter for
 * either. Redefining an EXISTING name revokes any prior approval for it: the
 * definition is the thing that was consented to, so changing it (a different
 * command, a different URL) must not silently keep trust from before —
 * exactly the same "approval names a server, a new entry doesn't inherit
 * consent" posture `projectMcpServers.ts` documents, applied to an update
 * instead of a fresh name.
 */
export function addRegisteredMcpServer(dir: string, entry: RegisteredMcpServerEntry): void {
  if (entry.name === RESERVED_SERVER_NAME) {
    throw new ReservedMcpServerNameError(entry.name)
  }
  // Validate the shape defensively even though callers (the HTTP handler, the
  // agent tool) already validate their own request bodies against this same
  // schema — this function has no other gate of its own. Throws on an
  // invalid shape rather than silently persisting one.
  parseValue(RegisteredMcpServerSchema, entry)

  const meta = readStudioMeta(dir)
  const existing = meta.registeredMcpServers ?? []
  const nextEntries = [...existing.filter((e) => e.name !== entry.name), entry]
  const approved = new Set(meta.approvedRegisteredMcpServers ?? [])
  approved.delete(entry.name)
  mergeStudioMeta(dir, {
    registeredMcpServers: nextEntries,
    approvedRegisteredMcpServers: [...approved],
  })
}

/** Remove a registered server's definition, its approval, and every stored secret field for it — no orphaned ciphertext left behind. `dataRoot` is a test seam — defaults to `resolveMcpServerSecretsRoot()`. */
export function removeRegisteredMcpServer(
  userId: string,
  dir: string,
  name: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
  projectsRoot: string = projectsRootDir(),
): void {
  const meta = readStudioMeta(dir)
  const nextEntries = (meta.registeredMcpServers ?? []).filter((e) => e.name !== name)
  const approved = new Set(meta.approvedRegisteredMcpServers ?? [])
  approved.delete(name)
  mergeStudioMeta(dir, {
    registeredMcpServers: nextEntries,
    approvedRegisteredMcpServers: [...approved],
  })
  deleteMcpServerSecrets(userId, registeredMcpServerProjectKey(dir, projectsRoot), name, dataRoot)
}

/** Grant/revoke consent for one registered server, by name — the human action the Settings UI's Approve/Revoke control performs. Idempotent. */
export function approveRegisteredMcpServer(dir: string, name: string): void {
  const current = new Set(readStudioMeta(dir).approvedRegisteredMcpServers ?? [])
  current.add(name)
  mergeStudioMeta(dir, { approvedRegisteredMcpServers: [...current] })
}

export function revokeRegisteredMcpServer(dir: string, name: string): void {
  const current = new Set(readStudioMeta(dir).approvedRegisteredMcpServers ?? [])
  current.delete(name)
  mergeStudioMeta(dir, { approvedRegisteredMcpServers: [...current] })
}

/**
 * The approved subset, fully resolved with secret values decrypted and
 * injected — shaped for merging straight into `buildMcpConfig`, exactly
 * like `projectMcpServers.ts`'s `approvedProjectMcpServers`. A server whose
 * declared secret field cannot be resolved (never set, or a master-key
 * rotation mismatch) is DROPPED from the result with a logged reason rather
 * than sent half-configured — fail soft, same posture the rest of this
 * driver uses for a degraded turn. `dataRoot` is a test seam — defaults to
 * `resolveMcpServerSecretsRoot()`.
 */
export async function resolvedApprovedRegisteredMcpServers(
  userId: string,
  dir: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
  projectsRoot: string = projectsRootDir(),
): Promise<Record<string, ProjectMcpServerDefinition>> {
  const projectKey = registeredMcpServerProjectKey(dir, projectsRoot)
  const resolved: Record<string, ProjectMcpServerDefinition> = {}

  for (const server of listRegisteredMcpServers(dir)) {
    if (!server.approved) continue
    try {
      resolved[server.name] = await resolveOneDefinition(userId, projectKey, server.name, server.definition, dataRoot)
    } catch (err) {
      console.error(
        `[ai/registeredMcpServers] dropping registered server "${server.name}" from this turn — could not resolve its secret field(s):`,
        err,
      )
    }
  }
  return resolved
}

async function resolveOneDefinition(
  userId: string,
  projectKey: string,
  serverName: string,
  definition: RegisteredMcpServerDefinition,
  dataRoot: string,
): Promise<ProjectMcpServerDefinition> {
  if (definition.transport === 'stdio') {
    const env = { ...(definition.env ?? {}) }
    for (const fieldName of definition.secretEnvVarNames ?? []) {
      env[fieldName] = await requireSecret(userId, projectKey, serverName, fieldName, dataRoot)
    }
    return {
      command: definition.command,
      args: definition.args,
      env: Object.keys(env).length > 0 ? env : undefined,
    }
  }

  const headers = { ...(definition.headers ?? {}) }
  for (const fieldName of definition.secretHeaderNames ?? []) {
    headers[fieldName] = await requireSecret(userId, projectKey, serverName, fieldName, dataRoot)
  }
  return {
    type: definition.transport,
    url: definition.url,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  }
}

async function requireSecret(
  userId: string,
  projectKey: string,
  serverName: string,
  fieldName: string,
  dataRoot: string,
): Promise<string> {
  const value = await getMcpServerSecret(userId, projectKey, serverName, fieldName, dataRoot)
  if (value === null) {
    throw new Error(`secret field "${fieldName}" was never set`)
  }
  return value
}

// Re-exported so callers that only need to recognise the error class don't
// have to reach into `mcpServerSecretStore.ts` directly.
export { McpServerSecretKeyMismatchError }
