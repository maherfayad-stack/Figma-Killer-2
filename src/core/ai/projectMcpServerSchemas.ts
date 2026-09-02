/**
 * Wire schemas for a project's MCP servers — both the ones a repo declares
 * itself (`.mcp.json`) and the ones a user registers directly in Studio for
 * servers that need a secret `.mcp.json` cannot safely hold (see
 * `server/ai/drivers/registeredMcpServers.ts`'s doc comment for the full
 * design). Shared between the server (`server/ai/drivers/*`,
 * `server/ai/mcp/handlers/registeredServers.ts`) and the admin UI
 * (`src/admin/modals/Settings/sections/McpServersSection.tsx`) so a single
 * TypeBox definition validates both sides of the wire — `type Foo =
 * Static<typeof FooSchema>`, never a parallel hand-written interface.
 *
 * `RegisteredMcpServerDefinitionSchema` is the shape PERSISTED in
 * `.studio/meta.json`'s `registeredMcpServers` field — it carries only
 * secret field NAMES (`secretEnvVarNames`/`secretHeaderNames`), never a
 * value. A secret VALUE only ever appears in a request BODY schema below
 * (`AddRegisteredMcpServerBodySchema`'s `secrets` map), on its way to
 * `server/ai/credentials/mcpServerSecretStore.ts` — it is never returned by
 * any response schema here.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Registered server definition — persisted shape (no secret values)
// ---------------------------------------------------------------------------

export const RegisteredStdioDefinitionSchema = Type.Object({
  transport: Type.Literal('stdio'),
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  /** Non-secret environment variables — passed through verbatim. */
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Names of ADDITIONAL env vars whose values are secret and live encrypted in the secret store, keyed by this same name. */
  secretEnvVarNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false })
export type RegisteredStdioDefinition = Static<typeof RegisteredStdioDefinitionSchema>

export const RegisteredHttpDefinitionSchema = Type.Object({
  transport: Type.Union([Type.Literal('http'), Type.Literal('sse')]),
  url: Type.String({ minLength: 1 }),
  /** Non-secret headers — passed through verbatim. */
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Names of ADDITIONAL headers whose values are secret and live encrypted in the secret store, keyed by this same name. */
  secretHeaderNames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false })
export type RegisteredHttpDefinition = Static<typeof RegisteredHttpDefinitionSchema>

export const RegisteredMcpServerDefinitionSchema = Type.Union([
  RegisteredStdioDefinitionSchema,
  RegisteredHttpDefinitionSchema,
])
export type RegisteredMcpServerDefinition = Static<typeof RegisteredMcpServerDefinitionSchema>

export const RegisteredMcpServerSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  definition: RegisteredMcpServerDefinitionSchema,
})
export type RegisteredMcpServerEntry = Static<typeof RegisteredMcpServerSchema>

// ---------------------------------------------------------------------------
// HTTP wire shapes — GET /admin/api/ai/mcp/project-servers and friends
// ---------------------------------------------------------------------------

export const McpServerSourceSchema = Type.Union([Type.Literal('project'), Type.Literal('registered')])
export type McpServerSource = Static<typeof McpServerSourceSchema>

/** One row in the combined list — project-declared and Studio-registered servers share this shape on the wire. Never carries a secret value. */
export const ProjectMcpServerViewSchema = Type.Object({
  name: Type.String(),
  source: McpServerSourceSchema,
  approved: Type.Boolean(),
  summary: Type.String(),
  /** Only present for `source: 'registered'` — the secret field NAMES this definition declares, never values. */
  secretFieldNames: Type.Optional(Type.Array(Type.String())),
  /** Only present for `source: 'registered'` — which of those declared secret fields already have a value stored, so the UI can show "secret set" without ever decrypting it. */
  secretFieldsSet: Type.Optional(Type.Array(Type.String())),
})
export type ProjectMcpServerView = Static<typeof ProjectMcpServerViewSchema>

export const ListProjectMcpServersResultSchema = Type.Object({
  servers: Type.Array(ProjectMcpServerViewSchema),
})
export type ListProjectMcpServersResult = Static<typeof ListProjectMcpServersResultSchema>

/** POST body — register a new Studio-owned MCP server. `secrets` maps a declared secret field name to its plaintext value; sent once, over HTTPS, straight to the encrypted store — never echoed back. */
export const AddRegisteredMcpServerBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  name: Type.String({ minLength: 1 }),
  definition: RegisteredMcpServerDefinitionSchema,
  secrets: Type.Optional(Type.Record(Type.String(), Type.String())),
})
export type AddRegisteredMcpServerBody = Static<typeof AddRegisteredMcpServerBodySchema>

/** POST body — approve/revoke either a project-declared or a Studio-registered server, by name. */
export const SetMcpServerApprovalBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  source: McpServerSourceSchema,
})
export type SetMcpServerApprovalBody = Static<typeof SetMcpServerApprovalBodySchema>


// ---------------------------------------------------------------------------
// OAuth sign-in — POST/GET/DELETE /admin/api/ai/mcp/oauth[/start|/callback]
// ---------------------------------------------------------------------------

/** POST body — begin the browser OAuth flow for one registered http/sse server. Carries no secret: the credential is minted by the authorization server and never passes through the client. */
export const StartMcpOAuthBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  name: Type.String({ minLength: 1 }),
})
export type StartMcpOAuthBody = Static<typeof StartMcpOAuthBodySchema>

/** The authorization URL to send the user's browser to. Studio builds it from the server's OWN published metadata — never a per-vendor hardcoded link. */
export const StartMcpOAuthResultSchema = Type.Object({
  authorizeUrl: Type.String(),
})
export type StartMcpOAuthResult = Static<typeof StartMcpOAuthResultSchema>

/** Whether one server currently holds a usable OAuth session. `expiresAt`/`scope` describe the session; the access token itself is never sent to the client. */
export const McpOAuthStatusSchema = Type.Object({
  /** True when the server's metadata says it needs OAuth at all — a plain unauthenticated http server reports false and shows no sign-in control. */
  supportsOAuth: Type.Boolean(),
  connected: Type.Boolean(),
  expiresAt: Type.Union([Type.Number(), Type.Null()]),
  scope: Type.Union([Type.String(), Type.Null()]),
  /**
   * The `CLAUDE_CONFIG_DIR` a manual CLI sign-in must target, for the servers
   * Studio cannot register with itself.
   *
   * Some providers advertise dynamic client registration but operate a closed
   * allow-list of approved applications — Figma's docs say only clients in its
   * MCP Catalog (Claude Code, VS Code, Cursor) may connect, and its
   * registration endpoint answers a bare 403 to everyone else. Studio is not
   * on that list and cannot get on it by trying harder. The Claude CLI IS, and
   * Studio already spawns it against a per-user config directory, so a
   * one-time sign-in performed THERE is inherited by every later headless
   * turn. This is the path to that.
   *
   * `null` when the host cannot give each user their own CLI config
   * directory, in which case there is no honest instruction to print.
   */
  cliConfigDir: Type.Union([Type.String(), Type.Null()]),
  /**
   * True once this server's authorization server has refused to register
   * Studio as an OAuth client — Figma's closed MCP Catalog allow-list being
   * the case Studio ships.
   *
   * The refusal is a policy answer that no retry changes, so it is recorded
   * the first time it happens and reported here from then on. The panel reads
   * it as "do not offer a sign-in button; offer the CLI route instead", which
   * is what `cliConfigDir` above is for.
   */
  registrationClosed: Type.Boolean(),
})
export type McpOAuthStatus = Static<typeof McpOAuthStatusSchema>

/**
 * What the Claude CLI — not Studio — reports about one server, asked
 * separately because the answer costs a ~10s live health check.
 *
 * `connected` here means the sign-in landed somewhere Studio's own token store
 * cannot see (the CLI keeps MCP credentials in the OS keychain), which is the
 * ONLY possible outcome for a provider whose client allow-list refuses Studio.
 * Reporting it is the difference between a badge that reads "Not signed in"
 * forever while the tools work, and one that tells the truth.
 *
 * `unknown` covers every failure mode — no CLI on PATH, a timeout, output this
 * Studio version cannot parse — and must never be rendered as "not connected".
 */
export const McpCliConnectionSchema = Type.Object({
  state: Type.Union([Type.Literal('connected'), Type.Literal('needs-auth'), Type.Literal('unknown')]),
})
export type McpCliConnection = Static<typeof McpCliConnectionSchema>
