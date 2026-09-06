/**
 * shareLinks — the browser half of `/admin/api/studio/shares`.
 *
 * Four calls, all through `apiRequest` with a TypeBox schema, all targeting
 * whichever project `studioWriteDir()` says is active — the same resolution
 * every other studio client call uses, so a share can never be minted against
 * a project other than the one on screen.
 *
 * The absolute URL a user copies is built HERE rather than server-side. The
 * server returns an origin-relative path because it does not reliably know
 * the origin a browser reached it on (dev proxies, tunnels, reverse proxies
 * with a different published host); the browser knows exactly, and it is the
 * browser's clipboard the link is going to.
 */
import { apiRequest } from '@core/http'
import {
  ShareListResponseSchema,
  ShareMutationResponseSchema,
  ShareRevokeResponseSchema,
  STUDIO_SHARES_ROUTE,
  type ShareSummary,
} from '@core/studio-share'
import { studioWriteDir } from './studioWorkspaceDir'

export async function listShares(signal?: AbortSignal): Promise<ShareSummary[]> {
  const response = await apiRequest(STUDIO_SHARES_ROUTE, {
    schema: ShareListResponseSchema,
    query: { dir: studioWriteDir() ?? undefined },
    ...(signal ? { signal } : {}),
  })
  return response.shares
}

export interface ShareMutationResult {
  share: ShareSummary
  /** Absolute, ready to paste — see the module doc for why the origin is added here. */
  url: string
  shares: ShareSummary[]
}

/**
 * Photograph the board and publish it. Pass `token` to re-capture an EXISTING
 * share in place (the link stays the same, the pictures change); omit it to
 * mint a new one.
 *
 * Slow by nature: this drives a real headless render of every frame on the
 * board. Callers must show a loading state.
 */
export async function createShare(boardId: string | null, token?: string): Promise<ShareMutationResult> {
  const response = await apiRequest(STUDIO_SHARES_ROUTE, {
    method: 'POST',
    schema: ShareMutationResponseSchema,
    body: {
      dir: studioWriteDir() ?? undefined,
      ...(boardId ? { boardId } : {}),
      ...(token ? { token } : {}),
    },
  })
  return { share: response.share, url: absoluteShareUrl(response.url), shares: response.shares }
}

export async function revokeShare(token: string): Promise<ShareSummary[]> {
  const response = await apiRequest(STUDIO_SHARES_ROUTE, {
    method: 'DELETE',
    schema: ShareRevokeResponseSchema,
    query: { dir: studioWriteDir() ?? undefined, token },
  })
  return response.shares
}

/** The link a viewer opens, on the origin this browser is actually talking to. */
export function absoluteShareUrl(path: string): string {
  return new URL(path, window.location.origin).toString()
}
