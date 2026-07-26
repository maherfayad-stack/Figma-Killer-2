/**
 * useStudioProjects — data hook for the dashboard's Projects widget.
 *
 * Fetches `GET /admin/api/studio/projects`, which lists every on-disk
 * studio project: one entry per immediate subfolder of `studio-workspace/`,
 * whether hand-authored or GitHub-imported (Phase 7B) — they all live there.
 * Lives in its own hook (rather than folding into `useDashboardStats.ts`)
 * because it hits a `/admin/api/studio/*` endpoint, not the
 * `/admin/api/cms/dashboard/<domain>` family the other per-widget hooks
 * share.
 *
 * Validation: the response is checked at the JSON boundary against
 * `StudioProjectsResponseSchema` via the canonical `apiRequest` (`@core/http`).
 * `swallowErrors: true` matches every other dashboard widget hook — on
 * failure the widget just keeps its skeleton rather than flashing an error
 * (the endpoint is a simple directory read, so failures should be rare and
 * transient).
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { useAsyncResource } from '@admin/lib/useAsyncResource'

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

const RenameProjectResponseSchema = Type.Object(
  { project: StudioProjectSchema },
  { additionalProperties: true },
)

/** Overview launcher. One directory read: every subfolder of `studio-workspace/`. */
export function useStudioProjects(): StudioProject[] | null {
  return useAsyncResource(
    (signal) => apiRequest('/admin/api/studio/projects', { schema: StudioProjectsResponseSchema, signal }),
    [],
    { swallowErrors: true },
  ).data?.projects ?? null
}

/**
 * Creates a new project (a folder under `studio-workspace/` with a starter
 * page) and resolves to its summary. `name` is optional — omit it for the
 * one-click "New project" action and the server auto-names it `Untitled`,
 * `Untitled 2`, …. Throws `ApiError` on failure (e.g. a name collision → 409)
 * so the caller can surface the message via a toast.
 */
export function createStudioProject(name?: string): Promise<StudioProject> {
  return apiRequest('/admin/api/studio/create', {
    method: 'POST',
    body: { name },
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
