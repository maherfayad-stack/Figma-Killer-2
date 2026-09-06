/**
 * `/admin/api/studio/shares` — the editor side of share links.
 *
 *   GET    ?dir=<abs>
 *       Every share this project has minted, newest first, revoked ones
 *       included (see `shareStore.ts` for why revoked records are kept).
 *
 *   POST   body: { dir?, boardId?, token? }
 *       Photograph a board and publish it at a URL. With no `token`, a new
 *       share is minted; with one, that share's snapshot is REPLACED in place
 *       so an existing link updates rather than a second link appearing. This
 *       is the slow route in the file — it drives a real headless render of
 *       every frame on the board — and the client shows a loading state for
 *       exactly that reason.
 *
 *   DELETE ?dir=<abs>&token=<token>
 *       Revoke. Stamps the record and deletes the snapshot bytes; the very
 *       next public request for that token 404s.
 *
 * ## Why this needs a session and the public routes do not
 *
 * Same reason `commentsRoutes.ts` requires one: these routes act on behalf of
 * somebody. Creating a share publishes a project's designs to anyone holding
 * a URL, and revoking one takes that away — neither is an anonymous act. The
 * capture the POST drives also runs `on behalf of` a user id, which is what
 * lets it fall back to that user's open editor tab when no headless browser
 * is available. So this module, like the comments pair, is called outside
 * `STUDIO_SUB_ROUTERS` because it needs the `DbClient` the uniform
 * `(req, url, pathname)` signature does not carry.
 *
 * Any authenticated role may manage shares. Sharing is the reviewer-facing
 * half of the product; gating it above the role that does the design work
 * would defeat the point.
 */
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireAuthenticatedUser } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { Type } from '@core/utils/typeboxHelpers'
import {
  isShareTokenShape,
  SHARE_ROUTE_PREFIX,
  STUDIO_SHARES_ROUTE,
  type ShareMutationResponse,
} from '@core/studio-share'
import { resolveProjectDir } from '../studioProjects'
import { findBoard, writeShareSnapshot } from './shareSnapshot'
import {
  findShareRecord,
  listShareSummaries,
  mintShareToken,
  revokeShareRecord,
  toShareSummary,
  upsertShareRecord,
  type ShareRecord,
} from './shareStore'

const SharePostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  /** Which board to photograph. Omitted means the project's first board. */
  boardId: Type.Optional(Type.String()),
  /** Present to RE-capture an existing share in place instead of minting a new one. */
  token: Type.Optional(Type.String()),
})

export async function tryServeStudioShares(
  req: Request,
  runtime: { db: DbClient },
  url: URL,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== STUDIO_SHARES_ROUTE) return null

  const user = await requireAuthenticatedUser(req, runtime.db)
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      return jsonResponse({ dir, shares: listShareSummaries(dir) })
    } catch (err) {
      console.error('[studio-shares]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, SharePostBodySchema)
      if (!body) return badRequest('invalid shares body')
      const dir = resolveProjectDir(body.dir)
      return await createOrUpdateShare(dir, user.id, body.boardId, body.token)
    } catch (err) {
      console.error('[studio-shares]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const token = url.searchParams.get('token') ?? ''
      if (!isShareTokenShape(token)) return badRequest('invalid share token')
      const revoked = revokeShareRecord(dir, token, new Date().toISOString())
      if (!revoked) return jsonResponse({ error: 'No such share in this project.' }, { status: 404 })
      return jsonResponse({ ok: true, shares: listShareSummaries(dir) })
    } catch (err) {
      console.error('[studio-shares]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}

/**
 * The POST body of work. Order matters: the snapshot is written FIRST and the
 * registry record only afterwards, so a capture that fails leaves no record
 * behind and therefore no link that resolves to an empty directory.
 *
 * For an update, the existing record's `createdAt` is preserved — "this link
 * has existed since Tuesday" stays true even after Thursday's re-capture,
 * which is what `snapshotAt` is separately for.
 */
async function createOrUpdateShare(
  dir: string,
  userId: string,
  boardId: string | undefined,
  token: string | undefined,
): Promise<Response> {
  let existing: ShareRecord | null = null
  if (token !== undefined) {
    if (!isShareTokenShape(token)) return badRequest('invalid share token')
    existing = findShareRecord(dir, token)
    if (!existing) return jsonResponse({ error: 'No such share in this project.' }, { status: 404 })
    if (existing.revokedAt) {
      return jsonResponse(
        { error: 'This share was revoked. Revocation is permanent — create a new share instead.' },
        { status: 409 },
      )
    }
  }

  const board = findBoard(dir, existing?.boardId ?? boardId)
  if (!board) {
    return jsonResponse(
      { error: 'This project has no board to share yet. Open it in Studio and add a screen first.' },
      { status: 404 },
    )
  }

  const shareToken = existing?.token ?? mintShareToken()
  const result = await writeShareSnapshot({ dir, token: shareToken, board, userId })
  if (!result.ok) return jsonResponse({ error: result.error }, { status: 502 })

  const record: ShareRecord = {
    token: shareToken,
    boardId: board.id,
    boardName: board.name,
    createdAt: existing?.createdAt ?? result.snapshot.sharedAt,
    snapshotAt: result.snapshot.sharedAt,
    frameCount: result.snapshot.frames.length,
  }
  upsertShareRecord(dir, record)

  const payload: ShareMutationResponse = {
    dir,
    share: toShareSummary(record),
    url: `${SHARE_ROUTE_PREFIX}${shareToken}`,
    shares: listShareSummaries(dir),
  }
  return jsonResponse(payload)
}
