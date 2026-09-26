/**
 * studioProjectLoad — reading a whole Studio project into the editor: the
 * `loadSite` half of `fsCodemodAdapter.ts`, and every per-load value the rest
 * of the canvas reads back from "the last load".
 *
 * One request carries the project: `GET /admin/api/studio/load?stream=1`, an
 * NDJSON stream of one `meta` line (the project-wide registries and the list of
 * pages to come) and then one line per page, the frames a person sees first,
 * first (`studioLoadResponse.ts`, `loadPriority.ts`). The sidecar settings
 * (`sidecarSync.ts`) are read beside it — they need nothing from the load, and
 * opening a project used to wait for the two one after the other — and the
 * token extraction runs after it, unwaited (`adoptExtractedTokens`).
 *
 * ## Streamed (P6-B, PERF-7)
 *
 * Given `options.progress`, the document is handed over BEFORE the stream
 * ends: `progress.open` as soon as the meta line, the sidecar settings and
 * the page the editor opens on (the home page, else the first page — the one
 * `loadSite` would pick) are in; then `progress.pages` for each later batch,
 * one per network chunk (a microtask after the chunk's lines, never a timer or
 * an animation frame, which a hidden tab would stall). What arrived is painted
 * while the rest is still on the wire. The promise resolves with the whole
 * document, in page order, after the last batch.
 *
 * Without `progress` (every re-read of a project already on the board) it
 * resolves once, with the whole document, as it always did.
 *
 * Each later batch gets what the first delivery got from the store and from
 * this module: the framework class-id rewrite `loadSite` ran on the open
 * document (`reconcileFrameworkClassesOnPages`, against the registry AS
 * LOADED, since the store's copy has been claimed and pruned by then) and the
 * save-diff baseline (`mergeLoadedValuesBaseline`).
 */
import type { Page, SiteDocument, StyleRule } from '@core/page-tree'
import type { LoadSiteOptions, PendingPage, SiteLoadProgress } from '@core/persistence/types'
import { ndjsonRequest } from '@core/http'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { reconcileFrameworkClassesOnPages } from '@site/store/slices/site/framework/reconcile'
import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { applySidecarSettings, armSidecarBaselines, fetchSidecarSettings, noteFrameworkSynced, type SidecarSettings } from './sidecarSync'
import { getStudioWorkspaceDir, setStudioLoadedDir, studioWriteDir } from './studioWorkspaceDir'
import { fetchExtractedTokens, type TokenExtractionStatus } from './studioTokenStatus'
import { setStudioProjectKey, setStudioTrustTier } from './studioProjectTrust'
import {
  orderStreamedPages,
  StudioLoadStreamLineSchema,
  type ComponentSource,
  type StreamedPageEntry,
  type StudioLoadStreamLine,
} from './studioLoadStreamSchema'
import { mergeLoadedValuesBaseline, resetLoadedValues } from './loadedValuesBaseline'
import { watchOpenPageForCssDestination } from './openPageWatch'
import { resetRefusalToasts } from './refusalToasts'
import { resetCssDestinationMemory, setStudioStyleRuleSources } from './styleRuleWriteback'
import { resetLocalizedTextBaseline, watchLocalizedPagesForBaseline } from './localizedPageWriteback'
import { setStudioAuthoredCss, setStudioVendorCss } from './studioRawCssStores'
import { setStudioLoadWarnings } from './studioLoadWarningsStore'

/** Performance-timeline mark: the first page line of a load has been read (P6-B; `tests/e2e/studio-board-load.e2e.ts`). */
export const STUDIO_LOAD_FIRST_PAGE_MARK = 'studio:load:first-page'

type MetaLine = Extract<StudioLoadStreamLine, { kind: 'meta' }>
type PageLine = Extract<StudioLoadStreamLine, { kind: 'page' }>

/** A load that carried no `canvasLayers` (a CMS load): the free canvas is empty. */
const NO_CANVAS_LAYERS: readonly never[] = []

/**
 * Remembered from the last load — local-vs-package classification for every
 * `kind: 'component'` node in the workspace, keyed by node id. Consumed by
 * future inspector/property-panel UI that needs to tell a local (editable)
 * component apart from a read-only npm-package one (Phase 7A only resolves
 * and classifies; rendering local components as their own editable canvas
 * modules is deferred — see V1-CANVAS-PLAN.md's Phase 7A backlog note).
 */
let componentSources: Record<string, ComponentSource> = {}

/** WS-3.3 — `.studio/meta.json`'s `paletteHiddenModuleIds` override, from the last load. See `getStudioComponentSources` for the same "remembered from last load" shape. */
let paletteHiddenModuleIds: readonly string[] = []

/** The project the stylesheet-destination memory (`resetCssDestinationMemory`) belongs to. */
let cssDestinationMemoryDir: string | null = null

/** The current workspace's local-vs-package classification for every component node, from the last load. */
export function getStudioComponentSources(): Record<string, ComponentSource> {
  return componentSources
}

/** WS-3.3 — the current project's `paletteHiddenModuleIds` override, from the last load. */
export function getStudioPaletteHiddenModuleIds(): readonly string[] {
  return paletteHiddenModuleIds
}

/**
 * `tokens-01` — re-runs server-side token extraction for the CURRENTLY
 * loaded project (`studioTokenStatus.ts`'s `fetchExtractedTokens` does the
 * actual fetch + status-store update) and applies the result to the LIVE
 * document (`applyExtractedFrameworkTokens` — undo-able). This is the
 * Framework panel's "Re-scan tokens" action; a load runs the same extraction
 * itself (`extractTokensForLoad`) because it has no live document yet to
 * apply the result to. Throws `ApiError` on failure so the caller can toast.
 */
export async function refreshExtractedTokens(): Promise<TokenExtractionStatus> {
  const dir = studioWriteDir()
  if (dir === null) throw new Error('[studioProjectLoad] refreshExtractedTokens called before a project loaded')
  const { framework, status } = await fetchExtractedTokens(dir)
  useEditorStore.getState().applyExtractedFrameworkTokens(framework)
  noteFrameworkSynced(framework)
  return status
}

/**
 * `tokens-01` — the project's OWN design tokens (`:root` custom properties, a
 * Tailwind theme, or a vendor design-system package's CSS — see
 * `tokenExtract.ts`), merged into what `.studio/framework.json` holds. Runs
 * every load: the server's merge only ever fills a currently-EMPTY family, so
 * this is a no-op once populated (by extraction or by the user), and a project
 * whose tokens only became reachable later — e.g. after "Install dependencies"
 * resolves a vendor CSS import — picks them up on the very next load.
 *
 * P6-B — AFTER the load, and never waited for. The extraction costs the server
 * 150–600 ms on every open (measured: 150–180 ms on the 40-page board, 550–590
 * on a 1,000-file repo), and run beside `/load` it held the load's first byte
 * back by as much. The document opens on the sidecar's framework — the result
 * of every previous extraction, persisted — and the merged answer is adopted
 * when it lands: a no-op unless a family was empty and is not any more (the
 * first open of an imported project), and skipped if the person has already
 * changed the framework themselves (`adoptLoadedFramework`). A failure is
 * logged: the project is open either way.
 */
function adoptExtractedTokens(dir: string, loaded: SiteDocument['settings']['framework']): void {
  fetchExtractedTokens(dir).then(
    ({ framework }) => {
      // A different project was opened while this one's extraction ran.
      if (studioWriteDir() !== dir) return
      if (useEditorStore.getState().adoptLoadedFramework(loaded, framework)) noteFrameworkSynced(framework)
    },
    (err: unknown) => {
      console.error('[studioProjectLoad] token extraction failed', err)
    },
  )
}

/**
 * Every per-load store and module-level baseline a load sets from its meta
 * line and its pages. A streamed load calls it once, with the pages that have
 * arrived by `progress.open`; a later batch only extends the save-diff
 * baseline (`mergeLoadedValuesBaseline`), the one piece keyed by node.
 */
function applyLoadMeta(meta: MetaLine, pages: readonly Page[]): void {
  const { dir } = meta
  // ERR-14 — the automatic stylesheet choices are this project's; a load of
  // a DIFFERENT project starts without them (a resync keeps them).
  const sameProject = dir === cssDestinationMemoryDir
  if (!sameProject) resetCssDestinationMemory()
  cssDestinationMemoryDir = dir
  setStudioLoadedDir(dir)
  componentSources = meta.componentSources
  paletteHiddenModuleIds = meta.paletteHiddenModuleIds
  setStudioVendorCss(meta.vendorCss)
  setStudioAuthoredCss(meta.authoredCss)
  setStudioLoadWarnings(meta.warnings)
  setStudioTrustTier(meta.trust)
  setStudioProjectKey(meta.projectKey ?? null)
  // Baseline for the save-time diff — see `loadedValuesBaseline.ts`. A
  // re-read of the project already open keeps the baseline it replaces, so
  // the store can rebase the user's unsaved edits onto these pages (ERR-9).
  resetLoadedValues(pages, { sameProject })
  // `style-02` — a fresh document is a fresh set of refusals to report.
  resetRefusalToasts()
  // `panel-02` (WS-6.3) — the CSS write-back map + its diff baseline.
  // `pages` feeds `buildClassPageIndex`, which is how a new class gets
  // co-located with the page it is used on (`style-02`). A streamed load's
  // first pages are enough: the index only serves an editor-authored rule
  // with no file yet, and a load has none.
  setStudioStyleRuleSources(meta.styleRuleSources, meta.styleRules, { pages, styledSources: meta.styledStyleRuleSources })
  // Z8 — and which page is OPEN, the anchor for a class that is on no
  // element yet. Idempotent; see `openPageWatch.ts`.
  watchOpenPageForCssDestination(pages)
  // WS-10 §4.4 (Phase 4) — a fresh project load (or a `requestCmsSiteReload()`
  // re-load) must not carry a locale-variant page, or its writeback
  // baseline, over from whatever project was open before: `pageId` is only
  // unique WITHIN one project, so a stale entry could silently suppress or
  // misdirect a real diff in the new one. `watchLocalizedPagesForBaseline`
  // is idempotent — safe to call on every load, only subscribes once.
  useEditorStore.getState().resetLocalizedPages()
  // P5-G — the free canvas's loose layers, kept apart from `site.pages` by
  // construction (`canvasLayerSlice.ts`): they never enter the document.
  useEditorStore.getState().setCanvasLayers(meta.canvasLayers ?? NO_CANVAS_LAYERS)
  resetLocalizedTextBaseline()
  watchLocalizedPagesForBaseline()
  // Distinct from `site.name` (the "Studio" product wordmark, unchanged per
  // project) — this is the per-project display name shown under the brand
  // in the toolbar (see Toolbar.tsx's StudioProjectLabel).
  useAdminUi.getState().setStudioProject({ dir, name: meta.projectName })
}

/** The document a load hands over: the source-derived pages in a valid default site shell (breakpoints, settings, framework, …). */
function buildLoadedSite(meta: MetaLine, pages: Page[], sidecar: SidecarSettings): SiteDocument {
  const site = createDefaultSiteDocument('Studio')
  site.pages = pages
  // §6 — styling imported from the workspace's `.css` files, re-derived
  // from disk on every load. `panel-02` (WS-6.3) — an edit to a rule
  // mapped in `styleRuleSources` now reaches disk on the next `saveSite`;
  // an edit to an unmapped rule (Tailwind/Sass/PostCSS output, a CSS
  // Modules compile) still only lives in-memory until reload — see
  // `studioCss.ts`'s "Write-back mapping" doc and `StyleTargetChip`, which
  // states which tier a given class is in.
  site.styleRules = meta.styleRules
  site.conditions = meta.conditions
  // Override the default shell's framework tokens + font library with
  // whatever this project has persisted in `.studio/`, if anything. See
  // `sidecarSync.ts` — nothing persisted means the default stands as-is.
  applySidecarSettings(site, sidecar)
  armSidecarBaselines(site)
  return site
}

/** The page the editor opens on, which the first delivery waits for: the home page, else the first page. Mirrors `loadSite`'s own pick. */
function openingPageId(pageList: readonly StreamedPageEntry[]): string | undefined {
  return (pageList.find((page) => page.slug === 'index') ?? pageList[0])?.id
}

function byPageOrder(a: PageLine, b: PageLine): number {
  return a.index - b.index
}

/** What a load has received so far. A holder, not locals: the stream's callbacks fill it in. */
interface Received {
  meta: MetaLine | null
  /** Every page line so far, in arrival order. Only ever appended to. */
  lines: PageLine[]
  sidecar: Promise<SidecarSettings>
}

/** `fsCodemodAdapter.loadSite` — see this module's doc. */
export async function loadStudioProject({ signal, progress }: LoadSiteOptions = {}): Promise<SiteDocument> {
  // The active project is a subfolder of studio-workspace/ (hand-authored or
  // GitHub-imported) — see studioWorkspaceDir's doc comment for why every
  // studio client call must agree on the same active dir.
  const overrideDir = getStudioWorkspaceDir()
  const received: Received = {
    meta: null,
    lines: [],
    sidecar: fetchSidecarSettings(overrideDir ?? null),
  }
  // Observed here, re-raised where it is awaited.
  received.sidecar.catch(() => {})
  const stream = progress ? streamDelivery(progress, received) : null

  await ndjsonRequest('/admin/api/studio/load', {
    lineSchema: StudioLoadStreamLineSchema,
    query: { ...(overrideDir ? { dir: overrideDir } : {}), stream: 1 },
    signal,
    onLine: (line) => {
      if (line.kind === 'meta') {
        received.meta = line
        return
      }
      received.lines.push(line)
      if (received.lines.length === 1) performance.mark(STUDIO_LOAD_FIRST_PAGE_MARK)
      stream?.arrived()
    },
  })
  const { meta } = received
  if (!meta) throw new Error('Studio load stream produced no metadata line.')
  // Lines arrive in viewport order; the document keeps page order.
  const pages = orderStreamedPages(received.lines)
  let site: SiteDocument
  if (stream) {
    site = await stream.finish(pages)
  } else {
    const sidecar = await received.sidecar
    applyLoadMeta(meta, pages)
    site = buildLoadedSite(meta, pages, sidecar)
  }
  // Last, and not awaited: every page has been handed over by now.
  adoptExtractedTokens(meta.dir, site.settings.framework)
  return site
}

/** Where a streamed load is: what it has handed over, and what is in flight. */
interface Delivery {
  /** The document handed to `progress.open`, once it has been. */
  site: SiteDocument | null
  /** The registry as the load delivered it — the store claims and prunes its own copy (`reconcileFrameworkClassesOnPages`). */
  loadedStyleRules: Record<string, StyleRule>
  /** How many of `received.lines` have been handed over — always a prefix, since lines are only appended. */
  delivered: number
  opening: Promise<void> | null
  failure: { error: unknown } | null
  queued: boolean
  ended: boolean
}

/**
 * The streamed half of {@link loadStudioProject}: hands `progress` the
 * document, then each batch, as the lines come in. `arrived` is called after
 * each page line; `finish` once the stream has ended.
 */
function streamDelivery(progress: SiteLoadProgress, received: Received) {
  const state: Delivery = { site: null, loadedStyleRules: {}, delivered: 0, opening: null, failure: null, queued: false, ended: false }

  const open = (meta: MetaLine): void => {
    const batch = received.lines.slice(0).sort(byPageOrder)
    state.delivered = batch.length
    const opening = (async () => {
      const settings = await received.sidecar
      const pages = batch.map((line) => line.page)
      applyLoadMeta(meta, pages)
      // Copied BEFORE `open`: the store reconciles the document's registry in place.
      state.loadedStyleRules = { ...meta.styleRules }
      const site = buildLoadedSite(meta, pages, settings)
      state.site = site
      const arrivedIds = new Set(pages.map((page) => page.id))
      const pending: PendingPage[] = meta.pageList
        .filter((page) => !arrivedIds.has(page.id))
        .map(({ id, title }) => ({ id, title }))
      progress.open(site, pending)
    })()
    state.opening = opening
    opening.then(
      () => {
        state.opening = null
        schedule()
      },
      (error: unknown) => {
        state.opening = null
        state.failure = { error }
      },
    )
  }

  const deliver = (): void => {
    state.queued = false
    const { meta } = received
    if (state.opening || state.failure || !meta) return
    const { site } = state
    if (!site) {
      const first = openingPageId(meta.pageList)
      if (state.ended || (first !== undefined && received.lines.some((line) => line.page.id === first))) open(meta)
      return
    }
    if (state.delivered === received.lines.length) return
    const pages = received.lines.slice(state.delivered).sort(byPageOrder).map((line) => line.page)
    state.delivered = received.lines.length
    // Same order as the first delivery: the baseline is taken from the pages
    // as read (`applyLoadMeta`), THEN the store-side rewrite runs (`loadSite`).
    mergeLoadedValuesBaseline(pages)
    reconcileFrameworkClassesOnPages(pages, state.loadedStyleRules, site.settings.framework)
    progress.pages(pages)
  }

  const schedule = (): void => {
    if (state.queued) return
    state.queued = true
    queueMicrotask(deliver)
  }

  return {
    arrived: schedule,
    async finish(pages: Page[]): Promise<SiteDocument> {
      state.ended = true
      deliver()
      while (state.opening) await state.opening.catch(() => {})
      if (state.failure) throw state.failure.error
      deliver()
      if (!state.site) throw new Error('[studioProjectLoad] the load stream ended without opening the document')
      // Z8 — the open page's file, now that every page is here to resolve it against.
      watchOpenPageForCssDestination(pages)
      return { ...state.site, pages }
    },
  }
}
