/**
 * fsCodemodAdapter — an IPersistenceAdapter that makes the editor load from,
 * and save back to, a real React page on disk (via the /admin/api/studio
 * server endpoints), instead of the SQLite CMS draft.
 *
 *   loadSite  → GET  /admin/api/studio/load   → every source-derived Studio
 *               Page in the workspace's `pages/` dir, wrapped in a default
 *               SiteDocument shell (multi-frame board — Phase 1 Increment 1B).
 *               `site.settings.framework` (Colors/Typography/Spacing) is then
 *               overridden from `GET /admin/api/studio/framework`, if the
 *               project has a persisted `.studio/framework.json` — otherwise
 *               the default shell's framework settings stand as-is.
 *   saveSite  → POST /admin/api/studio/save   → a batch of typed edits
 *               (`kind: 'prop' | 'text' | 'style' | ...`) for every source-backed
 *               node (id = `relFile:line:col`), written back to the .tsx via
 *               the server-side ts-morph codemods (`setJsxProp` / `setJsxText`
 *               / `setJsxStyle`). `panel-02` (WS-6.3) adds `kind: 'css'`: a
 *               `site.styleRules` base-declaration change is diffed against
 *               `loadedStyleRuleValues` and, for a rule `styleRuleSources`
 *               mapped to a real `.css` file, written through the same
 *               `/save` batch via `setDeclaration` (a postcss CST codemod) —
 *               see `loadedStyleRuleValues`'s doc for the scope (base
 *               declarations only) and `StyleTargetChip` for what a user sees
 *               per tier. Independently, if `site.settings.framework`
 *               changed since the last load/save, it's POSTed to
 *               `/admin/api/studio/framework` — a framework-only edit (no
 *               node prop/text/style changes) still needs to persist, so this
 *               does NOT gate on there being any node edits in the batch.
 *
 * Wired in unconditionally by `AdminCanvasLayout` — Studio is the only editor
 * mode. This is the filesystem-as-truth path — Studio's autosave (debounce /
 * Cmd+S) is the commit-on-idle trigger.
 *
 * Paths live under /admin/api so the Vite dev proxy forwards them to the :3001
 * server (same-origin in prod behind Caddy).
 */
import type { IPersistenceAdapter, SaveSiteOptions } from '@core/persistence/types'
import { type Page, type SiteDocument } from '@core/page-tree'
import { apiRequest, ndjsonRequest } from '@core/http'
import { type Static } from '@core/utils/typeboxHelpers'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { notifyUnexplainedSkips } from '@site/panels/unexplainedSkipsNotice'
import { notifyInlineStyleUnsaved } from '@site/panels/inlineStyleUnsavedNotice'
import { armSidecarBaselines, loadSidecarSettings, noteFrameworkSynced, saveChangedSidecarSettings } from './sidecarSync'
import { notifyClassAssignmentUnsaved } from '@site/panels/classAssignmentUnsavedNotice'
import { getStudioWorkspaceDir, setStudioLoadedDir, studioWriteDir } from './studioWorkspaceDir'
import { fetchExtractedTokens, type TokenExtractionStatus } from './studioTokenStatus'
import { setStudioProjectKey, setStudioTrustTier } from './studioProjectTrust'
import { StudioSaveResponseSchema, notifyCreatedStylesheets } from './studioSaveRequests'
import { resyncBoardAfterWrite } from './studioBoardResync'
import { StudioLoadStreamLineSchema, type ComponentSource } from './studioLoadStreamSchema'
import { commitClassIdsBaseline, commitNodeValuesBaseline, dropNodeValuesBaseline, resetLoadedValues } from './loadedValuesBaseline'
import { collectClassNameEdits } from './classNameWriteback'
import { watchOpenPageForCssDestination } from './openPageWatch'
import {
  reportClassTokenRefusals,
  reportEditRefusals,
  reportStyleRulePlanRefusals,
  resetRefusalToasts,
  styleRulePlanTouchedSomething,
} from './refusalToasts'
import {
  collectStyleRuleEdits,
  commitBaseline as commitStyleRuleBaseline,
  setStudioStyleRuleSources,
} from './styleRuleWriteback'
import {
  collectLocalizedTextEdits,
  commitLocalizedTextBaseline,
  resetLocalizedTextBaseline,
  watchLocalizedPagesForBaseline,
} from './localizedPageWriteback'
import { setStudioVendorCss, setStudioAuthoredCss } from './studioRawCssStores'
import { collectNodeDiffEdits } from './nodeDiffWriteback'

export type { ComponentSource } from './studioLoadStreamSchema'

/**
 * Remembered from the last load so saveSite can tell the server which folder
 * to write. Held by `studioSaveRequests`, which every one-shot commit shares.
 */
function loadedDir(): string | null {
  return studioWriteDir()
}

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

/**
 * Every source-backed node's values AS LOADED, keyed by node id, so `saveSite`
 * can write only what the user actually changed. Owned by `loadedValuesBaseline.ts`
 * (a store-agnostic leaf — see that module's own doc for why); read from
 * `nodeDiffWriteback.ts`'s `collectNodeDiffEdits` (`getLoadedNodeValues`,
 * `speed-02` split it out of this file), or replaced wholesale on a fresh
 * `loadSite()` (`resetLoadedValues`, still here).
 */

/** The current workspace's local-vs-package classification for every component node, from the last load. */
export function getStudioComponentSources(): Record<string, ComponentSource> {
  return componentSources
}

/** WS-3.3 — the current project's `paletteHiddenModuleIds` override, from the last load. */
export function getStudioPaletteHiddenModuleIds(): readonly string[] {
  return paletteHiddenModuleIds
}

/**
 * WS-2.3/`board-27` — vendor package CSS and the project's own authored CSS
 * from the last load (`StudioLoadStreamLineSchema`'s meta-line `vendorCss`/
 * `authoredCss` — see their docs). Both are read-only, concatenated raw
 * bytes living OUTSIDE `SiteDocument` for the same reason `componentSources`
 * does above: ephemeral, server-derived, per-load state, not part of the
 * persisted/published document shape `SiteDocument` also serves for the CMS
 * half of this fork. Implementation lives in `studioRawCssStores.ts` (kept
 * this file under the 700-line module-size ceiling); re-exported here
 * verbatim so `ProjectCssInjector`/`AuthoredCssInjector` keep importing from
 * this file, same as every other per-load external store in this folder.
 */
export {
  getStudioVendorCss,
  subscribeStudioVendorCss,
  getStudioAuthoredCss,
  subscribeStudioAuthoredCss,
} from './studioRawCssStores'

/**
 * `tokens-01` — re-runs server-side token extraction for the CURRENTLY
 * loaded project (`studioTokenStatus.ts`'s `fetchExtractedTokens` does the
 * actual fetch + status-store update) and applies the result to the LIVE
 * document (`applyExtractedFrameworkTokens` — undo-able). This is the
 * Framework panel's "Re-scan tokens" action; `loadSite` below calls
 * `fetchExtractedTokens` directly instead (it has no live document yet to
 * apply the result to). Throws `ApiError` on failure so the caller can toast.
 */
export async function refreshExtractedTokens(): Promise<TokenExtractionStatus> {
  const dir = loadedDir()
  if (dir === null) throw new Error('[fsCodemodAdapter] refreshExtractedTokens called before a project loaded')
  const { framework, status } = await fetchExtractedTokens(dir)
  useEditorStore.getState().applyExtractedFrameworkTokens(framework)
  noteFrameworkSynced(framework)
  return status
}

/**
 * Studio's idle-commit cadence — how long the canvas waits after the last
 * edit before writing source back through `saveSite`. Deliberately snappier
 * than the CMS's user-configurable, default-30s cadence (see
 * `readAutoSaveDelayMs` in `preferences/editorPreferences.ts`): a design
 * canvas needs source to "follow" an edit within a beat, and studio has no
 * exposed autosave-delay setting to protect.
 *
 * `speed-02`: this used to be 2s, chosen to comfortably clear the save's own
 * round trip. Measurement showed the save itself costs ~36ms — the 2s was
 * pure waiting, not safety margin, and it read as the canvas being slow to
 * everyone watching the file (HMR, git, an MCP agent). 250ms is the new
 * trailing-debounce window: long enough that a burst of keystrokes (typing a
 * heading) or a drag gesture still collapses into one write instead of one
 * per keystroke, short enough that the write is over before anyone would
 * call it a wait. Combined with `AUTOSAVE_MAX_DEFERRAL_MULTIPLE` (4) in
 * `hooks/autosaveSchedule.ts`, a continuous edit burst is still forced to
 * save at least once a second, and the properties panel's blur/Enter/scrub-
 * release handlers call `flushAutosave()` (also `autosaveSchedule.ts`) to
 * write immediately once a field visibly settles, rather than waiting out
 * even this shorter window.
 */
export const STUDIO_AUTOSAVE_DELAY_MS = 250

export const fsCodemodAdapter: IPersistenceAdapter = {
  async loadSite(): Promise<SiteDocument | undefined> {
    // The active project is a subfolder of studio-workspace/ (hand-authored or
    // GitHub-imported) — see studioWorkspaceDir's doc comment for why every
    // studio client call must agree on the same active dir.
    const overrideDir = getStudioWorkspaceDir()
    // WS-5.5 — stream the load response page-by-page (NDJSON) rather than
    // waiting for one buffered JSON body: the meta line (componentSources,
    // styleRules, …) plus every page arrive as separate lines, each parsed
    // and validated as it's received instead of gating on the whole payload.
    // See the server route's own doc comment (`studio.ts`'s
    // `studioLoadStreamLines`) for exactly what this does and does not
    // achieve — server-side parse cost is unchanged, this shortens the time
    // between "server has an answer" and "client has usable bytes".
    type StudioLoadStreamLine = Static<typeof StudioLoadStreamLineSchema>
    let meta: (StudioLoadStreamLine & { kind: 'meta' }) | null = null
    const pages: Page[] = []
    await ndjsonRequest('/admin/api/studio/load', {
      lineSchema: StudioLoadStreamLineSchema,
      query: { ...(overrideDir ? { dir: overrideDir } : {}), stream: 1 },
      onLine: (line) => {
        if (line.kind === 'meta') meta = line
        else pages.push(line.page)
      },
    })
    if (!meta) throw new Error('Studio load stream produced no metadata line.')
    const {
      dir,
      projectName,
      componentSources: sources,
      styleRules,
      styleRuleSources: loadedStyleRuleSources, styledStyleRuleSources: loadedStyledRuleSources,
      conditions,
      vendorCss: loadedVendorCss,
      authoredCss: loadedAuthoredCss,
      trust,
      projectKey,
      paletteHiddenModuleIds: loadedPaletteHiddenModuleIds,
    } = meta
    setStudioLoadedDir(dir)
    componentSources = sources
    paletteHiddenModuleIds = loadedPaletteHiddenModuleIds
    setStudioVendorCss(loadedVendorCss)
    setStudioAuthoredCss(loadedAuthoredCss)
    setStudioTrustTier(trust)
    setStudioProjectKey(projectKey ?? null)
    // Baseline for the save-time diff — see `loadedValuesBaseline.ts`.
    resetLoadedValues(pages)
    // `style-02` — a fresh document is a fresh set of refusals to report.
    resetRefusalToasts()
    // `panel-02` (WS-6.3) — the CSS write-back map + its diff baseline.
    // `pages` feeds `buildClassPageIndex`, which is how a new class gets
    // co-located with the page it is used on (`style-02`).
    setStudioStyleRuleSources(loadedStyleRuleSources, styleRules, { pages, styledSources: loadedStyledRuleSources })
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
    resetLocalizedTextBaseline()
    watchLocalizedPagesForBaseline()
    // Distinct from `site.name` (the "Studio" product wordmark, unchanged per
    // project) — this is the per-project display name shown under the brand
    // in the toolbar (see Toolbar.tsx's StudioProjectLabel).
    useAdminUi.getState().setStudioProject({ dir, name: projectName })
    // Wrap the source-derived pages in a valid default site shell (breakpoints,
    // settings, framework, …) — every workspace page becomes a board frame.
    const site = createDefaultSiteDocument('Studio')
    site.pages = pages
    // §6 — styling imported from the workspace's `.css` files, re-derived
    // from disk on every load. `panel-02` (WS-6.3) — an edit to a rule
    // mapped in `styleRuleSources` now reaches disk on the next `saveSite`;
    // an edit to an unmapped rule (Tailwind/Sass/PostCSS output, a CSS
    // Modules compile) still only lives in-memory until reload — see
    // `studioCss.ts`'s "Write-back mapping" doc and `StyleTargetChip`, which
    // states which tier a given class is in.
    site.styleRules = styleRules
    site.conditions = conditions

    // Override the default shell's framework tokens + font library with
    // whatever this project has persisted in `.studio/`, if anything. See
    // `sidecarSync.ts` — nothing persisted means the default stands as-is.
    await loadSidecarSettings(site, overrideDir ?? null)

    // `tokens-01` — populate the Framework panel from the project's OWN
    // design tokens (`:root` custom properties, a Tailwind theme, or a vendor
    // design-system package's CSS — see `tokenExtract.ts`). Runs every load:
    // the server's own merge only ever fills a currently-EMPTY family, so
    // this is a no-op once populated (by extraction or by the user), and it
    // means a project whose tokens only became reachable later — e.g. after
    // "Install dependencies" resolves a vendor CSS import — picks them up on
    // the very next load, with no separate "re-scan" step required. A
    // failure here (e.g. the route isn't wired up yet) must not block the
    // rest of the project from loading — logged, not thrown.
    try {
      const tokensResult = await fetchExtractedTokens(dir)
      site.settings.framework = tokensResult.framework
    } catch (err) {
      console.error('[fsCodemodAdapter] token extraction failed', err)
    }

    armSidecarBaselines(site)

    return site
  },

  async saveSite(site: SiteDocument, opts: SaveSiteOptions = {}): Promise<void> {
    // Every source-backed node's literal props + inline styles, DIFFED against
    // `loadedValues` — an unchanged value must never be re-written, or a
    // resolved expression gets baked into a literal. Synthetic nodes (e.g.
    // `index:body`) are skipped server-side. `speed-02` moved the walk itself
    // (module-size-budget fix) to `nodeDiffWriteback.ts`'s
    // `collectNodeDiffEdits` — see that module's doc for what it owns; this
    // function still owns everything downstream of its return value (the
    // POST, refusal reporting, baseline commits, resync).
    //
    // C4 — the walk used to scan every node of every page on every autosave
    // tick, ignoring `opts.dirty` (fed correctly by every `mutateSite`/
    // `mutateActiveTree` call, see `dirtyTracking.ts`). A page NOT in
    // `dirty.pageIds` produced zero site patches since the last snapshot, so
    // it holds no unshipped edit — skipping its scan is lossless. Absent
    // hints or `dirty.all` fall back to the full scan (`SaveSiteOptions`'s own
    // "Absent -> replace-mode full save" contract). Scope: only this walk is
    // filtered — `collectClassIdsDrift`/`commitClassIdsBaseline`/
    // `collectStyleRuleEdits` below stay unfiltered (cheaper per-node checks,
    // lower risk to touch alongside the 0.6 seam than the payoff is worth).
    const { edits, bumps, drops, inlineStyleRefusals } = collectNodeDiffEdits(site.pages, opts.dirty)

    // Track B2 — Studio (filesystem) mode now has a real `class` edit kind
    // (`setJsxClassName`): `collectClassNameEdits` diffs `node.classIds`
    // against the load-time baseline right here — the same place
    // `collectStyleRuleEdits` (just below) diffs `site.styleRules` — and
    // turns most of the drift into `kind: 'class'` edits sent in the same
    // batch as everything else. The residual `unwritable` subset (a `.map`
    // row, a synthetic root — no single JSX location a class token could
    // land on) still gets Phase 0.6's honesty toast, now scoped to exactly
    // that subset instead of every class change in the project. Fires
    // exactly when the write is attempted, catches every entry point
    // (including a future AI-agent-driven class edit), and never re-fires
    // for a node whose classes are unchanged since the last save.
    // `font-revert` — same beat as the class refusal below, same reason:
    // fired where the write WOULD have been attempted, so every entry point
    // (docked composer, multi-selection composer, canvas handles, agent) is
    // covered by one message instead of each surface owning a copy of the rule.
    notifyInlineStyleUnsaved(inlineStyleRefusals)

    const classPlan = collectClassNameEdits(site.pages, site.styleRules, site.visualComponents)
    edits.push(...classPlan.edits)
    if (classPlan.unwritable.length > 0) notifyClassAssignmentUnsaved(classPlan.unwritable)

    reportClassTokenRefusals(classPlan.tokenRefusals)

    // `panel-02` (WS-6.3) — CSS write-back, owned by `styleRuleWriteback.ts`:
    // it diffs each rule's BASE `styles` bag against the load-time baseline
    // and reports both the edits to send and every change that had nowhere to
    // go. See that module's doc for why those lists exist — an unmapped rule
    // used to be skipped silently, so a Tailwind project's style edits
    // vanished on reload with nothing ever said about it.
    //
    // Three facts about the DOCUMENT ride along, each answering a destination
    // question this module must not answer itself: `site.pages` co-locates a
    // new class with the page it is USED on (`style-02`); the editing contexts
    // resolve a breakpoint override to its `@media` query (`style-03`;
    // `@container`/`@supports` still refuse by name); and `activePageId` is
    // Z8's last resort, for a class on no element for `buildClassPageIndex`.
    const cssPlan = collectStyleRuleEdits(
      site.styleRules,
      site.pages,
      { breakpoints: site.breakpoints, conditions: site.conditions },
      useEditorStore.getState().activePageId,
    )
    edits.push(...cssPlan.edits)

    // Every way that plan can decline, told to the user in the one shape each
    // deserves — including Z8's destination question, which opens a dialog
    // rather than a toast. `refusalToasts.ts` owns which is which.
    reportStyleRulePlanRefusals(cssPlan, useEditorStore.getState().presentRefusalDialog)

    // WS-10 §4.4 (Phase 4) — a locale-variant board frame's text edits.
    // `localizedPages` lives OUTSIDE `site` (a parallel map, not part of
    // `SiteDocument` — see `localizedPageSlice.ts`'s module doc), so it is
    // read directly from the store here rather than arriving via `site`
    // the way every edit above does. Owns its own `(pageId, locale,
    // nodeId)`-keyed baseline — see `localizedPageWriteback.ts` for why it
    // cannot share `loadedValues` with the default tree above.
    //
    // ERR-17 — the snapshot is kept: the baseline below must advance to what
    // THIS save sent, not to whatever the store holds once the POST returns.
    // Text typed while the save was in flight is not in `edits`; committing
    // the live store would have adopted it as "already on disk" and it would
    // never be sent. (Store state is immutable, so holding the reference IS
    // the snapshot.)
    const sentLocalizedPages = useEditorStore.getState().localizedPages
    const localizedEdits = collectLocalizedTextEdits(sentLocalizedPages)
    edits.push(...localizedEdits)

    // `style-02` — the two baselines below must not advance past a REFUSED
    // write. Both lists start with the refusals this client already made
    // (a token/destination it will not guess) and grow with the server's.
    // Z8 — a rule whose DESTINATION was refused starts in this set: nothing
    // reached disk, and the held-back baseline is what leaves its
    // declarations in the diff for the remedy's re-run to write.
    const refusedRuleIds = new Set<string>(cssPlan.destinationRefusals.map((refusal) => refusal.ruleId))
    const refusedClassNodeIds = [...classPlan.refusedNodeIds]

    // The files a landed write touched, deferred to the END of this function:
    // the resync rewrites the same diff baselines the block below advances, so
    // running it inline would let those commits overwrite the fresh disk
    // baseline with the pre-reload document. See `studioBoardResync.ts`.
    let resyncTouchedFiles: readonly string[] | null = null

    if (edits.length > 0) {
      const result = await apiRequest('/admin/api/studio/save', {
        method: 'POST',
        body: { dir: loadedDir(), edits },
        schema: StudioSaveResponseSchema,
      })

      // WS-4.4/4.5/6.3 — every named refusal gets its own toast carrying the
      // actual reason (`refusalToasts.ts`), de-duped by (kind, target, reason)
      // rather than by advancing the baseline past it — which used to be how a
      // repeat toast was avoided, and silently threw the edit away with it
      // (`style-02`).
      const refusals = result.refusals ?? []
      reportEditRefusals(refusals)
      for (const refusal of refusals) {
        if (refusal.kind === 'css' || refusal.kind === 'styled') {
          for (const ruleId of cssPlan.ruleIdsByNodeId[refusal.nodeId] ?? []) refusedRuleIds.add(ruleId)
        }
        if (refusal.kind === 'class') refusedClassNodeIds.push(refusal.nodeId)
      }

      // Some edits resolved to no writable source location, so nothing reached
      // disk for them. The commonest cause is text that is not a literal in the
      // target element at all: `<p className="title">{title}</p>` renders a prop
      // the CALL SITE passes, and `setJsxText` refuses rather than baking the
      // binding away into a string. Say so — the alternative is the user
      // watching their edit snap back with no explanation. Excludes skips
      // already explained by a refusal toast above.
      //
      // Phase 0 item 0.7 — `result.unexplainedSkips` (added alongside
      // `refusals`/`shifted`/etc. on `StudioSaveResponseSchema`) carries the
      // actual `{ nodeId, kind }[]` behind this count, so the toast can name
      // the affected node(s) instead of a bare number — see
      // `unexplainedSkipsNotice.ts`. `?? []` covers an older/dev server that
      // hasn't picked up the field yet; `notifyUnexplainedSkips([])` is a
      // documented no-op, matching the old `unexplainedSkips > 0` guard.
      const unexplainedSkips = result.skipped - refusals.length
      notifyUnexplainedSkips(result.unexplainedSkips ?? [])

      // Track B1 create branch — name the file Studio invented and register it
      // in the write-back map, so the same rule is writable through the ordinary
      // `set` path on its next edit with no reload. Creating a file is a bigger
      // surprise than choosing one, so it is never silent.
      notifyCreatedStylesheets(result, site.styleRules)

      // E1 fix (`STUDIO-FIGMA-PARITY-PLAN.md` 0.1) — advance the node-value
      // baseline to what this batch wrote, so the NEXT autosave tick diffs
      // against disk-as-it-now-is rather than the as-loaded snapshot. Gated
      // on `unexplainedSkips === 0`: the response only reports aggregate
      // counts for the whole POST (props + text + style + tag + CSS +
      // localized text all share one `written`/`skipped`), so there is no
      // per-edit signal to tell which SPECIFIC bump landed when only some of
      // the batch did. Skipping the whole commit in that rare case is the
      // safe direction — a bump that should have landed just gets re-diffed
      // (harmless, `setJsxProp`/`setJsxText` are idempotent) on the next
      // tick, instead of a refused/skipped edit's value being silently
      // adopted as the new baseline and the user never seeing why their
      // change didn't stick.
      if (unexplainedSkips === 0) {
        commitNodeValuesBaseline(bumps)
        // `style-03` — a REMOVED inline style has no value to record, so its
        // baseline entry has to be deleted instead; leaving it behind would
        // re-emit the same removal on every later tick.
        dropNodeValuesBaseline(drops)
      }

      // A write shifted line numbers, so every `line:col` node id below that
      // point is now stale against disk and must be re-derived by re-reading
      // the file — otherwise the NEXT edit on a shifted node targets the wrong
      // source location and silently fails. A shared-component edit rewrote
      // the component's own file, so every OTHER instance of it on the board
      // shows a stale value — same remedy, different cause, and on an App
      // Router board (shared layout chrome) it is the COMMON case, which is
      // why this must not mean "reparse all forty pages".
      //
      // `resyncBoardAfterWrite` narrows that to exactly the pages the touched
      // files feed, and falls back to the full reload when it cannot prove the
      // scope. Deferred to the end of this function — see the declaration.
      //
      // Gated on `written > 0`. When nothing reached disk the document still
      // matches the files, so there is nothing to re-sync — and reloading would
      // replace the user's in-memory edit with the unchanged source, making the
      // edit visibly revert two seconds after they typed it. That was the whole
      // bug: an unwritable text edit reverted itself on a timer.
      if (result.written > 0 && (result.shifted || result.sharedComponents)) {
        resyncTouchedFiles = result.touchedFiles ?? []
      }
    }

    // WS-10 §4.4 (Phase 4) — advance the locale-variant text baseline to
    // what was just sent, for the same reason the CSS baseline below does:
    // without it, every later autosave tick re-sends an already-applied
    // literal edit (harmless — `setJsxText` is idempotent — but wasteful,
    // and it would keep the "pending" edit alive across reloads it
    // shouldn't be). See `localizedPageWriteback.ts`'s "Baseline discipline".
    if (localizedEdits.length > 0) {
      commitLocalizedTextBaseline(sentLocalizedPages)
    }

    // `panel-02` — advance the CSS diff baseline to what was just sent, so one
    // user change produces exactly one write attempt. `style-02` — EXCEPT for
    // the rules the server refused: those never reached disk, so adopting
    // their value would make the user's obvious retry (the same value again)
    // diff as "no change" and never be attempted a second time. The repeat
    // toast that used to prevent is handled by `toastOnce` instead.
    //
    // The class baseline (`commitClassIdsBaseline`) moved here from before
    // the POST for the same reason: it now has server refusals to honour.
    if (styleRulePlanTouchedSomething(cssPlan)) {
      commitStyleRuleBaseline(site.styleRules, { pages: site.pages, refusedRuleIds })
    }
    commitClassIdsBaseline(site.pages, refusedClassNodeIds)

    // Framework tokens and the installed font library live outside the
    // per-node edit batch above — they are editor-owned `.studio/` sidecars,
    // not `.tsx` source — so they sync independently and a settings-only
    // change (no node edits at all) still persists. See `sidecarSync.ts`.
    await saveChangedSidecarSettings(site, loadedDir())

    // LAST — every diff baseline above has now advanced, so the resync's own
    // baseline writes (fresh from disk, for exactly the reloaded pages) are
    // the ones that stand. `refusedRuleIds` rides along so the reload does not
    // adopt a value the server refused as the new baseline, which would make
    // the user's retry diff as "no change" (`style-02`'s bug #3).
    if (resyncTouchedFiles) await resyncBoardAfterWrite(resyncTouchedFiles, { refusedRuleIds })
  },
}
