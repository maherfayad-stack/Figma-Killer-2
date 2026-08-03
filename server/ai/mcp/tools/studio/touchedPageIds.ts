/**
 * touchedFilesToPageIds — the file → pageId mapping the live-reload bridge
 * needs: given the absolute file paths a server-resolved Studio write tool
 * (`studio_apply_edits` / `studio_codemod`) just touched, which board page
 * ids do they belong to.
 *
 * Reuses the EXISTING id derivation `loadStudioPages` itself uses for the
 * standard (non-app-router) page-discovery path —
 * `discoverPageFiles`/`assignPageIds`/`pageIdFromRelPath`
 * (`server/handlers/studioPageLoad.ts` and `studioProjects.ts`) — rather than
 * re-deriving the id grammar a second time. `assignPageIds` is pure and cheap
 * (no parsing, just the discovered relPath list), so this is a directory
 * walk, not a second parse of the touched files.
 *
 * Deliberately does NOT special-case a Next.js App Router project: that
 * framework composes page ids from ROUTES (`buildAppRouterPageEntries`), a
 * completely different scheme `discoverPageFiles`/`assignPageIds` never sees.
 * A touched file that isn't one of the standard page-discovery entries simply
 * maps to no page id here — the live-reload push for that project is
 * silently a no-op (the disk write already succeeded either way; the canvas
 * just stays stale until the next manual reload, the documented fail-soft
 * posture for this whole feature) rather than inventing a wrong id.
 */
import { relative, sep } from 'node:path'
import { discoverPageFiles, projectPagesDir } from '../../../../handlers/studioProjects'
import { assignPageIds } from '../../../../handlers/studioPageIds'

export function touchedFilesToPageIds(dir: string, touchedFiles: readonly string[]): string[] {
  if (touchedFiles.length === 0) return []

  let pagesDir: string
  try {
    pagesDir = projectPagesDir(dir)
  } catch {
    return [] // an escaping pagesDir override — nothing honest to map against
  }

  const relPaths = discoverPageFiles(pagesDir)
  const idByRelPath = assignPageIds(relPaths)
  const relPathSet = new Set(relPaths)

  const ids = new Set<string>()
  for (const file of touchedFiles) {
    const rel = relative(pagesDir, file).split(sep).join('/')
    if (!relPathSet.has(rel)) continue
    const id = idByRelPath.get(rel)
    if (id) ids.add(id)
  }
  return [...ids]
}
