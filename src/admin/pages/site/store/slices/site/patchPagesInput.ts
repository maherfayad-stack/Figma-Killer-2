/**
 * The input to `SiteSlice.patchPages`, split out of `types.ts` (which sits at
 * the module-size ceiling) and re-exported from there so the slice keeps one
 * front door.
 */
import type { ConditionDef, Page, StyleRule } from '@core/page-tree'

/** Input to `SiteSlice.patchPages` — see that method's doc for the full contract. */
export interface PatchPagesInput {
  /** Freshly re-parsed pages that still exist — upserted by id, appended if new. */
  pages: Page[]
  /** Ids that were part of the touched set but no longer resolve to a page. */
  removedPageIds?: string[]
  /**
   * The project-wide style registry the same reload recomputed.
   *
   * NOT optional-because-nice-to-have: a re-parsed page's `classIds` name
   * rules from the registry that was computed WITH it, and rendering it
   * against the previous one resolves those nodes to no class at all — an
   * unstyled, collapsed page that looks broken until a manual refresh.
   * Omitted only by a caller that genuinely has no fresher registry (a test,
   * or a patch that never re-read the project), in which case the current one
   * stands.
   */
  styleRules?: Record<string, StyleRule>
  /** The project-wide condition set from the same reload — same contract as `styleRules`. */
  conditions?: ConditionDef[]
}
