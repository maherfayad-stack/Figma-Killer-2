/**
 * reloadScope — `POST /admin/api/studio/reload-scope`, Track C5 (reload
 * surgery, `STUDIO-FIGMA-PARITY-PLAN.md` §6). The other half of a targeted
 * reload after a structural edit (`move`/`delete`/`insert` — `commitStructural`
 * in `src/admin/pages/site/studio/studioSaveRequests.ts`).
 *
 * ## Why this route exists instead of a second parse path
 *
 * `GET /admin/api/studio/load?pageIds=` already exists (WS-5.5/mcp-tooling's
 * live-reload bridge — see `studioLoadResponse.ts`'s module doc) and already
 * does exactly "reparse the workspace (cheaply, via `pageParseCache.ts` —
 * every UNCHANGED route is a cache hit) and hand back only the requested
 * pages' content". This route does NOT duplicate that. Its only job is the
 * question that route can't answer for itself: **given the file(s) a write
 * just touched, is it SAFE to ask for only the page(s) that own them, or does
 * the edit reach further than that?** The answer is `{ narrow: true, pageIds
 * }` (call `/load?pageIds=` with exactly these) or `{ narrow: false }` (fall
 * back to a full, unfiltered reload — the caller's existing, already-correct
 * behaviour).
 *
 * ## The question this answers: which routes did those files feed?
 *
 * `pageParseCache.ts` already records, per route, the absolute-path set of
 * every file that route's own parse depended on: its own file, its resolved
 * local-component sources, and — for App Router — its whole layout chain.
 * `cachedRouteDependencies` hands that map over; this module inverts it.
 * A touched file's reload scope is **every cached route that recorded it as
 * a dependency**, mapped to page ids through the SAME `assignPageIds` /
 * `assignAppRouterPageIds` a full load uses. No new bookkeeping, no re-parse,
 * no filesystem access beyond the pages-directory walk the id assignment
 * needs anyway.
 *
 * That is strictly wider than "is this a page's own file", and deliberately
 * so. The interesting case is the one an earlier version of this route
 * refused outright: a shared local component (`components/Card.tsx`) inlined
 * into three of forty pages, or an App Router `layout.tsx` composed into
 * every route beneath it. Those are exactly the writes the save path reports
 * as `sharedComponents`, i.e. the common case on a real board — and their
 * honest scope is "those three pages", not "all forty".
 *
 * ## Narrowing may never UNDER-reload. Four rules, each widening
 *
 * 1. **A cold cache widens.** `cachedRouteDependencies` returns `null` when
 *    nothing has parsed this project in this server process. There is no
 *    dependency data to consult, so there is nothing honest to answer.
 * 2. **Incomplete cache coverage widens.** If any route `discoverPageFiles` /
 *    `discoverAppRouterRoutes` finds has NO cache entry, that route could
 *    depend on a touched file in a way this map cannot see. (This is also
 *    what catches a brand-new page file that no load has parsed yet.)
 *    Storybook's routes — W5-3's `storyPages.ts`, the third producer — record
 *    their parses too, so the same rule applies to them and takes the same
 *    shape: a story FILE on disk that no cached story route claims widens,
 *    because it is either unparsed or produced no accepted story, and either
 *    way this map cannot speak for it.
 * 2b. **A touched STORY file widens.** Not for lack of dependency data — the
 *    story routes are in the map — but because a story frame can DISAPPEAR:
 *    `buildStoryRouteEntries` skips a story whose materialization degrades to
 *    nothing, which an edit to its file can cause and no page file can. That
 *    is a change of board shape, and this route only ever authorises a page
 *    patch. Everything else about a Storybook project now narrows: the common
 *    case, an edit to a component several stories render, names exactly those
 *    stories' pages.
 * 3. **A touched file no cached route claims widens.** This is the rule that
 *    covers `pageParseCache.ts`'s documented ONE-LEVEL-DEEP limitation: a
 *    component three levels down a nested composition appears in no route's
 *    recorded dependency set, so it produces no dependents and the whole
 *    request widens rather than reloading nothing. It also covers config
 *    files, stylesheets, and anything else outside the parse graph.
 * 4. **A cached route that is no longer discoverable widens.** Its page id
 *    cannot be derived any more (the page was deleted or renamed by the very
 *    edit that triggered this), which is a change of global board shape — a
 *    full reload's job, not a page patch's.
 *
 * The page→file mapping below deliberately MIRRORS
 * `server/ai/mcp/tools/studio/touchedPageIds.ts`'s `touchedFilesToPageIds`
 * rather than importing it: that file lives under `server/ai/mcp/tools/studio/`
 * (mcp-tooling's owned surface) and only imports FROM `server/handlers/`
 * today — importing it back from here would reverse that layering. Inlined
 * instead, with this cross-reference so the two don't silently drift.
 *
 * ## Never trusts the wire blindly
 *
 * `files` round-trips through the client (it read them off the `/save`
 * response's `touchedFiles`), so each entry is re-validated here with the
 * SAME adversarial-path guard `studioWriteback.ts` applies to a node id's
 * decoded location (`isWritableSourceRel`, exported from there for exactly
 * this reuse) before it is ever joined onto `dir`. Anything that fails is
 * treated as unmappable — narrows nothing, never widens the search, never
 * touches the filesystem with an unvalidated path.
 */
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { isWritableSourceRel } from '../studioWriteback'
import {
  discoverAppRouterRoutes,
  discoverPageFiles,
  projectPagesDir,
  projectsRootDir,
  resolveProjectDir,
} from '../studioProjects'
import { assignAppRouterPageIds, assignPageIds } from '../studioPageIds'
import { readStudioMeta, type StudioMeta } from './studioMeta'
import { storyFilesIn } from './storyDiscovery'
import { storyPageIdFromRoutePath } from './storyPages'
import { cachedRouteDependencies } from './pageParseCache'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/reload-scope'

/** `files` are workspace-ROOT-relative POSIX paths — the same convention a node id's decoded `rel` uses, and exactly what the `/save` response's `touchedFiles` field carries. */
const ReloadScopeBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  files: Type.Array(Type.String()),
})
export type ReloadScopeBody = Static<typeof ReloadScopeBodySchema>

/**
 * `pageId` for every route this project currently has, keyed by the same
 * `relPath` `studioPageLoad.ts` builds its parse-cache key from. Branches on
 * the cached `ProjectProfile.framework` exactly as `loadStudioPages` does —
 * never a guess — so the ids here are byte-identical to the ones a full load
 * would hand the client.
 */
function pageIdByRoutePath(meta: StudioMeta, pagesDir: string): Map<string, string> {
  if (meta.profile?.framework === 'next-app') {
    return assignAppRouterPageIds(discoverAppRouterRoutes(pagesDir))
  }
  return assignPageIds(discoverPageFiles(pagesDir))
}

/**
 * `null` means "not provably safe — widen to a full reload". A non-null
 * array (never empty when it's returned) names exactly the page ids the
 * caller should re-fetch via the existing `GET /load?pageIds=` filter.
 * See this module's doc for the four widening rules enforced below.
 */
function resolveNarrowReloadPageIds(dir: string, filesRelToDir: readonly string[]): string[] | null {
  if (filesRelToDir.length === 0) return null

  let pagesDir: string
  try {
    pagesDir = projectPagesDir(dir)
  } catch {
    return null // an escaping pagesDir override — nothing honest to map against
  }

  // Rule 1 — a cold cache has no dependency data to consult.
  const depsByRoutePath = cachedRouteDependencies(dir)
  if (!depsByRoutePath) return null

  const meta = readStudioMeta(dir)
  const storiesEnabled = meta.stories?.enabled !== false
  // The Storybook half of the map. A story route's cache key CARRIES its page
  // id (`storyPageIdFromRoutePath`), so the ids below stay byte-identical to a
  // full load's without re-running discovery — which would mean re-parsing
  // every story file to answer a question about which pages to reload.
  const storyRoutePaths = new Set<string>()
  const idByRoutePath = pageIdByRoutePath(meta, pagesDir)
  for (const routePath of depsByRoutePath.keys()) {
    const storyPageId = storyPageIdFromRoutePath(routePath)
    if (storyPageId === null) continue
    storyRoutePaths.add(routePath)
    // With stories turned off no story route exists any more, so a cache
    // entry left over from before the toggle names a page that is gone. It
    // stays OUT of the id map, so anything that depends on it hits rule 4's
    // "no page id for a cached route" branch and widens.
    if (storiesEnabled) idByRoutePath.set(routePath, storyPageId)
  }

  // Rule 2 — a route with no cache entry could depend on a touched file in a
  // way this map cannot see. Also how a brand-new, never-parsed page widens.
  for (const routePath of idByRoutePath.keys()) {
    if (!depsByRoutePath.has(routePath)) return null
  }

  const storyAbsFiles = new Set(
    storiesEnabled ? storyFilesIn(dir).map((relPath) => join(dir, ...relPath.split('/'))) : [],
  )
  if (storyAbsFiles.size > 0) {
    // Rule 2, stories: every story file on disk must be claimed by a cached
    // story route. One that isn't was never parsed in this process, or its
    // stories were all refused — the story-shaped version of "a discovered
    // route with no cache entry".
    const claimed = new Set<string>()
    for (const routePath of storyRoutePaths) {
      for (const depFile of depsByRoutePath.get(routePath) ?? []) claimed.add(depFile)
    }
    for (const storyFile of storyAbsFiles) {
      if (!claimed.has(storyFile)) return null
    }
  }

  const pageIds = new Set<string>()
  for (const relToDir of filesRelToDir) {
    // Never trust an unvalidated path into `join` — see this module's doc.
    if (!isWritableSourceRel(relToDir)) return null
    const absFile = join(dir, ...relToDir.split(/[\\/]+/))
    // Rule 2b — editing a story file can remove its frame entirely.
    if (storyAbsFiles.has(absFile)) return null
    let dependents = 0
    for (const [routePath, deps] of depsByRoutePath) {
      if (!deps.has(absFile)) continue
      dependents++
      const pageId = idByRoutePath.get(routePath)
      // Rule 4 — a cached route that no longer exists on disk. The board's
      // shape changed; that is a full reload's job, not a page patch's.
      if (!pageId) return null
      pageIds.add(pageId)
    }
    // Rule 3 — nothing claims this file: outside the parse graph, or deeper
    // than `pageParseCache.ts`'s one-level dependency tracking can see.
    if (dependents === 0) return null
  }

  return pageIds.size > 0 ? [...pageIds] : null
}

/** `POST /admin/api/studio/reload-scope` — see module doc for the full contract. */
export async function tryServeStudioReloadScope(req: Request, _url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'POST') return null

  try {
    const body = await readValidatedBody(req, ReloadScopeBodySchema)
    if (!body) return badRequest('invalid reload-scope body')
    const dir = resolveProjectDir(body.dir)
    if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

    const pageIds = resolveNarrowReloadPageIds(dir, body.files)
    return jsonResponse(pageIds ? { ok: true, narrow: true, pageIds } : { ok: true, narrow: false })
  } catch (err) {
    console.error('[studio:reloadScope]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
