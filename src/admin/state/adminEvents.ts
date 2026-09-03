/**
 * Admin-wide DOM custom events.
 *
 * Kept in a dedicated module so importers don't transitively pull in the
 * heavy modules that *dispatch* / *listen* to these events. In particular,
 * the editor's `usePersistence` hook (~6 KB chunk, drags the full editor
 * store) used to own `CMS_SITE_RELOAD_EVENT` — any plugin-side code that
 * just wanted to dispatch the event would import usePersistence and end
 * up bundling the editor store into the non-editor admin graph.
 *
 * Adding new admin-wide event constants? Put them here, then have both
 * dispatchers and listeners import from this module. A `import type`-only
 * reference to a `@core/*` type (e.g. `Page` below) is fine and doesn't
 * reintroduce the bundling concern above — it is erased at compile time;
 * the concern is VALUE imports of heavy modules like `usePersistence` itself.
 */
import type { ConditionDef, Page, StyleRule } from '@core/page-tree'

/**
 * Fired on `window` after the editor reloads the site document (manual
 * save → reload, plugin install → reload). Subscribers re-fetch any
 * site-derived data they cache (admin shell site name + favicon,
 * Plugins page list, etc.).
 */
export const CMS_SITE_RELOAD_EVENT = 'cms-site-reload'

let cmsSiteReloadPending = false

/**
 * Request an editor-site reload and retain that request if the Site editor is
 * not mounted yet. Callers that mutate site-backed storage outside the editor
 * should use this helper instead of dispatching `CMS_SITE_RELOAD_EVENT`
 * directly.
 */
export function requestCmsSiteReload(): void {
  cmsSiteReloadPending = true
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT))
  }
}

export function hasPendingCmsSiteReload(): boolean {
  return cmsSiteReloadPending
}

export function consumePendingCmsSiteReload(): boolean {
  if (!cmsSiteReloadPending) return false
  cmsSiteReloadPending = false
  return true
}

/**
 * Fired on `window` after a TARGETED (single/few-page) source writeback —
 * `commitStructural`'s narrow-reload path (`STUDIO-FIGMA-PARITY-PLAN.md`
 * Track C5) — carrying the ALREADY-FETCHED replacement pages, so the
 * listener only has to hand them to the store's `patchPages` rather than
 * re-fetch anything itself.
 *
 * Distinct from `CMS_SITE_RELOAD_EVENT`: that one is a bare signal ("something
 * changed, go re-fetch everything") several unrelated subscribers listen for
 * (site name/favicon, board geometry, the full document). This one carries
 * data for exactly one consumer (the editor store's `patchPages`) and is a
 * pure no-op — never retained, unlike a pending `requestCmsSiteReload()` —
 * when no editor is mounted: a narrow patch is only ever correct against the
 * LIVE, in-memory tree it was diffed against, so there is nothing honest to
 * replay later if nobody was there to receive it.
 *
 * Lives here rather than in `studioSaveRequests.ts`/`fsCodemodAdapter.ts`
 * (which fire it) for the exact reason `requestCmsSiteReload` does: those
 * files are reachable from `store/slices/site/nodeActions.ts`, which is part
 * of the store's OWN build graph — importing `useEditorStore` there directly
 * would close a `store.ts -> nodeActions.ts -> studioSaveRequests.ts ->
 * store.ts` cycle. `usePersistence.ts` (which already has store access) is
 * the one listener that turns this into a `patchPages` call.
 */
export const CMS_SITE_PAGES_PATCH_EVENT = 'cms-site-pages-patch'

export interface CmsSitePagesPatchDetail {
  pages: Page[]
  removedPageIds: string[]
  /** The project-wide style registry from the same reload — forwarded to `patchPages`, which needs it to render the new pages against the stylesheet they were parsed with. */
  styleRules?: Record<string, StyleRule>
  /** The project-wide condition set from the same reload. */
  conditions?: ConditionDef[]
}

/** Dispatches `CMS_SITE_PAGES_PATCH_EVENT`. No-op (and nothing retained) outside a browser or when nothing is listening — see this event's own doc for why, unlike `requestCmsSiteReload`, there is no "pending" fallback. */
export function dispatchCmsSitePagesPatch(detail: CmsSitePagesPatchDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CMS_SITE_PAGES_PATCH_EVENT, { detail }))
}

/**
 * Fired after a CMS-exported SiteBundle has been imported successfully through
 * the global Site Import modal. Data/content views that cache table or row
 * lists should refresh when they are mounted.
 */
export const CMS_SITE_BUNDLE_IMPORTED_EVENT = 'cms-site-bundle-imported'

/**
 * Fired on `window` to ask the mounted Site editor to persist the current draft
 * immediately, bypassing the autosave debounce. Used by deliberate, discrete
 * save actions (e.g. "Save as layout") so the change is written to storage at
 * the moment the user takes the action — instead of waiting for the autosave
 * timer, which is dropped entirely if the user navigates away from the editor
 * before it fires. `usePersistence` listens and runs its normal save pipeline.
 */
export const EDITOR_SAVE_REQUEST_EVENT = 'editor-save-request'

/**
 * Request an immediate editor-draft save. No-op when no editor is mounted (the
 * change still rides the next save the way any other unsaved edit would).
 */
export function requestEditorSave(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(EDITOR_SAVE_REQUEST_EVENT))
  }
}

/**
 * Fired on `window` after `.studio/trash/` changed — a page was moved in, an
 * entry was restored, or the trash was purged.
 *
 * The explorer's Trash section re-READS the server on this signal rather than
 * receiving the new state in the event's detail. The trash is a directory on
 * disk that an agent turn, a second tab, or the user's own editor can change
 * at any time, so a payload here would only ever be one writer's guess at what
 * the trash now holds. The event says "it moved", never "it is now this".
 */
export const STUDIO_TRASH_CHANGED_EVENT = 'studio-trash-changed'

/** Tell every mounted Trash section to re-read `.studio/trash/`. */
export function notifyStudioTrashChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(STUDIO_TRASH_CHANGED_EVENT))
  }
}
