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
import type { PendingStructuralOutcome } from '@site/studio/pendingStructuralOutcome'

/**
 * Fired on `window` after the editor reloads the site document (manual
 * save → reload, plugin install → reload). Subscribers re-fetch any
 * site-derived data they cache (admin shell site name + favicon,
 * Plugins page list, etc.).
 */
export const CMS_SITE_RELOAD_EVENT = 'cms-site-reload'

let cmsSiteReloadPending = false

/**
 * ERR-10 — a full reload is AWAITABLE, and it carries its own structural
 * outcome.
 *
 * It used to be a bare event: `resyncBoardAfterWrite` dispatched it and
 * returned, so `commitStructural` released `structuralCommitQueue.ts` before
 * `loadSite` had run and the next parked gesture planned against the pre-write
 * ids — the exact race the queue exists to close. And the write's outcome (what
 * to select, what ⌘Z does) rode a one-slot global box that any OTHER re-read
 * landing first could claim, against a tree that did not contain the write yet.
 *
 * Now every request gets a sequence number and a promise. The editor's reload
 * handler (`usePersistence.ts`) records the newest number when it STARTS
 * fetching; when that fetch is the one that lands, it claims every request up
 * to that number — applies their outcomes, in order, to the document it just
 * loaded — and settles them. A fetch that started later always covers
 * everything an earlier one did, which is why a superseded response can simply
 * be dropped.
 */
interface CmsSiteReloadRequest {
  seq: number
  structuralOutcome: PendingStructuralOutcome | null
  settle: () => void
}

let cmsSiteReloadSeq = 0
const outstandingReloads: CmsSiteReloadRequest[] = []
/** How many mounted editors answer reloads. With none, a request resolves at once — see `requestCmsSiteReload`. */
let cmsSiteReloaders = 0

export interface CmsSiteReloadOptions {
  /**
   * What the structural write that asked for this reload means for the board
   * once it is read back. Applied only by the reload that covers this request
   * — never by an unrelated one that happens to land first.
   */
  structuralOutcome?: PendingStructuralOutcome
}

/**
 * Request an editor-site reload and retain that request if the Site editor is
 * not mounted yet. Callers that mutate site-backed storage outside the editor
 * should use this helper instead of dispatching `CMS_SITE_RELOAD_EVENT`
 * directly.
 *
 * Resolves once a mounted editor has loaded a document fetched AFTER this
 * request (and applied `options.structuralOutcome` to it), or once that reload
 * failed — the failure is the reload handler's to report. Resolves at once
 * when no editor is mounted: the retained flag above replays the reload on
 * mount, and nobody is waiting on a board that is not there. Never rejects.
 */
export function requestCmsSiteReload(options: CmsSiteReloadOptions = {}): Promise<void> {
  cmsSiteReloadPending = true
  const seq = ++cmsSiteReloadSeq
  const done =
    cmsSiteReloaders > 0
      ? new Promise<void>((resolve) => {
          outstandingReloads.push({ seq, structuralOutcome: options.structuralOutcome ?? null, settle: resolve })
        })
      : Promise.resolve()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT))
  }
  return done
}

/**
 * The newest request number. A reload records it when it starts fetching: the
 * document it gets back reflects every write whose request is at or below it.
 */
export function latestCmsSiteReloadRequest(): number {
  return cmsSiteReloadSeq
}

/** What a landed reload claimed: the outcomes to apply to its document, in request order. */
export interface ClaimedCmsSiteReloads {
  structuralOutcomes: PendingStructuralOutcome[]
  /** Resolve every claimed request's promise. Call after the outcomes are applied. */
  settle: () => void
}

/** Claim every outstanding request numbered `upTo` or below. */
export function claimCmsSiteReloadRequests(upTo: number): ClaimedCmsSiteReloads {
  const claimed: CmsSiteReloadRequest[] = []
  for (let i = 0; i < outstandingReloads.length; ) {
    if (outstandingReloads[i]!.seq <= upTo) claimed.push(...outstandingReloads.splice(i, 1))
    else i++
  }
  return {
    structuralOutcomes: claimed.flatMap((request) => (request.structuralOutcome ? [request.structuralOutcome] : [])),
    settle: () => {
      for (const request of claimed) request.settle()
    },
  }
}

/**
 * Register a mounted editor that answers reloads. Returns the unregister; when
 * the last one goes, every request still waiting is settled — nothing is left
 * to answer it, and a structural commit awaiting it must not hold the queue.
 */
export function registerCmsSiteReloader(): () => void {
  cmsSiteReloaders++
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    cmsSiteReloaders--
    if (cmsSiteReloaders === 0) claimCmsSiteReloadRequests(Number.POSITIVE_INFINITY).settle()
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
  /**
   * What the structural write this patch re-reads means for the board — the
   * narrow counterpart of `CmsSiteReloadOptions.structuralOutcome`. Travels
   * WITH the pages it describes, so no other re-read can claim it.
   */
  structuralOutcome?: PendingStructuralOutcome
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
