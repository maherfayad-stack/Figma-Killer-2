/**
 * Workspace bridge stream — `GET /admin/api/ai/editor-bridge?scope=site&dir=…`.
 *
 * The Site editor opens an NDJSON stream so MCP browser tools are relayed to
 * it (see `../editorBridge.ts`). Authenticated by the admin session; each
 * bridge is registered under the session user + scope, so it can only serve
 * that user's own MCP connectors. Results flow back through the existing
 * `POST /admin/api/ai/tool-result` endpoint.
 *
 * W10 — the registered scope is `site:${projectKey}`, so two tabs on two
 * projects are two bridges. The client sends the project DIR and the server
 * derives the key (`editorBridgeScope`): the key is a server-side fact about
 * a validated path, and a client that could name its own key could name
 * another project's.
 *
 * `dir` is validated by `resolveValidatedWorkspaceDir` — the same check
 * `chat.ts` puts every `workspaceDir` through. A dir that fails it (or is
 * absent, i.e. no project open yet) yields no bridge at all rather than a
 * bridge on a guessed project: a stream registered under the wrong scope is
 * worse than no stream, because tool calls would silently reach the wrong
 * editor. The client simply retries once a project is open.
 */
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { jsonResponse } from '../../../http'
import {
  requireAuthenticatedUser,
  userHasCapability,
} from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { resolveValidatedWorkspaceDir } from '../../../handlers/studio/workspaceDir'
import {
  createEditorBridgeStream,
  editorBridgeScope,
  type EditorBridgeScope,
} from '../editorBridge'

const PATH = '/admin/api/ai/editor-bridge'
/** The workspace KIND. The project half of the scope comes from `dir`, never from the client's own spelling of a key. */
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

  const params = new URL(req.url).searchParams
  const scopeResult = safeParseValue(EditorBridgeScopeSchema, params.get('scope'))
  if (!scopeResult.ok) {
    return jsonResponse(
      { error: 'Query parameter `scope` is required (one of: site)' },
      { status: 400 },
    )
  }

  const projectDir = resolveValidatedWorkspaceDir(params.get('dir'))
  if (!projectDir) {
    return jsonResponse(
      { error: 'Query parameter `dir` is required and must name an open Studio project.' },
      { status: 400 },
    )
  }
  const scope: EditorBridgeScope = editorBridgeScope(projectDir)

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
