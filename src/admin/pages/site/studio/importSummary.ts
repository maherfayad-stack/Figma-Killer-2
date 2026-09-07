/**
 * importSummary — the browser's mirror of what an import answers with.
 *
 * Both import paths end here: `POST /admin/api/studio/import-upload` returns
 * one of these directly, and a GitHub import job's terminal record carries
 * one. That is deliberate — the launcher's post-import step is a single
 * component, and a project imported by drag-and-drop gets the same "here is
 * what we found" moment as one pulled from a URL.
 *
 * Mirrored rather than imported, for the same reason `TrustTierSchema` is
 * (`studioProjectTrust.ts`): this runs in the browser and only has to agree
 * on the wire shape, not import a Node-only module. The server's definition —
 * and the reasoning for each field — is
 * `server/handlers/studio/importSummary.ts`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'

/** Mirrors the server's `ProjectFrameworkSchema`. */
const ImportFrameworkSchema = Type.Union([
  Type.Literal('vite'),
  Type.Literal('next-app'),
  Type.Literal('next-pages'),
  Type.Literal('cra'),
  Type.Literal('remix'),
  Type.Literal('astro'),
  Type.Literal('unknown'),
])

/** One directory the probe ranked when it had to guess where the screens live. */
const PagesDirCandidateSchema = Type.Object({
  dir: Type.String(),
  /** (files whose default export returns JSX) / (total code files) in that directory, 0–1. */
  score: Type.Number(),
})
export type PagesDirCandidate = Static<typeof PagesDirCandidateSchema>

export const ImportSummarySchema = Type.Object(
  {
    dir: Type.String(),
    name: Type.String(),
    files: Type.Number(),
    skipped: Type.Number(),
    /** `null` when the post-import probe failed — the summary says so rather than guessing a framework. */
    framework: Type.Union([ImportFrameworkSchema, Type.Null()]),
    pagesDir: Type.String(),
    pageCount: Type.Number(),
    /** Non-empty exactly when the pages dir was a heuristic guess — the signal the summary step uses to render a picker. */
    pagesDirCandidates: Type.Array(PagesDirCandidateSchema),
  },
  { additionalProperties: true },
)
export type ImportSummary = Static<typeof ImportSummarySchema>

const PagesDirResponseSchema = Type.Object(
  { project: Type.Object({ pageCount: Type.Number() }, { additionalProperties: true }) },
  { additionalProperties: true },
)

/**
 * Records which directory holds this project's screens, and resolves with the
 * page count that choice actually yields.
 *
 * The summary step's picker is the only caller. It writes through
 * `POST /admin/api/studio/pages-dir` — the ONE route that sets
 * `.studio/meta.json`'s `pagesDir` override — rather than re-probing: the
 * probe already ranked these candidates and got it wrong, and the whole point
 * of the picker is that the human knows something the ranking does not.
 *
 * Throws `ApiError` on failure (400 for a path that escapes the project, 404
 * for a project since deleted) so the caller can toast the message.
 */
export function chooseProjectPagesDir(dir: string, pagesDir: string): Promise<number> {
  return apiRequest('/admin/api/studio/pages-dir', {
    method: 'POST',
    body: { dir, pagesDir },
    schema: PagesDirResponseSchema,
  }).then((res) => res.project.pageCount)
}

/** Human label for a framework the probe recognised — the summary step's one-line "what this repo is". */
export function frameworkLabel(framework: ImportSummary['framework']): string {
  switch (framework) {
    case 'vite':
      return 'Vite'
    case 'next-app':
      return 'Next.js (App Router)'
    case 'next-pages':
      return 'Next.js (Pages Router)'
    case 'cra':
      return 'Create React App'
    case 'remix':
      return 'Remix'
    case 'astro':
      return 'Astro'
    case 'unknown':
      // A real answer, not an absence: the probe ran and matched no
      // convention, which is why the pages dir is likely a guess.
      return 'No framework detected'
    case null:
      return 'Not analysed'
  }
}
