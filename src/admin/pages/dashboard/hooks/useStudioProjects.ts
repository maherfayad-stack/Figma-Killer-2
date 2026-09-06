/**
 * useStudioProjects — data hook for the dashboard's Projects widget.
 *
 * Fetches `GET /admin/api/studio/projects`, which lists every on-disk
 * studio project: one entry per immediate subfolder of `studio-workspace/`,
 * whether hand-authored or GitHub-imported (Phase 7B) — they all live there.
 * Lives in its own hook because it hits a `/admin/api/studio/*` endpoint,
 * not the `/admin/api/cms/dashboard/<domain>` family the (now-removed)
 * dormant CMS dashboard widgets used.
 *
 * Validation: the response is checked at the JSON boundary against
 * `StudioProjectsResponseSchema` via the canonical `apiRequest` (`@core/http`).
 *
 * Errors are NOT swallowed. This is the launcher's only content — a failed
 * fetch used to leave a grid of skeletons shimmering forever with no way out,
 * which reads as "still loading" and never stops being wrong. The hook hands
 * back `error` so the page can say so, and `refresh` so the user can retry
 * (the same handle the launcher uses to redraw after a delete, instead of
 * reconciling its own optimistic edits against a list it can only read).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import type { ProjectPlatform } from '@core/studio-board'

const StudioProjectSchema = Type.Object(
  {
    dir: Type.String(),
    name: Type.String(),
    pageCount: Type.Number(),
  },
  { additionalProperties: true },
)
export type StudioProject = Static<typeof StudioProjectSchema>

const StudioProjectsResponseSchema = Type.Object(
  { projects: Type.Array(StudioProjectSchema) },
  { additionalProperties: true },
)

const CreateProjectResponseSchema = Type.Object(
  { project: StudioProjectSchema },
  { additionalProperties: true },
)

const DeleteProjectResponseSchema = Type.Object(
  { projects: Type.Array(StudioProjectSchema) },
  { additionalProperties: true },
)

const RenameProjectResponseSchema = Type.Object(
  { project: StudioProjectSchema },
  { additionalProperties: true },
)

export interface StudioProjectsResource {
  /** The listed projects, or null before the first successful load. */
  projects: StudioProject[] | null
  /** True while a load is in flight, including the initial one. */
  loading: boolean
  /** Message from the most recent failed load, else null. */
  error: string | null
  /** Re-runs the listing. Stable identity. */
  refresh: () => void
}

/** Overview launcher. One directory read: every subfolder of `studio-workspace/`. */
export function useStudioProjects(): StudioProjectsResource {
  const resource = useAsyncResource(
    (signal) => apiRequest('/admin/api/studio/projects', { schema: StudioProjectsResponseSchema, signal }),
    [],
    { fallbackError: 'Could not load your projects' },
  )
  return {
    projects: resource.data?.projects ?? null,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
  }
}

/**
 * Creates a new project (a folder under `studio-workspace/` with a starter
 * page) and resolves to its summary.
 *
 * `name` is optional — omit it and the server auto-names it `Untitled`,
 * `Untitled 2`, …. `platform` is the form factor chosen on the create dialog;
 * the server turns it into the project's `frameDefaults`, so every screen in
 * the project — the starter page included — opens at that size
 * (`@core/studio-board`'s `platformPresets.ts`).
 *
 * Throws `ApiError` on failure (e.g. a name collision → 409) so the caller can
 * surface the message via a toast.
 */
export function createStudioProject(
  options: { name?: string; platform?: ProjectPlatform } = {},
): Promise<StudioProject> {
  return apiRequest('/admin/api/studio/create', {
    method: 'POST',
    body: { name: options.name, platform: options.platform },
    schema: CreateProjectResponseSchema,
  }).then((res) => res.project)
}

/**
 * Renames a project's DISPLAY name (never its folder) and resolves to the
 * refreshed summary. Throws `ApiError` on failure so the caller can surface
 * the message via a toast.
 */
export function renameStudioProject(dir: string, name: string): Promise<StudioProject> {
  return apiRequest('/admin/api/studio/rename', {
    method: 'POST',
    body: { dir, name },
    schema: RenameProjectResponseSchema,
  }).then((res) => res.project)
}

/**
 * Deletes a project and resolves to the refreshed list.
 *
 * Nothing is erased — the server moves the project's folder into
 * `studio-workspace/.trash/` (`server/handlers/studio/projectTrash.ts`),
 * because a studio project is the user's own repository with no other copy.
 * The wording in the UI says so; this is the function that makes it true.
 *
 * The server answers with the refreshed list and that answer is still validated
 * here, but the caller gets `void`: the launcher redraws by calling the hook's
 * `refresh()`, so there is exactly one path by which the list on screen comes
 * to exist. Handing back a second, parallel copy of it invites the caller to
 * splice its own version of the truth.
 *
 * Throws `ApiError` on failure (403 without `studio.write`, 404 for a project
 * that is already gone) so the caller can surface the message via a toast.
 */
export async function deleteStudioProject(dir: string): Promise<void> {
  await apiRequest('/admin/api/studio/delete', {
    method: 'POST',
    body: { dir },
    schema: DeleteProjectResponseSchema,
  })
}
