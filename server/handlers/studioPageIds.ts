/**
 * studioPageIds — deriving a page's stable id and slug from where its file
 * lives.
 *
 * Split out of `studioPageLoad.ts` (which sat exactly at the 700-line
 * module-size ceiling) because this is a genuinely separate reason to change:
 * these four functions are PURE string derivation over paths and routes, with
 * no filesystem, no parser, and no knowledge of the load pipeline that calls
 * them. They change when the id/slug NAMING rules change; `studioPageLoad.ts`
 * changes when the loading pipeline does.
 *
 * Two framework conventions live here side by side, and the difference is the
 * whole point — see `assignAppRouterPageIds` for why App Router cannot use the
 * generic file-path derivation.
 */
import type { AppRouterRoute } from './studioProjects'

/**
 * Derive a stable page id (also used as the slug) from a page file's path,
 * relative to the workspace's `pages/` dir — kebab-casing every path segment
 * and joining with `-` so nested files don't collide with a differently-
 * nested one that merely shares a basename: "Home.tsx" -> "home",
 * "MyPage.tsx" -> "my-page", "marketing/Landing.tsx" -> "marketing-landing".
 * Pure so it's unit-testable without touching the filesystem.
 *
 * Two DIFFERENT relPaths can still slugify to the same string (e.g.
 * "Marketing/Landing.tsx" and "marketing-landing.tsx" both ->
 * "marketing-landing") — `assignPageIds` is the layer that guarantees
 * uniqueness across a whole discovered set; this function only derives the
 * per-path slug.
 */
export function pageIdFromRelPath(relPath: string): string {
  const segments = relPath.split('/').filter((segment) => segment.length > 0)
  const slug = segments
    .map((segment, i) => {
      const base = i === segments.length - 1 ? segment.replace(/\.(tsx|jsx)$/, '') : segment
      return base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    })
    .filter((segment) => segment.length > 0)
    .join('-')
  return slug.length > 0 ? slug : 'page'
}

/**
 * Assigns a unique pageId (also used as the slug) to each entry of
 * `relPaths`, processed in the given order. `pageIdFromRelPath` is
 * deterministic per path, but two different nested paths can slugify to the
 * same string (see its doc comment) — on a collision, every path after the
 * first gets a numeric suffix (`-2`, `-3`, …), so ids stay unique for a given
 * input ordering. Pure; callers get reproducible ids by passing a
 * consistently-ordered list (`discoverPageFiles` already returns sorted paths).
 */
export function assignPageIds(relPaths: readonly string[]): Map<string, string> {
  const seenCounts = new Map<string, number>()
  const assigned = new Map<string, string>()
  for (const relPath of relPaths) {
    const base = pageIdFromRelPath(relPath)
    const seen = seenCounts.get(base) ?? 0
    seenCounts.set(base, seen + 1)
    assigned.set(relPath, seen === 0 ? base : `${base}-${seen + 1}`)
  }
  return assigned
}

/**
 * Assigns each App Router route its page id: the ROUTE ITSELF
 * (`app/(marketing)/pricing/page.tsx` -> `/pricing`), not the generic
 * kebab-cased file-path id `assignPageIds` derives for every other
 * framework — which for App Router would slug EVERY route to end in
 * `-page` (the file is always literally named `page.tsx`) and would embed a
 * route group's parens as if they were a real path segment.
 *
 * Two route FILES legitimately deriving the SAME route is not something a
 * real Next.js build would allow, but an imported/hand-edited repo might
 * still have it (e.g. two route groups both defining `/pricing`) — collision
 * gets the same numeric-suffix dedupe `assignPageIds` uses, so ids stay
 * unique for whatever `discoverAppRouterRoutes` returns.
 */
export function assignAppRouterPageIds(routes: readonly AppRouterRoute[]): Map<string, string> {
  const seenCounts = new Map<string, number>()
  const assigned = new Map<string, string>()
  for (const { relPath, route } of routes) {
    const seen = seenCounts.get(route) ?? 0
    seenCounts.set(route, seen + 1)
    assigned.set(relPath, seen === 0 ? route : `${route}-${seen + 1}`)
  }
  return assigned
}

/**
 * A URL-safe form of a derived route, for `Page.slug` (documented as
 * "URL-safe" in `page.ts`) — the route itself carries `/`, `:`, and `*`, none
 * of which belong in a slug. `/` (the root route) becomes `'home'`, matching
 * the same fallback `pageIdFromRelPath` uses when a path slugs to nothing.
 */
export function slugFromAppRoute(route: string): string {
  const slug = route.replace(/^\//, '').replace(/\//g, '-').replace(/[:*]/g, '')
  return slug.length > 0 ? slug : 'home'
}
