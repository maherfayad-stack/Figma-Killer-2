/**
 * routeParse — one route through the parse cache: reuse it, or parse it,
 * prove the parse read what is on disk, and record what it depended on
 * (P6-B). Every route producer goes through here — file-per-page and App
 * Router routes (`studioPageLoad.ts`) and Storybook stories (`storyPages.ts`)
 * — so the three cannot disagree about when a cached page may be served.
 *
 * ## The loop
 *
 * 1. `pageParseCache.ts` answers from memory or disk when every dependency is
 *    unchanged.
 * 2. Otherwise the route is parsed against the kept ts-morph `Project`.
 * 3. The `Project` was synced from the project watcher's change feed, which
 *    can lag the disk (`workspaceProject.ts`, rule 2). So every file the parse
 *    read is re-stamped against the `Project`'s copy
 *    (`WorkspaceProjectHandle.resyncStale`); if any was behind, the `Project`
 *    is brought up to date and the route parsed again — at most
 *    {@link MAX_PARSE_ATTEMPTS} times, for a file being rewritten as fast as
 *    it is read. Only then is the result recorded, and the race rule in
 *    `pageParseCache.ts` still refuses to cache it if anything moved since.
 *
 * ## Dependencies by absence
 *
 * A page that imports `./Card` before `Card.tsx` exists renders a placeholder
 * — and it read no file that creating `Card.tsx` changes, so nothing
 * invalidated it: the placeholder stayed until something else touched the
 * page, or the server restarted, and a persistent cache would have made even
 * the restart useless. So every relative import (or re-export) in a file the
 * parse read that resolved to NOTHING contributes the files it WOULD resolve
 * to, each recorded as a dependency that must stay missing
 * ({@link unresolvedImportCandidates}). Creating one both invalidates the
 * cache entry and, through `resyncStale`, puts the new file into the
 * `Project` before the re-parse.
 *
 * Only relative MODULE specifiers, and only candidates that are missing now:
 *
 *   - a bare specifier names a package (`node_modules` is not watched and
 *     changes only by install), and an aliased one is decided by the tsconfig,
 *     whose change already rebuilds everything (`workspaceProject.ts`);
 *   - an asset specifier (`./theme.css`, `./icon.svg?raw`) never resolves to a
 *     module at all, and the evaluator already records the asset files it
 *     reads (`evalReadFiles.ts`). Recording `./corpus.css` here made every
 *     page that imports a shared stylesheet depend on it, so one CSS edit
 *     re-parsed a 40-page board — measured, 170 ms → 1.9 s;
 *   - a candidate that exists but did not resolve is not an ABSENCE, and the
 *     parse did not read it either.
 */
import { dirname, join } from 'node:path'
import type { Project } from 'ts-morph'
import { getCachedRouteParse, setCachedRouteParse, type CachedRouteParse, type RouteCacheScope } from './pageParseCache'
import { fileStamp, MISSING } from './loadDigest'
import type { WorkspaceProjectHandle } from './workspaceProject'

/** How many times one route is re-parsed because the `Project` was behind the disk. */
const MAX_PARSE_ATTEMPTS = 3

/** A route's parse and the stamps of what it depended on — `null` when it could not be cached (see `pageParseCache.ts`'s race rule). */
export interface RouteParseOutcome {
  result: CachedRouteParse
  dependencies: ReadonlyMap<string, string> | null
}

/** What one fresh parse of a route produced: the result, and every file it read. */
export interface FreshRouteParse {
  result: CachedRouteParse
  dependencyFiles: Iterable<string>
}

/**
 * `route`'s parse — cached, or produced by `parse` and verified. `parse` may
 * return `null` for a route that produced nothing worth keeping (a story that
 * degraded to no frame); that is returned as `null` and never cached.
 */
export function parseRouteThroughCache(
  scope: RouteCacheScope,
  workspace: WorkspaceProjectHandle,
  route: string,
  parse: () => FreshRouteParse | null,
): RouteParseOutcome | null {
  const hit = getCachedRouteParse(scope, route)
  if (hit) return { result: { expanded: hit.expanded, componentSources: hit.componentSources }, dependencies: hit.dependencies }

  for (let attempt = 1; ; attempt += 1) {
    const fresh = parse()
    if (!fresh) return null
    const read = [...fresh.dependencyFiles]
    const dependencyFiles = [...read, ...unresolvedImportCandidates(workspace.project, read)]
    if (workspace.resyncStale(dependencyFiles) && attempt < MAX_PARSE_ATTEMPTS) continue
    return { result: fresh.result, dependencies: setCachedRouteParse(scope, route, dependencyFiles, fresh.result) }
  }
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']

/** An asset or stylesheet specifier (`./theme.css`, `./icon.svg?raw`) — never a module; see this module's doc. */
const ASSET_EXTENSION_RE = /\.(css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|ico|bmp|md|txt|woff2?|ttf|otf|mp4|webm)$/i

function candidatesFor(fromFile: string, specifier: string): string[] {
  const path = specifier.split('?')[0]!
  if (ASSET_EXTENSION_RE.test(path)) return []
  const base = join(dirname(fromFile), path)
  return [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ].filter((candidate) => fileStamp(candidate) === MISSING)
}

/**
 * Every file an unresolved relative import in `files` would resolve to, were
 * it created. `files` are absolute paths; any the `Project` does not hold
 * (a JSON dictionary, an image) are skipped. See this module's doc.
 */
export function unresolvedImportCandidates(project: Project, files: Iterable<string>): string[] {
  const candidates: string[] = []
  for (const file of files) {
    const sourceFile = project.getSourceFile(file)
    if (!sourceFile) continue
    const declarations = [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]
    for (const declaration of declarations) {
      const specifier = declaration.getModuleSpecifierValue()
      if (!specifier || !specifier.startsWith('.')) continue
      if (declaration.getModuleSpecifierSourceFile()) continue
      candidates.push(...candidatesFor(file, specifier))
    }
  }
  return candidates
}
