/**
 * GET/POST /admin/api/ai/studio-session — WS-12 §5.1's per-project
 * persistence for reasoning effort, and W9-2's for fidelity mode
 * (`.studio/meta.json`'s `agentSession`).
 *
 * Lives under `server/ai/handlers/` (not `server/handlers/studio/`, where
 * `trustTier.ts`'s equivalent route lives) specifically so it can be wired
 * into `server/ai/handlers/index.ts` (this agent's own file) without
 * touching `server/handlers/studio.ts`'s sub-router array, which a parallel
 * session owns this round. The underlying storage (`.studio/meta.json` via
 * `mergeStudioMeta`/`readStudioMeta`) is the SAME file `trustTier.ts` reads
 * and writes — this route only owns the ONE additive field, `agentSession`.
 *
 * Fidelity mode joined it in W9-2 and is safe here for the reason the next
 * paragraph's control is not: the direction a missing value resolves in is
 * "measure by the derived default", never "silently loosen a gate the user
 * tightened". Nothing about it widens what the agent may do.
 *
 * `mode` (`--permission-mode`) is deliberately NEVER accepted by this route
 * — see `AgentSessionSchema`'s own doc comment for why Bypass's "never
 * persists" guard rail requires there be nowhere to write it at all.
 *
 * W10 — the value is stored per (project, ACCOUNT): the route reads and
 * writes `agentSession.byUser[<studioAgentUserKey>]`, falling back to the
 * pre-`byUser` project-wide value for an account that has never saved one.
 * Effort is a preference about how a person likes to work, and two people in
 * one project were overwriting each other's on every change.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { resolveProjectDir } from '../../handlers/studioProjects'
import {
  mergeStudioMeta,
  readAgentSessionEffort,
  readAgentSessionFidelityMode,
  readStudioMeta,
  withAgentSessionControls,
} from '../../handlers/studio/studioMeta'
import { FIDELITY_MODES } from '../../handlers/studio/fidelityMode'
import { studioAgentUserKey } from '../../handlers/studio/agentUserScope'

const ROUTE_PATH = '/admin/api/ai/studio-session'

const EffortSchema = Type.Union([
  Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
])

const FidelityModeSchema = Type.Union(FIDELITY_MODES.map((m) => Type.Literal(m)))

/**
 * Both controls are OPTIONAL and nullable, and the distinction is load-bearing:
 * omitted leaves that control alone, `null` clears it. The two pickers save
 * independently, so a fidelity-mode save that carried no `effort` would
 * otherwise wipe the effort this account chose.
 */
const PostBodySchema = Type.Object({
  dir: Type.String({ minLength: 1 }),
  effort: Type.Optional(Type.Union([EffortSchema, Type.Null()])),
  fidelityMode: Type.Optional(Type.Union([FidelityModeSchema, Type.Null()])),
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

  const userKey = studioAgentUserKey(userOrResponse.id)

  if (req.method === 'GET') {
    const url = new URL(req.url)
    const dirParam = url.searchParams.get('dir')
    if (!dirParam) return badRequest('missing dir')
    const dir = resolveProjectDir(dirParam)
    const meta = readStudioMeta(dir)
    return jsonResponse({
      effort: readAgentSessionEffort(meta, userKey),
      fidelityMode: readAgentSessionFidelityMode(meta, userKey),
    })
  }

  if (req.method === 'POST') {
    const body = await readValidatedBody(req, PostBodySchema)
    if (!body) return badRequest('invalid studio-session body')
    const dir = resolveProjectDir(body.dir)
    // Read-modify-write of the whole `agentSession` object, because
    // `mergeStudioMeta` merges one level deep — patching `byUser` directly
    // would drop every other account's entry.
    const meta = mergeStudioMeta(dir, {
      agentSession: withAgentSessionControls(readStudioMeta(dir), userKey, {
        ...('effort' in body ? { effort: body.effort ?? null } : {}),
        ...('fidelityMode' in body ? { fidelityMode: body.fidelityMode ?? null } : {}),
      }),
    })
    return jsonResponse({
      effort: readAgentSessionEffort(meta, userKey),
      fidelityMode: readAgentSessionFidelityMode(meta, userKey),
    })
  }

  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}
