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
import { resolveMcpOAuthHeader } from '../credentials/mcpOAuthStore'

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

/**
 * Servers Studio itself ships, present in every project without anyone
 * registering them.
 *
 * Only ONE thing qualifies a definition for this list, and it is checked in
 * code rather than trusted here — see {@link isSelfApprovingBuiltIn}: the
 * server must be reachable ONLY on the loopback interface and must carry no
 * secret of any kind. A loopback URL is not a network service Studio is
 * choosing to trust on the user's behalf; it is a process already running as
 * that same user on that same machine, which they started themselves. There
 * is no credential to leak, no remote party, and nothing a project or a
 * prompt can point somewhere else.
 *
 * `figma` is Figma's REMOTE MCP server. It replaced the desktop app's Dev Mode
 * server at `http://127.0.0.1:3845/mcp`, which used to sit here because it
 * needs no token and therefore self-approved — genuinely zero-config, and
 * genuinely dependent on the user having the desktop app open on the same
 * machine as the Studio server. That is a bad bargain for a hosted Studio and
 * a worse one for a headless turn: the design is in the cloud, the file key is
 * in the URL the user pasted, and requiring a local application to be running
 * to read it is a failure mode with no error message the agent can act on.
 *
 * The remote server is OAuth-only. Its `.well-known/oauth-authorization-
 * server` advertises a DCR `registration_endpoint`, PKCE `S256`,
 * `require_state_parameter`, and `bearer_methods_supported: ["header"]`, and
 * Figma's own docs say in as many words that you sign in through the OAuth
 * flow. There is NO personal-access-token path — an earlier revision of this
 * comment claimed one, reasoning from the endpoint's `Vary: X-Figma-Token`
 * response header. That is Figma's generic API-gateway header, not an MCP auth
 * path: a PAT in either `X-Figma-Token` or `Authorization: Bearer` gets the
 * same 401 as sending no header at all.
 *
 * **Studio cannot perform that OAuth for Figma, and this is an external
 * constraint, not a gap.** Studio has a generic browser OAuth flow
 * (`../credentials/mcpOAuth.ts` + `mcpOAuthStore.ts`), and
 * `resolveOneDefinition` below turns any resulting session into an
 * `Authorization` header — it works for a remote server with open dynamic
 * client registration. Figma is not one: its docs state that "only clients
 * listed in the Figma MCP Catalog like VS Code, Cursor, or Claude Code can
 * connect", and `POST https://api.figma.com/v1/oauth/mcp/register` answers a
 * bare `403 Forbidden` to every body and header combination — a minimal body,
 * an https redirect URI, a public-client registration, a browser user-agent.
 * It is refusing the caller, not validating the request, and there is no
 * request Studio can construct that changes it.
 *
 * The CLI Studio already spawns IS on that catalog. Its MCP credential is
 * scoped to the `CLAUDE_CONFIG_DIR` `claudeCli.ts` sets per user, so a
 * one-time interactive sign-in performed against THAT directory is inherited
 * by every later headless turn. The Settings row prints the exact commands
 * when its own flow is refused; see `McpServersSection.tsx`'s
 * `cliSignInCommands`. Until that sign-in happens, `figma` reaches a turn as a
 * bare URL, connects, registers ZERO tools, and every call comes back `No such
 * tool available: mcp__figma__…` — which is what the `needs-auth` digest
 * status exists to say out loud.
 *
 * Being in this list therefore buys VISIBILITY, not trust:
 * {@link isSelfApprovingBuiltIn} rejects it on the host check (non-loopback),
 * so it is listed in Settings unapproved and a human still turns it on.
 * Nothing about the consent boundary moves — the only thing that changes is
 * that they no longer type the URL themselves.
 *
 * Anyone who wants the desktop app's Dev Mode server instead registers `figma`
 * themselves at `http://127.0.0.1:3845/mcp` — a project's own entry of that
 * name wins over this one (see `listRegisteredMcpServers`), and being
 * loopback-with-no-secret it self-approves.
 *
 * Reachability is NOT checked here. An unapproved or unreachable server is
 * simply dropped for the turn and everything else proceeds — the same
 * fail-soft posture the rest of this module already takes. Probing on every
 * turn would add latency to buy a guess that is stale the moment it is made.
 */
const BUILT_IN_MCP_SERVERS: readonly RegisteredMcpServerEntry[] = [
  {
    name: 'figma',
    definition: { transport: 'http', url: 'https://mcp.figma.com/mcp' },
  },
]

/** Hosts that mean "this machine", and nothing else. IPv4 loopback, IPv6 loopback, and the name that resolves to them. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Whether a built-in may skip the approval prompt.
 *
 * This is the ONE place approval is granted without a human action, so it is
 * written to be impossible to widen by accident:
 *
 *   - `stdio` is rejected outright — a command line is arbitrary code
 *     execution, which is the entire reason approval exists.
 *   - the URL must parse, and its hostname must be loopback. A DNS name that
 *     merely looks local (`localhost.evil.com`) fails, because the check is
 *     set membership on the parsed hostname, not a prefix or suffix test.
 *   - the definition must declare NO secret fields and NO headers. A built-in
 *     that needed a credential would be a built-in that could leak one.
 *
 * User- and agent-registered servers never reach this function; it is applied
 * only to {@link BUILT_IN_MCP_SERVERS} — where, since `figma` moved to the
 * remote endpoint, NO shipped entry passes it. That is the correct outcome,
 * not a reason to relax the test: this stays as the gate any future built-in
 * has to clear, and it is unit-tested directly (both branches) rather than
 * through whatever happens to be in the list today. The invariant in this module's doc
 * comment — that nothing here, and nothing the agent tool calls, can approve
 * a server a human did not — is therefore intact: the agent cannot add to
 * that list, and a definition that would need trusting cannot pass this test.
 */
export function isSelfApprovingBuiltIn(definition: RegisteredMcpServerDefinition): boolean {
  if (definition.transport === 'stdio') return false
  if ((definition.secretHeaderNames?.length ?? 0) > 0) return false
  if (Object.keys(definition.headers ?? {}).length > 0) return false
  let hostname: string
  try {
    hostname = new URL(definition.url).hostname
  } catch {
    return false
  }
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/**
 * Record approval for a SHIPPED BUILT-IN the user has personally signed in to.
 *
 * ## Why a sign-in is the stronger consent, not a shortcut past it
 *
 * Approval exists to answer "may Studio talk to this server on your behalf".
 * For {@link BUILT_IN_MCP_SERVERS} that question is already settled, twice
 * over, by the time this can fire:
 *
 *   - **Without a sign-in the server is inert.** Figma's remote MCP registers
 *     ZERO tools for an unauthenticated client — it cannot read a file, cannot
 *     be sent anything, and cannot act. An unapproved built-in and an
 *     unauthenticated one are the same thing in practice.
 *   - **With a sign-in the user has already consented, to Figma, in Figma's
 *     own OAuth screen**, naming the account and the scope. A checkbox in
 *     Studio asking the same question afterwards is a weaker signal collected
 *     second.
 *
 * The URL is Studio's own and a project cannot change it — a project entry of
 * the same name REPLACES the built-in and then follows the ordinary consent
 * rules (see `listRegisteredMcpServers`). So the blast radius here is exactly:
 * a server Studio ships, at a URL Studio fixed, that the user has personally
 * authenticated. Nothing a project or a prompt can reach.
 *
 * It is PERSISTED rather than computed on the fly, deliberately. The CLI's
 * sign-in state costs a ~10 second health check, so a computed answer would
 * depend on whether a cache happened to be warm — the connector would work on
 * some turns and not others, which is worse than either answer consistently.
 * Writing it once means the turn path reads an ordinary approval.
 *
 * A user who does not want this revokes it in Settings like any other, and
 * `signedIn: false` never revokes anything — signing out of Figma is not a
 * statement about what Studio may connect to.
 */
export function recordBuiltInSignIn(dir: string, name: string, signedIn: boolean): void {
  if (!signedIn) return
  if (!BUILT_IN_MCP_SERVERS.some((b) => b.name === name)) return
  const meta = readStudioMeta(dir)
  // A project that REPLACED this built-in with its own entry, or explicitly
  // disabled it, has made a decision this must not overwrite.
  if ((meta.registeredMcpServers ?? []).some((e) => e.name === name)) return
  if ((meta.disabledBuiltInMcpServers ?? []).includes(name)) return
  if ((meta.approvedRegisteredMcpServers ?? []).includes(name)) return
  approveRegisteredMcpServer(dir, name)
}

/** Every server the project has registered in Studio, each flagged with whether it is approved. Never throws — a malformed `.studio/meta.json` degrades to `[]` via `readStudioMeta`'s own fallback. */
export function listRegisteredMcpServers(dir: string): RegisteredMcpServer[] {
  const meta = readStudioMeta(dir)
  const entries = meta.registeredMcpServers ?? []
  const approvedNames = new Set(meta.approvedRegisteredMcpServers ?? [])
  const disabledBuiltIns = new Set(meta.disabledBuiltInMcpServers ?? [])
  const registeredNames = new Set(entries.map((e) => e.name))

  // Two precedence rules, both deliberately favouring the human:
  //   - a project's OWN entry of the same name wins over the built-in, and
  //     then follows the ordinary consent rules. Registering `figma` yourself
  //     (say, the cloud endpoint with a token) must not silently inherit the
  //     built-in's self-approval, so it is filtered out BEFORE approval is
  //     decided, not merged with it.
  //   - an explicit opt-out wins over everything.
  const builtIns = BUILT_IN_MCP_SERVERS.filter(
    (b) => !registeredNames.has(b.name) && !disabledBuiltIns.has(b.name),
  )

  return [
    ...builtIns.map((entry) => ({
      name: entry.name,
      definition: entry.definition,
      // Self-approving only when the definition genuinely cannot carry a
      // credential and cannot leave this machine — never merely because it
      // is built in. An entry that failed the test would still be listed, so
      // the user can see it and approve it themselves.
      approved: isSelfApprovingBuiltIn(entry.definition) || approvedNames.has(entry.name),
      summary: describeRegisteredServer(entry.definition),
      secretFieldNames: secretFieldNamesOf(entry.definition),
    })),
    ...entries.map((entry) => ({
      name: entry.name,
      definition: entry.definition,
      approved: approvedNames.has(entry.name),
      summary: describeRegisteredServer(entry.definition),
      secretFieldNames: secretFieldNamesOf(entry.definition),
    })),
  ]
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

  // An OAuth session Studio completed in the browser (`credentials/
  // mcpOAuthStore.ts`) becomes the `Authorization` header the CLI's own MCP
  // client sends — `bearer_methods_supported: ["header"]` is exactly how a
  // remote resource expects to be called, so Studio holding the credential
  // and the subprocess spending it is not a workaround, it is the mechanism.
  // Refreshed here if it is expired or nearly so, since this is the last
  // moment before the config file is written.
  //
  // An explicitly-configured header always wins: someone who typed their own
  // `Authorization` into the registration form meant it, and silently
  // overwriting it with a stale browser session would be the worse surprise.
  if (!('Authorization' in headers)) {
    const bearer = await resolveMcpOAuthHeader(
      { userId, projectKey, serverName, dataRoot },
      definition.url,
    )
    if (bearer) headers.Authorization = bearer
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
