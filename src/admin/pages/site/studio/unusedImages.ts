/**
 * unusedImages — the browser half of IMG-11 (`server/handlers/studio/
 * assetPrune.ts`): which images Studio added that nothing references any
 * more, and the explicit delete the user confirms.
 *
 * A thin client: the server decides what is unused — and decides it AGAIN at
 * delete time — so nothing here filters, trusts or remembers a list.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioWorkspaceDir'

const UnusedImagesReportSchema = Type.Object({
  unused: Type.Array(Type.Object({ relPath: Type.String(), bytes: Type.Number() })),
  /** True when the server could not scan the whole project; nothing is offered then. */
  incomplete: Type.Boolean(),
})
export type UnusedImagesReport = Static<typeof UnusedImagesReportSchema>

const PruneResultSchema = Type.Object({
  deleted: Type.Array(Type.String()),
  kept: Type.Array(Type.Object({ relPath: Type.String(), reason: Type.String() })),
})
export type PruneResult = Static<typeof PruneResultSchema>

export function fetchUnusedImages(): Promise<UnusedImagesReport> {
  return apiRequest('/admin/api/studio/asset-ledger', {
    query: { dir: studioWriteDir() ?? undefined },
    schema: UnusedImagesReportSchema,
  })
}

/** Delete exactly `relPaths` — each one re-checked by the server first. Throws `ApiError` on a refusal. */
export function pruneUnusedImages(relPaths: readonly string[]): Promise<PruneResult> {
  const dir = studioWriteDir()
  return apiRequest('/admin/api/studio/asset-prune', {
    method: 'POST',
    body: { relPaths, ...(dir ? { dir } : {}) },
    schema: PruneResultSchema,
  })
}
