/**
 * Project MCP server registry + approval — `/admin/api/ai/mcp/project-servers[/:name[/approve|/revoke]]`.
 *
 *   GET    /admin/api/ai/mcp/project-servers?dir=<abs>
 *     -> `{ servers: ProjectMcpServerView[] }` — every server the project
 *        either declares itself (`.mcp.json`) or has registered directly in
 *        Studio, each with its transport summary and approval state. Never
 *        a secret value — `secretFieldsSet` reports PRESENCE only.
 *   POST   /admin/api/ai/mcp/project-servers { dir, name, definition, secrets? }
 *     -> registers (or redefines) a Studio-owned server. `secrets`, when
 *        present, is encrypted and stored via `mcpServerSecretStore.ts` —
 *        this is the ONE path in the whole feature that may carry a secret
 *        value, and it is a human-initiated HTTP call gated by
 *        `ai.providers.manage`, never something the agent tool can reach.
 *   DELETE /admin/api/ai/mcp/project-servers/:name?dir=<abs>
 *     -> removes a Studio-registered server's definition, approval, and
 *        every stored secret field for it.
 *   POST   /admin/api/ai/mcp/project-servers/:name/approve { dir, source }
 *   POST   /admin/api/ai/mcp/project-servers/:name/revoke  { dir, source }
 *     -> the human consent action `projectMcpServers.ts` names as
 *        "(in future) an approval UI" for project-declared servers, and the
 *        equivalent for Studio-registered ones. `source` picks which
 *        approval list ('project' -> `.mcp.json`-declared, 'registered' ->
 *        Studio-registered) so a name shared between the two can never be
 *        approved on the wrong list.
 *   POST   /admin/api/ai/mcp/project-servers/check-auth { url }
 *     -> best-effort OAuth-discovery probe (`authProbe.ts`) for an http/sse
 *        server URL — surfaces whatever authorization link the server itself
 *        hands back, never one Studio invents. See that module's doc comment
 *        for why Studio never attempts the OAuth flow itself.
 *
 * Every route is gated by `ai.providers.manage` — the same capability that
 * already governs the MCP Connectors tab (managing MCP integrations, inbound
 * or outbound, is the same admin surface) — and every `dir` is
 * containment-checked against `projectsRootDir()`, the same posture
 * `trustTier.ts` uses for its own project-scoped GET/POST pair.
 */
import {
  AddRegisteredMcpServerBodySchema,
  CheckMcpServerAuthBodySchema,
  SetMcpServerApprovalBodySchema,
  type ProjectMcpServerView,
} from '@core/ai'
import { badRequest, jsonResponse, readValidatedBody } from '../../../http'
import { requireCapability } from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { projectsRootDir, resolveProjectDir } from '../../../handlers/studioProjects'
import { isRealpathContained } from '../../../handlers/studio/workspacePackageResolve'
import { listProjectMcpServers, approveProjectMcpServer, revokeProjectMcpServer } from '../../drivers/projectMcpServers'
import {
  listRegisteredMcpServers,
  addRegisteredMcpServer,
  removeRegisteredMcpServer,
  approveRegisteredMcpServer,
  revokeRegisteredMcpServer,
  registeredMcpServerProjectKey,
  ReservedMcpServerNameError,
} from '../../drivers/registeredMcpServers'
import { hasMcpServerSecret, setMcpServerSecret } from '../../credentials/mcpServerSecretStore'
import { probeMcpServerAuthorization } from '../authProbe'

const BASE = '/admin/api/ai/mcp/project-servers'
const CHECK_AUTH_PATH = `${BASE}/check-auth`

export function tryHandleAiMcpProjectServers(
  req: Request,
  db: DbClient,
  url: URL,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null
  return handle(req, db, url, pathname)
}

function resolveContainedDir(dirParam: string | null): { ok: true; dir: string } | { ok: false; response: Response } {
  const dir = resolveProjectDir(dirParam)
  if (!isRealpathContained(dir, projectsRootDir())) {
    return { ok: false, response: new Response('Not found', { status: 404 }) }
  }
  return { ok: true, dir }
}

async function handle(req: Request, db: DbClient, url: URL, pathname: string): Promise<Response> {
  if (pathname === CHECK_AUTH_PATH) {
    if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
    return handleCheckAuth(req, db)
  }

  if (pathname === BASE) {
    if (req.method === 'GET') return handleList(req, db, url)
    if (req.method === 'POST') return handleAdd(req, db)
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  const rest = pathname.slice(`${BASE}/`.length)
  const approveMatch = rest.match(/^(.+)\/approve$/)
  const revokeMatch = rest.match(/^(.+)\/revoke$/)
  if (approveMatch && req.method === 'POST') {
    return handleSetApproval(req, db, decodeURIComponent(approveMatch[1]!), true)
  }
  if (revokeMatch && req.method === 'POST') {
    return handleSetApproval(req, db, decodeURIComponent(revokeMatch[1]!), false)
  }
  if (req.method === 'DELETE') {
    return handleRemove(req, db, url, decodeURIComponent(rest))
  }
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleList(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const resolved = resolveContainedDir(url.searchParams.get('dir'))
  if (!resolved.ok) return resolved.response

  const projectServers: ProjectMcpServerView[] = listProjectMcpServers(resolved.dir).map((s) => ({
    name: s.name,
    source: 'project',
    approved: s.approved,
    summary: s.summary,
  }))

  const projectKey = registeredMcpServerProjectKey(resolved.dir)
  const registeredServers: ProjectMcpServerView[] = listRegisteredMcpServers(resolved.dir).map((s) => ({
    name: s.name,
    source: 'registered',
    approved: s.approved,
    summary: s.summary,
    secretFieldNames: [...s.secretFieldNames],
    secretFieldsSet: s.secretFieldNames.filter((field) =>
      hasMcpServerSecret(userOrResponse.id, projectKey, s.name, field),
    ),
  }))

  return jsonResponse({ servers: [...projectServers, ...registeredServers] })
}

async function handleAdd(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, AddRegisteredMcpServerBodySchema)
  if (!body) return badRequest('Invalid request body.')

  const resolved = resolveContainedDir(body.dir ?? null)
  if (!resolved.ok) return resolved.response

  try {
    addRegisteredMcpServer(resolved.dir, { name: body.name, definition: body.definition })
  } catch (err) {
    if (err instanceof ReservedMcpServerNameError) {
      return jsonResponse({ error: err.message }, { status: 400 })
    }
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }

  if (body.secrets) {
    const projectKey = registeredMcpServerProjectKey(resolved.dir)
    for (const [fieldName, value] of Object.entries(body.secrets)) {
      if (value.length === 0) continue
      await setMcpServerSecret(userOrResponse.id, projectKey, body.name, fieldName, value)
    }
  }

  return jsonResponse({ ok: true, name: body.name }, { status: 201 })
}

async function handleRemove(req: Request, db: DbClient, url: URL, name: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const resolved = resolveContainedDir(url.searchParams.get('dir'))
  if (!resolved.ok) return resolved.response

  removeRegisteredMcpServer(userOrResponse.id, resolved.dir, name)
  return jsonResponse({ ok: true })
}

async function handleSetApproval(req: Request, db: DbClient, name: string, approve: boolean): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, SetMcpServerApprovalBodySchema)
  if (!body) return badRequest('Invalid request body.')

  const resolved = resolveContainedDir(body.dir ?? null)
  if (!resolved.ok) return resolved.response

  if (body.source === 'project') {
    if (approve) approveProjectMcpServer(resolved.dir, name)
    else revokeProjectMcpServer(resolved.dir, name)
  } else {
    if (approve) approveRegisteredMcpServer(resolved.dir, name)
    else revokeRegisteredMcpServer(resolved.dir, name)
  }

  return jsonResponse({ ok: true, name, approved: approve })
}

async function handleCheckAuth(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, CheckMcpServerAuthBodySchema)
  if (!body) return badRequest('Invalid request body.')

  const result = await probeMcpServerAuthorization(body.url)
  return jsonResponse(result)
}
