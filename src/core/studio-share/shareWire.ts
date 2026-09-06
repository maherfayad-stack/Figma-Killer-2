/**
 * The wire contract for share links (W5-2) — the read-only board snapshot a
 * logged-out viewer sees at `/share/<token>`.
 *
 * Two audiences read this module, and the split between them is the whole
 * point of the feature:
 *
 *   1. **The public viewer** (`src/admin/shareViewer/`, served to anyone with
 *      the link) reads `SharedBoardSchema`. That shape is deliberately
 *      anaemic: a project name, a board name, a timestamp, and per frame a
 *      display name, a rectangle, and an image filename. There is no page id,
 *      no source path, no node id, no style rule, no framework settings, no
 *      workspace directory — nothing that says anything about the repository
 *      the board was made from. A share is a picture of the work, not a copy
 *      of it, and the schema is where that is enforced rather than promised.
 *   2. **The editor's Share dialog** (`src/admin/pages/site/toolbar/`) reads
 *      `ShareListResponseSchema` over a session-gated admin route. That side
 *      may know about boards and tokens, because it is already inside the
 *      editor.
 *
 * Both halves import this leaf so there is one definition of each shape
 * instead of two that drift — the same reasoning `@core/studio-capture`'s
 * `captureWire.ts` records for the capture payload.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/** The public namespace. Every share URL a viewer ever sees starts here. */
export const SHARE_ROUTE_PREFIX = '/share/'

/**
 * A share token: `shr_` + 43 base64url characters of 32 random bytes (256
 * bits). The regex is not cosmetic — it runs BEFORE a token is ever joined
 * into a filesystem path, so `..`, separators, and NUL can never reach
 * `path.join` in the first place. Containment is still re-checked on the
 * resolved real path (defence in depth), but this is the cheap gate that
 * makes traversal unreachable rather than merely detected.
 */
export const SHARE_TOKEN_RE = /^shr_[A-Za-z0-9_-]{43}$/

export function isShareTokenShape(value: string): boolean {
  return SHARE_TOKEN_RE.test(value)
}

/**
 * A snapshot image filename, as written by the snapshot writer and echoed in
 * `SharedFrame.image`. Same posture as the token: matched before it becomes a
 * path segment. `<snapshotId>-<index>.png`, both machine-generated.
 */
export const SHARE_IMAGE_FILE_RE = /^[a-z0-9]{1,32}-\d{1,4}\.png$/

export function isShareImageFileName(value: string): boolean {
  return SHARE_IMAGE_FILE_RE.test(value)
}

/** The viewer's two data URLs, derived from a token the caller has already shape-checked. */
export function shareBoardJsonPath(token: string): string {
  return `${SHARE_ROUTE_PREFIX}${token}/board.json`
}

export function shareFrameImagePath(token: string, file: string): string {
  return `${SHARE_ROUTE_PREFIX}${token}/frames/${file}`
}

/**
 * One frame in the shared snapshot. `x`/`y`/`width`/`height` are the board
 * coordinates the frame was authored at, so the viewer reproduces the layout
 * the designer arranged rather than a grid of thumbnails.
 *
 * `name` is the page's display title. `image` is a filename, never a URL: the
 * viewer builds the URL from its own token, so a snapshot file can never
 * carry an absolute path or point at another origin.
 */
export const SharedFrameSchema = Type.Object({
  name: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number({ minimum: 1 }),
  height: Type.Number({ minimum: 1 }),
  image: Type.String({ minLength: 1 }),
})

export type SharedFrame = Static<typeof SharedFrameSchema>

/**
 * `board.json` inside a snapshot directory, and the body of
 * `GET /share/<token>/board.json`. The file on disk IS the response body —
 * there is no second projection step where a source path could leak back in.
 */
export const SharedBoardSchema = Type.Object({
  version: Type.Literal(1),
  /** The project's display name (`.studio/meta.json`), not its directory. */
  projectName: Type.String(),
  boardName: Type.String(),
  /** ISO timestamp of the moment the frames were photographed. */
  sharedAt: Type.String(),
  frames: Type.Array(SharedFrameSchema),
})

export type SharedBoard = Static<typeof SharedBoardSchema>

// ---------------------------------------------------------------------------
// Editor-side management surface (session-gated)
// ---------------------------------------------------------------------------

/**
 * One row in the Share dialog. `revokedAt` present means the link is dead;
 * the record is KEPT rather than deleted so the dialog can say "revoked"
 * instead of silently forgetting a link somebody may still be holding.
 */
export const ShareSummarySchema = Type.Object({
  token: Type.String(),
  boardId: Type.String(),
  boardName: Type.String(),
  createdAt: Type.String(),
  /** When the snapshot was last (re)captured — moves when a share is updated, unlike `createdAt`. */
  snapshotAt: Type.String(),
  revokedAt: Type.Optional(Type.String()),
  frameCount: Type.Number(),
})

export type ShareSummary = Static<typeof ShareSummarySchema>

export const ShareListResponseSchema = Type.Object({
  dir: Type.String(),
  shares: Type.Array(ShareSummarySchema),
})

export type ShareListResponse = Static<typeof ShareListResponseSchema>

export const ShareMutationResponseSchema = Type.Object({
  dir: Type.String(),
  share: ShareSummarySchema,
  /** The path a viewer opens — origin-relative, so the client prefixes its own origin. */
  url: Type.String(),
  shares: Type.Array(ShareSummarySchema),
})

export type ShareMutationResponse = Static<typeof ShareMutationResponseSchema>

/** DELETE's body. `shares` is the refreshed list so the dialog never re-fetches to redraw. */
export const ShareRevokeResponseSchema = Type.Object({
  ok: Type.Boolean(),
  shares: Type.Array(ShareSummarySchema),
})

export type ShareRevokeResponse = Static<typeof ShareRevokeResponseSchema>

/** The admin route the Share dialog talks to. */
export const STUDIO_SHARES_ROUTE = '/admin/api/studio/shares'
