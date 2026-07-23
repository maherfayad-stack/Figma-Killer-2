/**
 * importGithubProject — client for `POST /admin/api/studio/import-github`
 * (Phase 7B). Fetches a GitHub repo's source into a studio workspace
 * directory server-side; the caller is responsible for pointing the editor
 * at the returned `dir` afterwards (see `ImportGithubDialog`, which sets
 * `studioWorkspaceDir` and triggers a reload).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'

export interface ImportGithubProjectInput {
  /** A GitHub repo URL — https://github.com/<owner>/<repo>, .git suffix / trailing slash tolerated. */
  url: string
  /** Branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref?: string
  /** Import only this subdirectory of the repo as the workspace root. */
  subdir?: string
  /** Sent as a Bearer credential for private repos — never persisted, never logged. */
  token?: string
}

export interface ImportGithubProjectResult {
  dir: string
  files: number
  skipped: number
}

const ImportGithubResponseSchema = Type.Object({
  ok: Type.Literal(true),
  dir: Type.String(),
  files: Type.Number(),
  skipped: Type.Number(),
})

export async function importGithubProject(
  input: ImportGithubProjectInput,
): Promise<ImportGithubProjectResult> {
  const { dir, files, skipped } = await apiRequest('/admin/api/studio/import-github', {
    method: 'POST',
    body: input,
    schema: ImportGithubResponseSchema,
  })
  return { dir, files, skipped }
}
