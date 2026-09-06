/**
 * studioLiveReloadFetch — the read half of every targeted reload.
 *
 * Fetches ONLY the named pages via the `?stream=1&pageIds=` filtered load
 * `loadSite` itself supports (`studioLoadStreamSchema.ts`), instead of a full
 * `loadSite()` re-read of the whole project. Two callers name the pages two
 * different ways:
 *
 *   - **mcp-tooling's live-reload bridge.** After a headless MCP Studio write
 *     tool (`studio_apply_edits`/`studio_codemod`/`studio_create_page`/
 *     `studio_set_frames`) lands a write, the server relays a best-effort push
 *     naming exactly the pages that changed
 *     (`server/ai/mcp/tools/studio/liveReloadPush.ts`).
 *   - **The user's own writes** — the autosave diff and the structural
 *     commits, both through `studioBoardResync.ts`, which asks
 *     `POST /admin/api/studio/reload-scope` which pages the touched files feed.
 *
 * CRITICAL — applies the stream's `meta` line, not just its pages. The server
 * recomputes that line IN FULL on every load, filtered or not, precisely
 * because `styleRules`, `conditions`, `authoredCss`, `vendorCss` and
 * `styleRuleSources` are PROJECT-wide and the very edit that triggered this
 * reload can change any of them (`server/handlers/studio/studioLoadResponse.ts`
 * spells out the reasoning). This function used to read `missingPageIds` off
 * that line and throw the rest away — so a reload applied freshly-parsed page
 * trees against the PREVIOUS style registry.
 *
 * The visible result was a canvas that broke on every agent turn until the
 * user hit refresh: a node whose `classIds` name a rule the stale registry has
 * never seen resolves, through `NodeRenderer`'s
 * `getCanvasNodeClassName(..., s.site?.styleRules)`, to NO class name at all.
 * The element renders unstyled, the layout collapses, and any container left
 * with no children and no class draws the "Empty container" placeholder
 * (`ContainerEditor.tsx`) — a page that is completely fine on disk, rendered
 * against last minute's stylesheet.
 *
 * `styleRules`/`conditions` live in the `SiteDocument`, so they are RETURNED
 * for the caller to hand to `patchPages` (this module stays store-agnostic —
 * see below). Everything else is a store-free per-load leaf and is applied
 * here, exactly as `fsCodemodAdapter.ts`'s `loadSite` applies it.
 *
 * Two meta fields are deliberately NOT applied: `fsCodemodAdapter.ts`'s
 * `componentSources` (no reader today) and `paletteHiddenModuleIds` (read once
 * by `registerProjectModules.ts`, which a live reload does not re-run). Both
 * live inside the store-importing adapter, and reaching them from here would
 * close the import cycle this module exists outside of, to refresh values
 * nothing reads before the next full load replaces them anyway.
 *
 * CRITICAL — resyncs `loadedValuesBaseline.ts`'s save-diff baseline for
 * exactly the reloaded pages BEFORE returning. Skipping this is the single
 * easiest way to get this feature wrong: the baseline stays keyed by node id,
 * an insert/delete shifts every id below it, and a baseline captured BEFORE
 * the agent's edit is keyed on ids that may no longer exist on the
 * freshly-reloaded page — so the very next autosave tick would diff the
 * user's on-screen (freshly-reloaded) props against that stale baseline and
 * re-send every one of them as if the user had just typed it.
 *
 * Deliberately STORE-AGNOSTIC — returns the fetched pages rather than calling
 * `patchPages` itself. `agent/studioLiveReload.ts` (reachable from
 * `executor.ts`, which the editor store imports transitively) is the one
 * piece that touches the store, via the store-cycle-safe `storeRef`
 * indirection — see that module's doc for why importing `useEditorStore`
 * directly from here would close an import cycle back to the store.
 *
 * Never throws: a failed fetch/parse here must not corrupt any state or turn
 * into a failed tool result for an MCP caller who already got their write
 * confirmed. The caller treats this as fire-and-forget best effort and only
 * logs on failure.
 */
import type { ConditionDef, Page, StyleRule } from '@core/page-tree'
import { ndjsonRequest } from '@core/http'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'
import { StudioLoadStreamLineSchema, type StudioLoadStreamLine } from './studioLoadStreamSchema'
import { mergeLoadedValuesBaseline } from './loadedValuesBaseline'
import { setStudioAuthoredCss, setStudioVendorCss } from './studioRawCssStores'
import { setStudioStyleRuleSources } from './styleRuleWriteback'
import { setStudioTrustTier } from './studioProjectTrust'

export interface StudioPagesByIdResult {
  pages: Page[]
  missingPageIds: string[]
  /** The project-wide style registry as of this reload — hand it to `patchPages`, or the reloaded pages render against the previous one. */
  styleRules: Record<string, StyleRule>
  /** The project-wide condition set, same contract as `styleRules`. */
  conditions: ConditionDef[]
}

export interface StudioPagesByIdOptions {
  /**
   * Style rules the write that triggered this reload could NOT be applied for
   * (server refusals plus the client's own). Their diff baseline keeps its
   * PREVIOUS entry instead of adopting the on-disk value — see
   * `setStudioStyleRuleSources`. Absent for the MCP bridge, whose reload
   * follows a headless tool call with no client-side CSS diff behind it.
   */
  refusedRuleIds?: ReadonlySet<string>
}

export async function fetchStudioPagesById(
  pageIds: readonly string[],
  options: StudioPagesByIdOptions = {},
): Promise<StudioPagesByIdResult> {
  const overrideDir = getStudioWorkspaceDir()
  let meta: (StudioLoadStreamLine & { kind: 'meta' }) | null = null
  const pages: Page[] = []
  await ndjsonRequest('/admin/api/studio/load', {
    lineSchema: StudioLoadStreamLineSchema,
    query: { ...(overrideDir ? { dir: overrideDir } : {}), stream: 1, pageIds: pageIds.join(',') },
    onLine: (line: StudioLoadStreamLine) => {
      if (line.kind === 'meta') meta = line
      else pages.push(line.page)
    },
  })
  if (!meta) throw new Error('Studio load stream produced no metadata line.')
  const { missingPageIds, styleRules, styleRuleSources, conditions, vendorCss, authoredCss, trust } = meta

  // The per-load leaves, in the same order and with the same calls
  // `fsCodemodAdapter.ts`'s `loadSite` makes. Each is its own tiny external
  // store, so the injectors reading them re-render on their own; none of them
  // touches the editor store, which is what keeps this module store-agnostic.
  setStudioVendorCss(vendorCss)
  setStudioAuthoredCss(authoredCss)
  setStudioTrustTier(trust)
  // Ordered AFTER the raw CSS for no reason other than matching `loadSite`;
  // it is the write-back map, so a rule the agent's edit just introduced can
  // be edited by the user and land in the right file instead of being treated
  // as unmapped, in-memory-only styling.
  setStudioStyleRuleSources(styleRuleSources, styleRules, { refusedRuleIds: options.refusedRuleIds })

  mergeLoadedValuesBaseline(pages)

  return { pages, missingPageIds: missingPageIds ?? [], styleRules, conditions }
}
