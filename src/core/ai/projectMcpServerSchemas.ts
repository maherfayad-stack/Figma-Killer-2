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

export const McpServerAuthProbeResultSchema = Type.Object({
  requiresAuth: Type.Boolean(),
  authorizationUrl: Type.Union([Type.String(), Type.Null()]),
})
export type McpServerAuthProbeResultWire = Static<typeof McpServerAuthProbeResultSchema>

export const CheckMcpServerAuthBodySchema = Type.Object({
  url: Type.String({ minLength: 1 }),
})
export type CheckMcpServerAuthBody = Static<typeof CheckMcpServerAuthBodySchema>
