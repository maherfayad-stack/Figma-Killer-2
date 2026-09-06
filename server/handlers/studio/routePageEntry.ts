/**
 * routePageEntry — the one shape every page SOURCE produces, whatever produced
 * it, so `studioPageLoad.ts`'s style-collection + convert tail operates over a
 * single list.
 *
 * Extracted from `studioPageLoad.ts` (where it started as a private interface)
 * when Storybook stories became a second producer alongside file-per-page and
 * Next App Router routes: `storyPages.ts` builds these too, and having it
 * import the type from the module that also imports IT would be a cycle
 * `no-circular-dependencies.test.ts` exists to catch. A pure type leaf both
 * sides depend on keeps the graph one-directional — the same arrangement
 * `@core/framework-schema` uses for its two dependents.
 */
import type { ComponentSource, ParsedPage } from '@core/page-parser'

/** One route's worth of parsed content, whatever framework (or story file) produced it. */
export interface RoutePageEntry {
  expanded: ParsedPage
  pageId: string
  slug: string
  title: string
  /**
   * The route's OWN file, workspace-relative POSIX — `collectPageStylesheets`'s
   * "page first" anchor. A composed route's layout files still contribute their
   * own CSS, discovered from their nodes' own `loc.file` (see that module's doc).
   */
  relFile: string
  componentSources: Record<string, ComponentSource>
}
