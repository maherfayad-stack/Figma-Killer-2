/**
 * studioTrashRequests — the wire contract for `.studio/trash/`: move a page in,
 * list what is there, restore one, purge.
 *
 * Sibling of `studioPageRequests.ts` (create/delete a page). Kept apart because
 * the trash has its own lifecycle the page routes know nothing about — an entry
 * id, a restore that can conflict, a purge — and because the explorer's Trash
 * section is the only surface that reads most of it.
 *
 * Deliberately no client-side cache. The list is small, only rendered while the
 * Trash section is open, and re-fetching after every change is both simpler and
 * more honest than mirroring server state that another tab (or an agent) can
 * change underneath it.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { studioWriteDir } from './studioSaveRequests'

/** One trashed page, as `pageTrash.ts`'s manifest records it. */
const TrashEntrySchema = Type.Object({
  id: Type.String(),
  pageId: Type.String(),
  title: Type.String(),
  files: Type.Array(Type.String()),
  deletedAt: Type.String(),
})
export type StudioTrashEntry = Static<typeof TrashEntrySchema>

const TrashListResponseSchema = Type.Object({
  ok: Type.Boolean(),
  entries: Type.Array(TrashEntrySchema),
})

const TrashPageResponseSchema = Type.Object({
  ok: Type.Boolean(),
  entry: TrashEntrySchema,
  removedFrames: Type.Number(),
})

const RestoreResponseSchema = Type.Object({
  ok: Type.Boolean(),
  entry: TrashEntrySchema,
})

const PurgeResponseSchema = Type.Object({
  ok: Type.Boolean(),
  purged: Type.Number(),
})

/** Every page currently in the trash, newest first. */
export async function listStudioTrash(signal?: AbortSignal): Promise<StudioTrashEntry[]> {
  const dir = studioWriteDir()
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : ''
  const body = await apiRequest(`/admin/api/studio/trash${query}`, {
    schema: TrashListResponseSchema,
    ...(signal ? { signal } : {}),
  })
  return body.entries
}

/**
 * Move a live page into the trash — its files go under `.studio/trash/`, its
 * board frames go with them, and it disappears from every page list on the
 * next reload.
 *
 * `title` travels with the request so the Trash list can name the page: once
 * the file is under `.studio/` no parser will look at it again, so the server
 * has nothing left to read a title from.
 *
 * Throws `ApiError` on failure (an unknown `pageId` → 404).
 */
export function trashStudioPage(pageId: string, title: string): Promise<Static<typeof TrashPageResponseSchema>> {
  return apiRequest('/admin/api/studio/trash', {
    method: 'POST',
    body: { dir: studioWriteDir(), pageId, title },
    schema: TrashPageResponseSchema,
  })
}

/**
 * Put a trashed page back and re-place its board frame. Throws `ApiError` with
 * status 409 when a path it owns is occupied again — the message names the
 * file, because the fix (rename or remove that file) is the user's to make.
 */
export function restoreStudioTrashEntry(entryId: string): Promise<Static<typeof RestoreResponseSchema>> {
  return apiRequest('/admin/api/studio/trash/restore', {
    method: 'POST',
    body: { dir: studioWriteDir(), entryId },
    schema: RestoreResponseSchema,
  })
}

/** Permanently remove one trashed page, or — with no `entryId` — empty the trash. */
export function purgeStudioTrash(entryId?: string): Promise<Static<typeof PurgeResponseSchema>> {
  return apiRequest('/admin/api/studio/trash', {
    method: 'DELETE',
    body: { dir: studioWriteDir(), ...(entryId ? { entryId } : {}) },
    schema: PurgeResponseSchema,
  })
}
