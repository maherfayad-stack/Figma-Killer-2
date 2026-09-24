/**
 * The Agent panel's "what did this turn change, and take it back" routes
 * (AI-7) — over `server/handlers/studio/agentCheckpoints.ts`.
 *
 *   GET  /admin/api/ai/agent-checkpoints?dir=&conversationId=
 *        → { turns: [{ turnId, startedAtMs, files: [...] }] }
 *   GET  /admin/api/ai/agent-checkpoints/diff?dir=&turnId=&path=
 *        → { path, diff, added, removed } — a unified diff
 *   POST /admin/api/ai/agent-checkpoints/revert { dir, conversationId, turnId, paths? }
 *        → { reverted: [...] } | 409 { error, code, files }
 *
 * ## Who may do what
 *
 * Reading a checkpoint is reading one's own conversation: `ai.chat`, and the
 * conversation must be the caller's. Reverting WRITES the project's files, so
 * it also takes `studio.write` — exactly what a canvas save takes. The store
 * is per account (`studioAgentUserKey`), so a caller only ever sees and
 * reverts turns of their own; a turn id from someone else's conversation is
 * simply not found. The dir is validated by `resolveValidatedWorkspaceDir`
 * (a real project inside `studio-workspace/`, links resolved), and must be the
 * project the conversation is stamped with.
 *
 * A revert is refused (409) while the conversation still has a turn
 * streaming: that turn may be writing the very files being put back.
 *
 * Lives under `server/ai/handlers/` beside `studioAgentSession.ts` for the
 * same reason that route does: it belongs to the agent, and the Studio route
 * table (`routeCapabilities.ts`) is for the editor's own surface.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { readConversationForUser } from '../conversations/store'
import { projectKeyForValidatedDir } from '../conversations/projectScope'
import { isConversationStreaming } from '../conversations/activeStreams'
import { resolveValidatedWorkspaceDir } from '../../handlers/studio/workspaceDir'
import { studioAgentUserKey } from '../../handlers/studio/agentUserScope'
import {
  isCheckpointTurnId,
  listAgentCheckpointTurns,
  readAgentCheckpointDiff,
  revertAgentCheckpoint,
} from '../../handlers/studio/agentCheckpoints'
import { pushStudioDiskChange } from '../mcp/tools/studio/liveReloadPush'

const BASE = '/admin/api/ai/agent-checkpoints'

/** Longest path the revert body may name — the agent file tools' own cap. */
const PATH_MAX_CHARS = 1024

const RevertBodySchema = Type.Object({
  dir: Type.String({ minLength: 1, maxLength: 4096 }),
  conversationId: Type.String({ minLength: 1, maxLength: 128 }),
  turnId: Type.String({ minLength: 1, maxLength: 64 }),
  /** Omit to revert the whole turn (all-or-nothing); name files for a per-file revert. */
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: PATH_MAX_CHARS }), { minItems: 1, maxItems: 200 })),
})

export function tryHandleAiAgentCheckpoints(req: Request, db: DbClient, url: URL, pathname: string): Promise<Response> | null {
  if (pathname === BASE && req.method === 'GET') return handleList(req, db, url)
  if (pathname === `${BASE}/diff` && req.method === 'GET') return handleDiff(req, db, url)
  if (pathname === `${BASE}/revert` && req.method === 'POST') return handleRevert(req, db)
  if (pathname === BASE || pathname.startsWith(`${BASE}/`)) {
    return Promise.resolve(jsonResponse({ error: 'Method not allowed' }, { status: 405 }))
  }
  return null
}

/** The validated project dir, or the response that refuses it. */
function projectDir(raw: string | null): string | Response {
  const dir = resolveValidatedWorkspaceDir(raw)
  return dir ?? badRequest('That is not an open Studio project.')
}

/** The caller's conversation, stamped with this project (or not stamped yet), or the response that refuses it. */
async function ownConversation(db: DbClient, userId: string, conversationId: string, dir: string): Promise<Response | null> {
  const conversation = await readConversationForUser(db, userId, conversationId)
  if (!conversation) return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
  if (conversation.projectKey && conversation.projectKey !== projectKeyForValidatedDir(dir)) {
    return jsonResponse({ error: 'This conversation belongs to a different project.' }, { status: 409 })
  }
  return null
}

async function handleList(req: Request, db: DbClient, url: URL): Promise<Response> {
  const user = await requireCapability(req, db, 'ai.chat')
  if (user instanceof Response) return user
  const conversationId = url.searchParams.get('conversationId')
  if (!conversationId) return badRequest('missing conversationId')
  const dir = projectDir(url.searchParams.get('dir'))
  if (dir instanceof Response) return dir
  const refusal = await ownConversation(db, user.id, conversationId, dir)
  if (refusal) return refusal
  return jsonResponse({ turns: listAgentCheckpointTurns(dir, studioAgentUserKey(user.id), conversationId) })
}

async function handleDiff(req: Request, db: DbClient, url: URL): Promise<Response> {
  const user = await requireCapability(req, db, 'ai.chat')
  if (user instanceof Response) return user
  const turnId = url.searchParams.get('turnId') ?? ''
  const path = url.searchParams.get('path') ?? ''
  if (!isCheckpointTurnId(turnId) || path.length === 0 || path.length > PATH_MAX_CHARS) return badRequest('invalid turnId or path')
  const dir = projectDir(url.searchParams.get('dir'))
  if (dir instanceof Response) return dir
  const diff = readAgentCheckpointDiff(dir, studioAgentUserKey(user.id), turnId, path)
  if (!diff.ok) return jsonResponse({ error: diff.message, code: diff.code }, { status: diff.code === 'not-found' ? 404 : 422 })
  return jsonResponse({ path: diff.path, diff: diff.diff, added: diff.added, removed: diff.removed })
}

async function handleRevert(req: Request, db: DbClient): Promise<Response> {
  const chatUser = await requireCapability(req, db, 'ai.chat')
  if (chatUser instanceof Response) return chatUser
  // A revert writes the project's files — the same capability a canvas save takes.
  const user = await requireCapability(req, db, 'studio.write')
  if (user instanceof Response) return user
  const body = await readValidatedBody(req, RevertBodySchema)
  if (!body) return badRequest('invalid revert body')
  if (!isCheckpointTurnId(body.turnId)) return badRequest('invalid turnId')
  const dir = projectDir(body.dir)
  if (dir instanceof Response) return dir
  const refusal = await ownConversation(db, user.id, body.conversationId, dir)
  if (refusal) return refusal
  if (isConversationStreaming(body.conversationId)) {
    return jsonResponse({ error: 'The assistant is still working in this conversation. Wait for the turn to finish, then revert.', code: 'turn-running' }, { status: 409 })
  }

  const outcome = await revertAgentCheckpoint(dir, studioAgentUserKey(user.id), body.turnId, body.paths)
  if (!outcome.ok) {
    return jsonResponse({ error: outcome.message, code: outcome.code, files: outcome.files }, { status: outcome.code === 'not-found' ? 404 : 409 })
  }
  // Inside the project write lock the watcher takes the revert for Studio's
  // own write, so the open tabs are told directly.
  pushStudioDiskChange(dir, outcome.reverted)
  return jsonResponse({ reverted: outcome.reverted })
}
