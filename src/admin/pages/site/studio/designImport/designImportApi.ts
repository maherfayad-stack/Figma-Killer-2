/**
 * designImportApi — thin `apiRequest` wrappers for the design-token import
 * endpoints (`server/handlers/designImport.ts`). Two calls, mirroring the
 * two-step dialog flow:
 *
 *   previewDesignImport  → POST /admin/api/design-import/preview
 *       Fetches the source's `.css` files (nothing written to disk) and
 *       returns them alongside classified color/typography/spacing
 *       candidates, for the user to review before anything is applied.
 *
 *   copyDesignImportCss   → POST /admin/api/design-import/copy-css
 *       Writes the (still client-held, from the preview response) CSS files
 *       verbatim into the active project's `styles/imported/<slug>/`. This is
 *       the only server round trip "applying" an import makes — the actual
 *       Colors/Typography/Spacing token writes happen entirely client-side
 *       through the normal editor-store framework actions (see
 *       `applyDesignImportTokens.ts`), which is what persists them via the
 *       existing `/admin/api/studio/framework` sync in `fsCodemodAdapter`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { getStudioWorkspaceDir } from '../studioWorkspaceDir'

const FetchedCssFileSchema = Type.Object({
  relPath: Type.String(),
  contents: Type.String(),
})
export type FetchedCssFile = Static<typeof FetchedCssFileSchema>

const ColorCandidateSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  value: Type.String(),
  file: Type.String(),
})
export type ColorCandidate = Static<typeof ColorCandidateSchema>

const SizeCandidateSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  value: Type.String(),
  px: Type.Number(),
  file: Type.String(),
})
export type SizeCandidate = Static<typeof SizeCandidateSchema>

const PreviewResponseSchema = Type.Object({
  label: Type.String(),
  truncated: Type.Boolean(),
  files: Type.Array(FetchedCssFileSchema),
  colors: Type.Array(ColorCandidateSchema),
  typography: Type.Array(SizeCandidateSchema),
  spacing: Type.Array(SizeCandidateSchema),
  otherCount: Type.Number(),
})
export type DesignImportPreview = Static<typeof PreviewResponseSchema>

export type DesignImportSourceInput =
  | { source: 'github'; url: string; ref?: string; subdir?: string; token?: string }
  | { source: 'npm'; packageSpec: string }

/** Fetches `input`'s CSS files and returns classified token candidates. Throws `ApiError` on failure (bad URL/package, network error, oversized source, …). */
export function previewDesignImport(input: DesignImportSourceInput): Promise<DesignImportPreview> {
  return apiRequest('/admin/api/design-import/preview', {
    method: 'POST',
    body: input,
    schema: PreviewResponseSchema,
  })
}

const CopyCssResponseSchema = Type.Object({
  ok: Type.Boolean(),
  dir: Type.String(),
  written: Type.Number(),
  skipped: Type.Number(),
})
export type DesignImportCopyResult = Static<typeof CopyCssResponseSchema>

/** Writes `files` (as returned by `previewDesignImport`) into the active project's `styles/imported/<sourceSlug>/`. Targets the SAME workspace dir every other studio call uses. */
export function copyDesignImportCss(
  sourceSlug: string,
  files: readonly FetchedCssFile[],
): Promise<DesignImportCopyResult> {
  const overrideDir = getStudioWorkspaceDir()
  return apiRequest('/admin/api/design-import/copy-css', {
    method: 'POST',
    body: {
      sourceSlug,
      files,
      ...(overrideDir ? { dir: overrideDir } : {}),
    },
    schema: CopyCssResponseSchema,
  })
}
