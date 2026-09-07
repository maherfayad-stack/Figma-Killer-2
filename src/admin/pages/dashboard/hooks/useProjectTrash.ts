/**
 * useProjectTrash — the launcher's view of `studio-workspace/.trash/`.
 *
 * Deleting a project has always MOVED it rather than erased it
 * (`server/handlers/studio/projectTrash.ts`), and until now the only way to
 * get one back was a `mv` in a terminal — which the delete dialog said out
 * loud, as if that were an acceptable recovery story for a design tool. This
 * hook and the three routes behind it are the other half of that promise:
 * the trash is a place in the product, with Restore and Delete forever.
 *
 * Same shape as `useStudioProjects`: the server's listing is the only listing,
 * and every mutation redraws by refetching rather than splicing a local copy.
 * `refresh` is what the launcher calls after a delete, so the "Trash (N)"
 * count is right the moment a project leaves the grid.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { useAsyncResource } from '@admin/lib/useAsyncResource'

/**
 * One trashed project. Mirrors `TrashedProject`
 * (`server/handlers/studio/projectTrash.ts`) — `entry` is the id every write
 * addresses, and it is a bare folder name, never a path.
 */
const TrashedProjectSchema = Type.Object(
  {
    entry: Type.String(),
    name: Type.String(),
    /** The folder name a restore will move it back to — what the collision refusal is about. */
    slug: Type.String(),
    trashedAt: Type.Number(),
    sizeBytes: Type.Number(),
    /** True when the size walk hit its entry cap — the UI must then say "at least", not a total. */
    sizeCapped: Type.Boolean(),
  },
  { additionalProperties: true },
)
export type TrashedProject = Static<typeof TrashedProjectSchema>

const TrashListResponseSchema = Type.Object(
  { projects: Type.Array(TrashedProjectSchema) },
  { additionalProperties: true },
)

const RestoreResponseSchema = Type.Object(
  { project: Type.Object({ dir: Type.String(), name: Type.String() }, { additionalProperties: true }) },
  { additionalProperties: true },
)

export interface ProjectTrashResource {
  /** The trashed projects, newest deletion first, or null before the first successful load. */
  trashed: TrashedProject[] | null
  error: string | null
  /** Re-runs the listing. Stable identity. */
  refresh: () => void
}

export function useProjectTrash(): ProjectTrashResource {
  const resource = useAsyncResource(
    (signal) => apiRequest('/admin/api/studio/trash', { schema: TrashListResponseSchema, signal }),
    [],
    { fallbackError: 'Could not load the trash' },
  )
  return {
    trashed: resource.data?.projects ?? null,
    error: resource.error,
    refresh: resource.refresh,
  }
}

/**
 * Moves a trashed project back into the workspace and resolves with the name
 * it came back as.
 *
 * Throws `ApiError` on failure — notably 409 when a live project already
 * occupies the slug, whose message names the collision so the toast can say
 * what to rename.
 */
export function restoreTrashedProject(entry: string): Promise<{ dir: string; name: string }> {
  return apiRequest('/admin/api/studio/trash/restore', {
    method: 'POST',
    body: { entry },
    schema: RestoreResponseSchema,
  }).then((res) => res.project)
}

/**
 * Erases one trashed project permanently.
 *
 * The server answers with the refreshed trash listing and that answer is still
 * validated here, but the caller gets `void` — the panel redraws through the
 * hook's `refresh()`, so there is exactly one path by which the list on screen
 * comes to exist. Same reasoning as `deleteStudioProject`.
 */
export async function purgeTrashedProject(entry: string): Promise<void> {
  await apiRequest('/admin/api/studio/trash/purge', {
    method: 'POST',
    body: { entry },
    schema: TrashListResponseSchema,
  })
}
