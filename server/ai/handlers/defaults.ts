/**
 * Studio's AI default handler.
 *
 *   GET    /admin/api/ai/defaults      Returns `{ default }` — the current
 *                                       { credentialId, modelId }, or null.
 *   PUT    /admin/api/ai/defaults      Body: { credentialId, modelId }
 *   DELETE /admin/api/ai/defaults      Clears the default.
 */

import { Type } from '@core/utils/typeboxHelpers'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import { clearDefault, getDefault, setDefault } from '../defaults/store'

const PutBodySchema = Type.Object({
  credentialId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
})

export function tryHandleAiDefaults(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== '/admin/api/ai/defaults') return null
  if (req.method === 'GET') return handleGet(req, db)
  if (req.method === 'PUT') return handleSet(req, db)
  if (req.method === 'DELETE') return handleClear(req, db)
  return Promise.resolve(jsonResponse({ error: 'Method not allowed' }, { status: 405 }))
}

async function handleGet(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const record = await getDefault(db)
  return jsonResponse({
    default: record ? { credentialId: record.credentialId, modelId: record.modelId } : null,
  })
}

async function handleSet(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, PutBodySchema)
  if (!body) return badRequest('Invalid request body.')
  const { credentialId, modelId } = body

  try {
    const record = await setDefault(db, credentialId, modelId, userOrResponse.id)
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.default.updated',
      targetType: 'ai_default',
      targetId: 'default',
      metadata: { credentialId, modelId },
    })
    return jsonResponse({ default: record })
  } catch (err) {
    // FK violation when credentialId doesn't exist or belongs to a
    // different user; surface as 400.
    const message = err instanceof Error ? err.message : 'Failed to set default.'
    if (message.toLowerCase().includes('foreign key') || message.toLowerCase().includes('23503')) {
      return jsonResponse(
        { error: 'Credential not found. Pick an existing credential.' },
        { status: 400 },
      )
    }
    console.error('[ai/defaults] set failed:', err)
    return jsonResponse({ error: 'Failed to set default.' }, { status: 500 })
  }
}

async function handleClear(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  await clearDefault(db)
  await createAuditEvent(db, {
    actorUserId: userOrResponse.id,
    action: 'ai.default.cleared',
    targetType: 'ai_default',
    targetId: 'default',
    metadata: {},
  })
  return new Response(null, { status: 204 })
}
