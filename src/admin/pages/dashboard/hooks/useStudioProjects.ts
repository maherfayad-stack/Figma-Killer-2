/**
 * useStudioProjects — data hook for the dashboard's Projects widget.
 *
 * Fetches `GET /admin/api/studio/projects`, which lists every on-disk
 * studio project: the default hand-authored workspace (when present) plus
 * one entry per GitHub import (Phase 7B) under `studio-workspace-imports/`.
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
    kind: Type.Union([Type.Literal('workspace'), Type.Literal('import')]),
    pageCount: Type.Number(),
  },
  { additionalProperties: true },
)
export type StudioProject = Static<typeof StudioProjectSchema>

const StudioProjectsResponseSchema = Type.Object(
  { projects: Type.Array(StudioProjectSchema) },
  { additionalProperties: true },
)

/** Projects widget. One directory read: the default workspace + every GitHub import. */
export function useStudioProjects(): StudioProject[] | null {
  return useAsyncResource(
    (signal) => apiRequest('/admin/api/studio/projects', { schema: StudioProjectsResponseSchema, signal }),
    [],
    { swallowErrors: true },
  ).data?.projects ?? null
}
