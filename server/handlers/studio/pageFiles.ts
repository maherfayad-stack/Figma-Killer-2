/**
 * pageFiles — the four questions both "delete this page" and "move this page
 * to the trash" have to answer about a page's files, in one place so the two
 * operations can never disagree about what a page is made of.
 *
 *   - `resolvePageSourceFile` — which file is `pageId`?
 *   - `importedStylesheets`   — what did it bring with it?
 *   - `stillReferenced`       — is that stylesheet anyone else's too?
 *   - `pruneEmptyDirs`        — what is left behind once the file goes?
 *
 * Extracted when `pageTrash.ts` needed all four: a soft delete that computed
 * a DIFFERENT set of files from the hard delete would be the worst kind of
 * bug here — you would restore a page and find half of it missing, with
 * nothing to say why.
 */
import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { discoverAppRouterRoutes, discoverPageFiles, projectPagesDir } from '../studioProjects'
import { assignAppRouterPageIds, assignPageIds } from '../studioPageIds'
import { resolveAppRoot } from './appRoot'
import { readStudioMeta } from './studioMeta'

/** Stylesheet extensions a page can import and own — the same set `studioCss.ts` treats as authored CSS. */
const STYLESHEET_EXTENSIONS = ['.css', '.scss', '.sass', '.less']

/** Source extensions worth scanning for a lingering reference to a stylesheet. */
const REFERENCING_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', ...STYLESHEET_EXTENSIONS]

/**
 * The absolute path of `pageId`'s source file, or `undefined`.
 *
 * Re-derives ids exactly as `loadStudioPages` does rather than inverting the
 * slug rules by hand: `pageIdFromRelPath` is not injective (two nested paths
 * can slugify the same, which is why `assignPageIds` dedupes across the whole
 * discovered set), so the only honest way back from an id to a file is to
 * build the same map and look the id up in it.
 *
 * This is also what makes both operations safe by construction: the caller
 * names a PAGE, never a path, so there is nothing for a hand-crafted request
 * to escape the project with.
 */
export function resolvePageSourceFile(dir: string, pageId: string): string | undefined {
  if (readStudioMeta(dir).profile?.framework === 'next-app') {
    const appDir = resolveAppRoot(dir)
    const routes = discoverAppRouterRoutes(appDir)
    const ids = assignAppRouterPageIds(routes)
    const match = routes.find(({ relPath }) => ids.get(relPath) === pageId)
    return match ? join(appDir, match.relPath) : undefined
  }
  const pagesDir = projectPagesDir(dir)
  const relPaths = discoverPageFiles(pagesDir)
  const ids = assignPageIds(relPaths)
  const match = relPaths.find((relPath) => ids.get(relPath) === pageId)
  return match ? join(pagesDir, match) : undefined
}

/** The directory a page file's route tree is rooted at — `app/` for App Router, the pages dir otherwise. */
export function pageRootDir(dir: string): string {
  return readStudioMeta(dir).profile?.framework === 'next-app' ? resolveAppRoot(dir) : projectPagesDir(dir)
}

/**
 * The stylesheet files `file` imports by RELATIVE specifier and that really
 * exist on disk. Package specifiers (`@alm-design/…`, `some-lib/style.css`)
 * are skipped deliberately: those are not this project's files to move or
 * delete.
 */
export function importedStylesheets(dir: string, file: string): string[] {
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
export function isInsideProject(dir: string, candidate: string): boolean {
  const root = resolve(dir)
  return candidate !== root && candidate.startsWith(root + sep)
}

/**
 * Whether any file still left in the workspace mentions `stylesheet`'s
 * basename. Deliberately a text scan rather than a resolver: it is called
 * AFTER the page file has gone, it only has to be conservative in one
 * direction, and a CSS-Modules import is always written as a literal
 * `./Name.module.css` — so a basename hit is a real reference and a miss is a
 * genuinely orphaned file.
 *
 * `listWorkspaceFiles` skips `.studio/`, so a copy of the page sitting in the
 * TRASH never counts as a reference keeping its own stylesheet alive.
 */
export function stillReferenced(dir: string, stylesheet: string): boolean {
  const base = stylesheet.slice(stylesheet.lastIndexOf(sep) + 1)
  for (const relPath of listWorkspaceFiles(dir)) {
    if (!REFERENCING_EXTENSIONS.some((ext) => relPath.endsWith(ext))) continue
    const candidate = join(dir, relPath)
    if (candidate === stylesheet) continue
    try {
      if (readFileSync(candidate, 'utf8').includes(base)) return true
    } catch (_err) {
      // Unreadable file (a permission or encoding surprise mid-walk): treat it
      // as a possible reference rather than acting on incomplete evidence.
      return true
    }
  }
  return false
}

/**
 * Remove `from`'s directory, and each empty parent above it, stopping at
 * (and never removing) `stopAt`. An App Router route is a DIRECTORY —
 * removing `app/pricing/page.tsx` leaves `app/pricing/` behind, which
 * `discoverAppRouterRoutes` correctly stops reporting but which is still
 * visible clutter in the user's repo.
 */
export function pruneEmptyDirs(from: string, stopAt: string): void {
  const root = resolve(stopAt)
  let current = dirname(resolve(from))
  while (current !== root && current.startsWith(root + sep)) {
    if (!existsSync(current) || readdirSync(current).length > 0) return
    rmdirSync(current)
    current = dirname(current)
  }
}
