/**
 * Workspace bridge stream — `GET /admin/api/ai/editor-bridge?scope=…`.
 *
 * The Site editor opens an NDJSON stream so MCP browser tools are relayed to
 * it (see `../editorBridge.ts`). Authenticated by the admin session; each
 * bridge is registered under the session user + scope, so it can only serve
 * that user's own MCP connectors. Results flow back through the existing
 * `POST /admin/api/ai/tool-result` endpoint.
 */
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { jsonResponse } from '../../../http'
import {
  requireAuthenticatedUser,
  userHasCapability,
} from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import {
  createEditorBridgeStream,
  type EditorBridgeScope,
} from '../editorBridge'

const PATH = '/admin/api/ai/editor-bridge'
const EditorBridgeScopeSchema = Type.Union([
  Type.Literal('site'),
])

export function tryHandleAiEditorBridge(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== PATH) return null
  return handle(req, db)
}

async function handle(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  const userOrResponse = await requireAuthenticatedUser(req, db)
  if (userOrResponse instanceof Response) return userOrResponse

  const scopeResult = safeParseValue(
    EditorBridgeScopeSchema,
    new URL(req.url).searchParams.get('scope'),
  )
  if (!scopeResult.ok) {
    return jsonResponse(
      { error: 'Query parameter `scope` is required (one of: site)' },
      { status: 400 },
    )
  }
  const scope: EditorBridgeScope = scopeResult.value

  // Hosting a bridge requires access to the workspace whose live state the
  // browser tool will read or mutate.
  if (!userHasCapability(userOrResponse, 'site.read')) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const stream = createEditorBridgeStream(userOrResponse.id, scope, req.signal)
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
