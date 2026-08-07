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
 * ## When a single-file reload is sufficient, and when it is not
 *
 * A touched file is safe to reload narrowly only when BOTH hold:
 *
 * 1. **It IS a page's own top-level route file** (found verbatim in
 *    `discoverPageFiles(pagesDir)`, mapped through the SAME `assignPageIds`
 *    every full load uses). A file that is instead a LOCAL COMPONENT
 *    `inlineLocalComponents` spliced into one or more pages, or (App Router)
 *    a `layout.tsx` composed into several routes, never appears in that list
 *    — so it fails this check automatically and always widens. This is the
 *    common shape of "a change in one file can alter another file's parsed
 *    output when a local component is inlined into a page": component files
 *    live outside `pages/` in every real corpus this codebase has seen, so
 *    requiring an EXACT page-file match already excludes them.
 * 2. **No OTHER route's last-known parse depends on the same file.** Case 1
 *    catches the common shape of sharing; this catches the pathological one
 *    it can't — a page file that ALSO happens to be imported as a local
 *    component by some OTHER page. `pageParseCache.ts` already records, per
 *    route, the absolute-path set of every file that route's own parse
 *    depended on (its own file plus its resolved local-component sources —
 *    see that module's "one level deep" limitation, inherited here
 *    unchanged). `anyOtherRouteDependsOnFile` queries that recorded set
 *    directly — no new bookkeeping, no re-parse. A COLD cache (nothing has
 *    parsed this project in this server process yet) has no data to answer
 *    with, so it is treated the same as "found a dependency": widen. Never
 *    guess "probably fine" from an absent cache entry.
 *
 * App Router projects are out of scope for the narrow path entirely and
 * always widen: `discoverPageFiles`/`assignPageIds` (standard-framework page
 * ids) has nothing to do with App Router's route-derived id scheme
 * (`buildAppRouterPageEntries`), so a touched `page.tsx`/`layout.tsx` simply
 * never matches step 1's page-file list. Correct and safe, just not
 * optimized for that framework yet — same accepted scope boundary
 * `server/ai/mcp/tools/studio/touchedPageIds.ts`'s own doc states for the
 * MCP live-reload push. The page→file mapping logic below deliberately
 * MIRRORS that module's `touchedFilesToPageIds` rather than importing it:
 * that file lives under `server/ai/mcp/tools/studio/` (mcp-tooling's owned
 * surface) and only imports FROM `server/handlers/` today — importing it
 * back from here would reverse that layering. Inlined instead, the same
 * "don't import across the boundary, cross-reference in a comment so the two
 * don't silently drift" call `store-engineer` made for
 * `selectionSlice.ts`/`findNodeById.ts` in this same session.
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
import { join, relative, sep } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { isWritableSourceRel } from '../studioWriteback'
import { discoverPageFiles, projectPagesDir, projectsRootDir, resolveProjectDir } from '../studioProjects'
import { assignPageIds } from '../studioPageIds'
import { readStudioMeta } from './studioMeta'
import { anyOtherRouteDependsOnFile } from './pageParseCache'
import { isRealpathContained } from './workspacePackageResolve'

const ROUTE_PATH = '/admin/api/studio/reload-scope'

/** `files` are workspace-ROOT-relative POSIX paths — the same convention a node id's decoded `rel` uses, and exactly what the `/save` response's `touchedFiles` field carries. */
const ReloadScopeBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  files: Type.Array(Type.String()),
})
export type ReloadScopeBody = Static<typeof ReloadScopeBodySchema>

/**
 * `null` means "not provably safe — widen to a full reload". A non-null
 * array (never empty when it's returned) names exactly the page ids the
 * caller should re-fetch via the existing `GET /load?pageIds=` filter.
 */
function resolveNarrowReloadPageIds(dir: string, filesRelToDir: readonly string[]): string[] | null {
  if (filesRelToDir.length === 0) return null

  // App Router page ids come from ROUTES, not `discoverPageFiles`'s generic
  // file scheme — see this module's doc for why that always widens here.
  const framework = readStudioMeta(dir).profile?.framework
  if (framework === 'next-app') return null

  let pagesDir: string
  try {
    pagesDir = projectPagesDir(dir)
  } catch {
    return null // an escaping pagesDir override — nothing honest to map against
  }

  const relPaths = discoverPageFiles(pagesDir)
  const idByRelPath = assignPageIds(relPaths)
  const relPathSet = new Set(relPaths)

  const pageIds = new Set<string>()
  const ownCacheKeys = new Set<string>()
  const absFiles: string[] = []
  for (const relToDir of filesRelToDir) {
    // Never trust an unvalidated path into `join` — see this module's doc.
    if (!isWritableSourceRel(relToDir)) return null
    const absFile = join(dir, ...relToDir.split(/[\\/]+/))
    const relToPagesDir = relative(pagesDir, absFile).split(sep).join('/')
    // Not a page's own file at all (a local component, a layout, anything
    // else) — the common shape of "shared", always widens.
    if (!relPathSet.has(relToPagesDir)) return null
    const pageId = idByRelPath.get(relToPagesDir)
    if (!pageId) return null
    pageIds.add(pageId)
    ownCacheKeys.add(`${dir}::${relToPagesDir}`)
    absFiles.push(absFile)
  }

  // The pathological shape: this file IS a page's own route file, but some
  // OTHER route also depends on it (imported it as a local component, or —
  // in principle — shares it some other way `inlineLocalComponents` tracked).
  // `false` is the only value that keeps the narrow path; `true` (found a
  // dependent) and `null` (no cache data to consult) both widen.
  for (const absFile of absFiles) {
    if (anyOtherRouteDependsOnFile(dir, absFile, ownCacheKeys) !== false) return null
  }

  return [...pageIds]
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
