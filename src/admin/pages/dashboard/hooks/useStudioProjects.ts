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
import { TrustTierSchema } from '@site/studio/studioProjectTrust'
import { CompilableStyleToolchainSchema } from '@site/studio/styleCompileConsent'

/**
 * The framework vocabulary `ProjectProfile.framework` uses on the server
 * (`server/handlers/studio/projectProfileSchema.ts`). Mirrored rather than
 * imported for the same reason `TrustTierSchema` is mirrored in
 * `studioProjectTrust.ts`: this runs in the browser and only has to agree on
 * the wire shape, not import a Node-only module.
 */
const ProjectFrameworkSchema = Type.Union([
  Type.Literal('vite'),
  Type.Literal('next-app'),
  Type.Literal('next-pages'),
  Type.Literal('cra'),
  Type.Literal('remix'),
  Type.Literal('astro'),
  Type.Literal('unknown'),
])
export type ProjectFramework = Static<typeof ProjectFrameworkSchema>

/**
 * One project as the launcher knows it. Mirrors `StudioProjectSummary`
 * (`server/handlers/studioProjects.ts`), which is the one place all four
 * project endpoints build their answer — so a card redrawn from a rename or a
 * duplicate carries exactly what a card drawn from the listing does.
 *
 * `platform` and `framework` are genuinely optional on the wire (an import has
 * no recorded platform; an unprobed project has no framework), and the card
 * renders no badge for an absent one rather than guessing. `trust`,
 * `styleToolchains` and `editedAt` are always sent.
 */
const StudioProjectSchema = Type.Object(
  {
    dir: Type.String(),
    name: Type.String(),
    pageCount: Type.Number(),
    platform: Type.Optional(Type.Union([Type.Literal('mobile'), Type.Literal('web')])),
    framework: Type.Optional(ProjectFrameworkSchema),
    trust: TrustTierSchema,
    /** Style toolchains the probe found that only run at Tier ≥ 1. Meaningful paired with `trust === 'static'`. */
    styleToolchains: Type.Array(CompilableStyleToolchainSchema),
    /** Epoch ms of the newest file under the project's pages dir — see the server-side field doc. */
    editedAt: Type.Number(),
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

const DuplicateProjectResponseSchema = Type.Object(
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
 * Copies the checked-in sample repository into the workspace and resolves to
 * the new project's summary.
 *
 * Takes nothing: the sample is one fixed repository and the server picks the
 * first free `Sample project`, `Sample project 2`, … name, the same way
 * `/duplicate` does. Calling it twice makes a second sample rather than
 * replacing the first — see `server/handlers/studio/sampleProject.ts`.
 *
 * Throws `ApiError` on failure (403 without `studio.write`, 500 when this
 * installation has no `examples/studio-sample-project/` on disk) so the caller
 * can surface the message via a toast.
 */
export function createSampleStudioProject(): Promise<StudioProject> {
  return apiRequest('/admin/api/studio/sample', {
    method: 'POST',
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
 * Copies a project beside itself and resolves to the new project's summary.
 *
 * The copy is the whole repository minus `node_modules`, build output and
 * `.git` (see `server/handlers/studio/projectDuplicate.ts` for why each is
 * left behind). `name` is optional — omit it and the server picks the first
 * free `<name> copy`, `<name> copy 2`, ….
 *
 * Throws `ApiError` on failure (403 without `studio.write`, 404 for a project
 * that has since been deleted, 409 for a name collision) so the caller can
 * surface the message via a toast.
 */
export function duplicateStudioProject(dir: string, name?: string): Promise<StudioProject> {
  return apiRequest('/admin/api/studio/duplicate', {
    method: 'POST',
    body: { dir, name },
    schema: DuplicateProjectResponseSchema,
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
