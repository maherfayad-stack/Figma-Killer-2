/**
 * pageDelete — `DELETE /admin/api/studio/page`: removing a screen from the
 * project for real, not just from the in-memory site tree.
 *
 * The mirror of `pageScaffold.ts`, and it exists for the same reason that one
 * does: in Studio the repository IS the document. `deletePage` in the editor
 * store used to splice the page out of `site.pages` and stop there, so the
 * `.tsx` stayed on disk and the very next reload parsed it straight back in.
 * A delete that a reload undoes is not a delete.
 *
 * ## What it removes, and what it deliberately does not
 *
 * 1. **The page's own source file.** Resolved from `pageId` by re-running the
 *    SAME id assignment the loader uses (`assignPageIds` /
 *    `assignAppRouterPageIds`), never by trusting a path from the client —
 *    the request names a page, not a file, so there is nothing to escape with.
 *
 * 2. **A stylesheet the page imported, if nothing else references it.** A
 *    scaffolded page is written as a `.tsx` + its own `.module.css`
 *    (`createScaffoldedPage`), so deleting only half of that pair leaves an
 *    orphan every time. The "nothing else references it" test is a
 *    conservative basename scan of the remaining workspace files: a false
 *    "still referenced" keeps a file that could have gone, which is the safe
 *    direction to be wrong in.
 *
 * 3. **Every board frame of that page, on every board** — see
 *    `removeBoardFramesForPage`. A frame pointing at a deleted file renders as
 *    a permanently broken screen.
 *
 * 4. **Route directories that are now empty**, walking up but never past the
 *    pages/app root.
 *
 * It does NOT touch assets (`assets/*.svg`), shared components, or the
 * dictionary. Those are shared by construction — a page is usually the last
 * thing to reference one, not the only thing, and deleting a logo because the
 * last screen using it went away is not a call this operation gets to make.
 */
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import {
  discoverAppRouterRoutes,
  discoverPageFiles,
  projectPagesDir,
} from '../studioProjects'
import { assignAppRouterPageIds, assignPageIds } from '../studioPageIds'
import { removeBoardFramesForPage } from './boardFrames'
import { resolveAppRoot } from './appRoot'
import { readStudioMeta } from './studioMeta'

/** Stylesheet extensions a page can import and own — the same set `studioCss.ts` treats as authored CSS. */
const STYLESHEET_EXTENSIONS = ['.css', '.scss', '.sass', '.less']

/** Source extensions worth scanning for a lingering reference to a stylesheet. */
const REFERENCING_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', ...STYLESHEET_EXTENSIONS]

/**
 * A deleted page, or the one refusal this operation has. `notFound` is a value
 * rather than a thrown error for the same reason `ScaffoldPageResult`'s
 * `conflict` is: "there is no page with that id" is an ordinary answer the
 * route maps to 404, not an exception.
 */
export type DeletePageResult =
  | { ok: true; pageId: string; removedFiles: string[]; removedFrames: number }
  | { ok: false; notFound: string }

/**
 * The workspace-relative path of `pageId`'s source file, or `undefined`.
 *
 * Re-derives ids exactly as `loadStudioPages` does rather than inverting the
 * slug rules by hand: `pageIdFromRelPath` is not injective (two nested paths
 * can slugify the same, which is why `assignPageIds` dedupes across the whole
 * discovered set), so the only honest way back from an id to a file is to
 * build the same map and look the id up in it.
 */
function pageSourceRelPath(dir: string): (pageId: string) => string | undefined {
  const framework = readStudioMeta(dir).profile?.framework
  if (framework === 'next-app') {
    const appDir = resolveAppRoot(dir)
    const routes = discoverAppRouterRoutes(appDir)
    const ids = assignAppRouterPageIds(routes)
    return (pageId) => {
      const match = routes.find(({ relPath }) => ids.get(relPath) === pageId)
      return match ? join(appDir, match.relPath) : undefined
    }
  }
  const pagesDir = projectPagesDir(dir)
  const relPaths = discoverPageFiles(pagesDir)
  const ids = assignPageIds(relPaths)
  return (pageId) => {
    const match = relPaths.find((relPath) => ids.get(relPath) === pageId)
    return match ? join(pagesDir, match) : undefined
  }
}

/**
 * The stylesheet files `file` imports by RELATIVE specifier and that really
 * exist on disk. Package specifiers (`@alm-design/…`, `some-lib/style.css`)
 * are skipped deliberately: those are not this project's files to delete.
 */
function importedStylesheets(dir: string, file: string): string[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1] ?? match[2]
    if (!specifier || !specifier.startsWith('.')) continue
    if (!STYLESHEET_EXTENSIONS.some((ext) => specifier.endsWith(ext))) continue
    const resolved = resolve(dirname(file), specifier)
    if (!isInsideProject(dir, resolved) || !existsSync(resolved)) continue
    found.push(resolved)
  }
  return found
}

/** True when `candidate` is a real path inside `dir` — the same containment shape `projectPagesDir` enforces. */
function isInsideProject(dir: string, candidate: string): boolean {
  const root = resolve(dir)
  return candidate !== root && candidate.startsWith(root + sep)
}

/**
 * Whether any file still left in the workspace mentions `stylesheet`'s
 * basename. Deliberately a text scan rather than a resolver: it is called
 * AFTER the page file is gone, it only has to be conservative in one
 * direction, and a CSS-Modules import is always written as a literal
 * `./Name.module.css` — so a basename hit is a real reference and a miss is a
 * genuinely orphaned file.
 */
function stillReferenced(dir: string, stylesheet: string): boolean {
  const base = stylesheet.slice(stylesheet.lastIndexOf(sep) + 1)
  for (const relPath of listWorkspaceFiles(dir)) {
    if (!REFERENCING_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue
    const candidate = join(dir, relPath)
    if (candidate === stylesheet) continue
    try {
      if (readFileSync(candidate, 'utf8').includes(base)) return true
    } catch (_err) {
      // Unreadable file (a permission or encoding surprise mid-walk): treat it
      // as a possible reference rather than deleting on incomplete evidence.
      return true
    }
  }
  return false
}

/**
 * Remove `from`'s directory, and each empty parent above it, stopping at
 * (and never removing) `stopAt`. An App Router route is a DIRECTORY —
 * deleting `app/pricing/page.tsx` leaves `app/pricing/` behind, which
 * `discoverAppRouterRoutes` correctly stops reporting but which is still
 * visible clutter in the user's repo.
 */
function pruneEmptyDirs(from: string, stopAt: string): void {
  const root = resolve(stopAt)
  let current = dirname(resolve(from))
  while (current !== root && current.startsWith(root + sep)) {
    if (!existsSync(current) || readdirSync(current).length > 0) return
    rmdirSync(current)
    current = dirname(current)
  }
}

/**
 * Delete `pageId`'s source file, its orphaned stylesheet, its board frames,
 * and any directory those leave empty. `dir` is already resolved and
 * containment-checked by the route.
 */
export function deleteStudioPage(dir: string, pageId: string): DeletePageResult {
  const file = pageSourceRelPath(dir)(pageId)
  if (!file || !existsSync(file)) {
    return { ok: false, notFound: `No page with id "${pageId}" exists in this project.` }
  }

  // Read the page's stylesheet imports BEFORE deleting it — afterwards there
  // is nothing left to read them from.
  const stylesheets = importedStylesheets(dir, file)
  const removedFiles = [relative(dir, file)]
  rmSync(file)

  for (const stylesheet of stylesheets) {
    if (stillReferenced(dir, stylesheet)) continue
    rmSync(stylesheet)
    removedFiles.push(relative(dir, stylesheet))
  }

  const framework = readStudioMeta(dir).profile?.framework
  pruneEmptyDirs(file, framework === 'next-app' ? resolveAppRoot(dir) : projectPagesDir(dir))

  return { ok: true, pageId, removedFiles, removedFrames: removeBoardFramesForPage(dir, pageId) }
}
