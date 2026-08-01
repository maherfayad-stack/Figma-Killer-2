/**
 * GET/POST /admin/api/ai/studio-session — WS-12 §5.1's per-project
 * persistence for reasoning effort (`.studio/meta.json`'s `agentSession`).
 *
 * Lives under `server/ai/handlers/` (not `server/handlers/studio/`, where
 * `trustTier.ts`'s equivalent route lives) specifically so it can be wired
 * into `server/ai/handlers/index.ts` (this agent's own file) without
 * touching `server/handlers/studio.ts`'s sub-router array, which a parallel
 * session owns this round. The underlying storage (`.studio/meta.json` via
 * `mergeStudioMeta`/`readStudioMeta`) is the SAME file `trustTier.ts` reads
 * and writes — this route only owns the ONE additive field, `agentSession`.
 *
 * `mode` (`--permission-mode`) is deliberately NEVER accepted by this route
 * — see `AgentSessionSchema`'s own doc comment for why Bypass's "never
 * persists" guard rail requires there be nowhere to write it at all.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { resolveProjectDir } from '../../handlers/studioProjects'
import { mergeStudioMeta, readStudioMeta } from '../../handlers/studio/studioMeta'

const ROUTE_PATH = '/admin/api/ai/studio-session'

const EffortSchema = Type.Union([
  Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
])

const PostBodySchema = Type.Object({
  dir: Type.String({ minLength: 1 }),
  effort: Type.Union([EffortSchema, Type.Null()]),
})

export function tryHandleAiStudioAgentSession(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== ROUTE_PATH) return null
  return handleStudioAgentSession(req, db)
}

async function handleStudioAgentSession(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  if (req.method === 'GET') {
    const url = new URL(req.url)
    const dirParam = url.searchParams.get('dir')
    if (!dirParam) return badRequest('missing dir')
    const dir = resolveProjectDir(dirParam)
    const effort = readStudioMeta(dir).agentSession?.effort ?? null
    return jsonResponse({ effort })
  }

  if (req.method === 'POST') {
    const body = await readValidatedBody(req, PostBodySchema)
    if (!body) return badRequest('invalid studio-session body')
    const dir = resolveProjectDir(body.dir)
    const meta = mergeStudioMeta(dir, {
      agentSession: body.effort ? { effort: body.effort } : {},
    })
    return jsonResponse({ effort: meta.agentSession?.effort ?? null })
  }

  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}
