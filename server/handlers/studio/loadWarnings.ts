/**
 * loadWarnings — WB-23/WB-24: the load's list of what it degraded instead of
 * failing (`StudioLoadResult.warnings`). A load must never throw because the
 * user's repository is mid-edit; it opens the board and says what it could not
 * do.
 *
 * Two sources, one list:
 *
 * - **The project** — whatever `createWorkspaceProject` gave up to build a
 *   project at all (`tsconfig-unreadable`), handed over by
 *   `withWorkspaceProject` beside the kept `Project`.
 * - **Each page** — a route whose own file does not parse (`syntax-error`,
 *   with the first parse error's line). Asked of the kept `Project` itself, on
 *   every compute, never cached with the route's parse: the parse cache keys
 *   on the file's mtime, so a cached parse of a broken file is still a broken
 *   file, but asking the program is the one answer that cannot go stale.
 *
 * A page with a syntax error still renders — TypeScript's parser recovers a
 * tree — so it is flagged rather than dropped; the write side refuses every
 * edit to the file until it parses (`studioSyntaxGuard.ts`).
 */
import { join } from 'node:path'
import { sourceFileSyntaxError, type WorkspaceProjectWarning } from '@core/page-parser'
import type { Project } from 'ts-morph'
import type { StudioLoadWarning } from './studioLoadContract'
import type { RoutePageEntry } from './routePageEntry'

export function collectLoadWarnings(
  dir: string,
  project: Project,
  projectWarnings: readonly WorkspaceProjectWarning[],
  routeEntries: readonly RoutePageEntry[],
): StudioLoadWarning[] {
  const warnings: StudioLoadWarning[] = projectWarnings.map((warning) => ({
    code: warning.code,
    file: 'tsconfig.json',
    message: warning.message,
  }))
  for (const entry of routeEntries) {
    const sourceFile = project.getSourceFile(join(dir, ...entry.relFile.split('/')))
    const syntaxError = sourceFile ? sourceFileSyntaxError(sourceFile) : undefined
    if (!syntaxError) continue
    warnings.push({
      code: 'syntax-error',
      pageId: entry.pageId,
      file: entry.relFile,
      line: syntaxError.line,
      col: syntaxError.col,
      message: `${entry.relFile} line ${syntaxError.line}: ${syntaxError.message}`,
    })
  }
  return warnings
}
