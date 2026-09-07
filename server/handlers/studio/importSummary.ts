/**
 * importSummary — what an import answers with, once the bytes are on disk.
 *
 * ## Why this exists at all
 *
 * Both import routes used to answer `{ ok, dir, files, skipped }` and the
 * client navigated straight to the board. That is a report about the TRANSFER,
 * not about the project: "412 files imported" says nothing about whether
 * Studio understood the repo it just landed. The two failures that actually
 * happen — a Next repo whose routes are under `app/`, and a plain React repo
 * whose screens are somewhere the heuristic had to guess at — both produce a
 * perfectly successful transfer and an EMPTY canvas.
 *
 * So an import now answers with the four facts that predict what the board
 * will look like: the framework the probe recognised, where it decided the
 * pages live, how many it found there, and — when it had to guess — the
 * ranked directories it was choosing between.
 *
 * ## `pagesDirCandidates` is the point
 *
 * `projectProfileSchema.ts` has built `pagesDirCandidates` since WS-1.2 and
 * nothing has ever read it. It is populated exactly when `pagesDir` came from
 * the no-routing-framework heuristic rather than a framework convention —
 * which is precisely the moment a human should be offered the choice instead
 * of being handed a silent guess. Surfacing it is the difference between "we
 * picked `src/components`, sorry" and one click on `src/screens`.
 *
 * ## One builder, both import paths
 *
 * `import-github` (a polled job) and `import-upload` (a blocking XHR, for
 * upload progress) have completely different transports and the same
 * aftermath. Both call this, so the summary step the user sees is identical
 * whether they pasted a URL or dropped a folder onto the launcher — and there
 * is no second definition of "how many pages did we find" to drift.
 *
 * Everything here is read back from disk AFTER the import path has cached its
 * probe into `.studio/meta.json`. This module never probes: a probe that ran
 * here would be a second one, disagreeing with the cache the loader will
 * actually use.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { readStudioMeta } from './studioMeta'
import { PagesDirCandidateSchema, ProjectFrameworkSchema } from './projectProfileSchema'
import { studioProjectSummary } from '../studioProjects'

/**
 * The post-import summary step's whole contract. Shared by
 * `POST /admin/api/studio/import-upload`'s response body and the terminal
 * record of a GitHub import job.
 */
export const ImportSummarySchema = Type.Object({
  /** Absolute directory the project landed in. */
  dir: Type.String(),
  /** Display name recorded at import time (`.studio/meta.json`'s `displayName`). */
  name: Type.String(),
  /** Files actually written. */
  files: Type.Number(),
  /** Entries rejected by a size/count budget. */
  skipped: Type.Number(),
  /**
   * Framework from the cached probe, or `null` when the probe failed (never
   * fatal to an import — see either route's `catch`). `'unknown'` is a real
   * answer and is NOT null: it means the probe ran and recognised nothing.
   */
  framework: Type.Union([ProjectFrameworkSchema, Type.Null()]),
  /** Project-relative pages directory the loader will actually read, resolved through the same precedence `projectPagesDir` applies. */
  pagesDir: Type.String(),
  /** Pages discovered there — the number of frames the board is about to open with. */
  pageCount: Type.Number(),
  /**
   * Ranked alternatives, present only when `pagesDir` was a heuristic guess.
   * Empty for every framework-convention answer, which is the signal the
   * summary step uses to decide whether to render a picker at all.
   */
  pagesDirCandidates: Type.Array(PagesDirCandidateSchema),
})
export type ImportSummary = Static<typeof ImportSummarySchema>

/**
 * Builds the summary for a project that has just been written to `dir` and
 * probed. `ingest` carries the two transfer counts the ingest engine returned;
 * everything else is read back from what the import already persisted.
 *
 * `pagesDir` mirrors `projectPagesDir`'s precedence (explicit override, then
 * the cached probe, then the `pages` default) as a project-RELATIVE string —
 * this is a label a human reads, not a path anything joins onto.
 */
export function buildImportSummary(dir: string, ingest: { files: number; skipped: number }): ImportSummary {
  const meta = readStudioMeta(dir)
  const summary = studioProjectSummary(dir)
  return {
    dir,
    name: summary.name,
    files: ingest.files,
    skipped: ingest.skipped,
    framework: meta.profile?.framework ?? null,
    pagesDir: meta.pagesDir ?? meta.profile?.pagesDir ?? 'pages',
    pageCount: summary.pageCount,
    pagesDirCandidates: meta.profile?.pagesDirCandidates ?? [],
  }
}
