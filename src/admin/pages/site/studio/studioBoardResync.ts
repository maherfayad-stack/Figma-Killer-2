/**
 * studioBoardResync — the ONE rule for "a write landed on disk; make the board
 * agree with it again", shared by both things that write.
 *
 * Two callers, two triggers, one policy:
 *   - `studioSaveRequests.ts`'s `commitStructural` — a move/delete/insert the
 *     user just performed, committed the moment the gesture ended.
 *   - `fsCodemodAdapter.ts`'s `saveSite` — the debounced autosave diff, when
 *     the response reports `shifted` (line numbers moved, so every `line:col`
 *     node id below the edit is stale) or `sharedComponents` (the write went
 *     to a component's own file, so every OTHER instance of it on the board is
 *     showing a stale value).
 *
 * ## Why this exists: the user's own save was paying for the agent's cheap path
 *
 * `saveSite` used to answer both of those conditions with
 * `requestCmsSiteReload()` — the full `loadSite()`: re-parse and re-convert
 * EVERY page in the project, re-stream all of them, and replace the whole
 * document. On a Next.js App Router board the layout chrome is shared by
 * construction, so `sharedComponents` is true for a large share of ordinary
 * edits, and the user paid a whole-board reparse roughly two seconds after
 * they stopped typing. Meanwhile the narrow path already existed and was in
 * production use — but only for the MCP live-reload push and for structural
 * commits.
 *
 * ## What "narrow" means here
 *
 * `POST /admin/api/studio/reload-scope` is the authority on scope, never this
 * module: it inverts `pageParseCache.ts`'s recorded per-route dependency sets
 * to answer "which routes did the files this write touched actually feed?" —
 * the written page, plus every page that inlines a touched component, plus
 * every route beneath a touched layout. It widens (`narrow: false`) for a cold
 * cache, incomplete cache coverage, a file no cached route claims, or a route
 * that no longer exists. Narrowing must never UNDER-reload; when in doubt it
 * widens, and this module's job is only to obey the answer.
 *
 * On `narrow: true` the named pages are fetched through the SAME
 * `?stream=1&pageIds=` filtered load the MCP bridge uses (`fetchStudioPagesById`,
 * which also applies the project-wide meta line — see `canvas-14`) and handed
 * to `patchPages` as a store patch.
 *
 * ## The full `loadSite()` is still the ONLY correct answer for these
 *
 * A page patch changes page CONTENT. Everything that changes the board's
 * global SHAPE or its non-page state keeps the full reload, and every one of
 * them calls `requestCmsSiteReload()` directly rather than coming through
 * here:
 *
 *   - **Page create / delete / rename** (`studioPageRequests.ts`,
 *     `NewPageButton.tsx`) — the frame set, `boards.json`, and the page id
 *     space all change.
 *   - **A new component FILE** (`extractInstanceCopy`, `promote-component`) —
 *     `componentSources` and the module registry are load-time state that a
 *     page patch deliberately does not touch.
 *   - **Workspace / project switch** (`ImportProjectDialog`, `DashboardPage`,
 *     `ImportProjectButton`) — a different project entirely.
 *   - **Project-wide settings that re-derive every page**: preview locale /
 *     axes (`PreviewAxesControls`), style-compile consent
 *     (`StyleCompileConsentBanner`), a dependency install
 *     (`useDependencyInstallJob`), a plugin pack install.
 *   - **`asset` / `detach` / `swap` / `insert-slot` one-shot commits** — each
 *     rewrites imports or mints files, so the module registry and
 *     `componentSources` move with them.
 *   - **Anything this module cannot prove narrow**, which is the same list
 *     `reload-scope` widens on.
 *
 * ## Ordering is load-bearing: never resync mid-save
 *
 * `saveSite` advances several diff baselines AFTER its POST returns
 * (`commitNodeValuesBaseline`, `commitStyleRuleBaseline` with the server's
 * `refusedRuleIds`, `commitClassIdsBaseline`). A resync writes those same
 * baselines from the freshly-read disk state. Running the resync first — which
 * an `await`ed call at the old `requestCmsSiteReload()` site would do — lets
 * the save's own commit then overwrite the disk baseline with the PRE-reload
 * in-memory document, and the next autosave tick re-sends every prop of every
 * reloaded page as if the user had just typed it. So the adapter defers the
 * resync to the very end of `saveSite`, and `refusedRuleIds` is threaded
 * through to `fetchStudioPagesById` so the reload's own `commitBaseline` does
 * not advance past a write the server refused (`style-02`'s bug #3, which is
 * otherwise trivially reachable again through this path).
 *
 * ## What a narrow reload does NOT preserve, deliberately — same as `loadSite`
 *
 * `patchPages` replaces `styleRules`/`conditions` WHOLESALE from the reload's
 * meta line; it never merges, because a merge would resurrect a rule the edit
 * just deleted (`canvas-14`). So an editor-authored rule that exists only in
 * memory — created in the panel, never yet written to a stylesheet — is
 * dropped by a resync, exactly as a full `loadSite()` drops it today. This is
 * parity, not a new hazard: making the narrow path merge would give the two
 * reload paths different answers for the same document, which is a worse
 * failure than the one it would fix. The reason a rule stays unwritten is
 * itself always reported (`reportUnmappedStyleRules` / the refusal toasts),
 * so this is never the user's first notice that something did not land.
 */
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { dispatchCmsSitePagesPatch, requestCmsSiteReload } from '@admin/state/adminEvents'
import { studioWriteDir } from './studioWorkspaceDir'
import { fetchStudioPagesById } from './studioLiveReloadFetch'

/** POST /admin/api/studio/reload-scope response — see `server/handlers/studio/reloadScope.ts`'s doc for the full contract. */
const StudioReloadScopeResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), narrow: Type.Literal(true), pageIds: Type.Array(Type.String()) }),
  Type.Object({ ok: Type.Literal(true), narrow: Type.Literal(false) }),
])

export interface BoardResyncOptions {
  /**
   * Style rules the save that triggered this resync could NOT write (server
   * refusals joined back through `StyleRuleEditPlan.ruleIdByNodeId`, plus the
   * client's own). Their diff baseline must keep its previous entry, or the
   * user's obvious retry — the same value again — diffs as "no change" and is
   * never attempted a second time.
   */
  refusedRuleIds?: ReadonlySet<string>
}

/**
 * Re-sync the board with disk after a write LANDED. Callers gate on that
 * themselves (`written > 0`): when nothing reached disk there is nothing to
 * re-sync FROM, and reloading would replace the user's optimistic edit with
 * the unchanged source.
 *
 * Falls back to the full `requestCmsSiteReload()` whenever the scope check
 * says "not provably narrow", or whenever ANY step here throws — a narrow
 * reload is an optimization, never the only path to a correct board, so a
 * failure here must still leave the board honest.
 */
export async function resyncBoardAfterWrite(
  touchedFiles: readonly string[],
  options: BoardResyncOptions = {},
): Promise<void> {
  // Nothing to ask about — a batch that landed a write always decodes at
  // least one location (see `applyStudioEditBatch`), so this is defensive,
  // not a real path; skip the round trip rather than ask a question with no
  // honest answer.
  if (touchedFiles.length === 0) {
    requestCmsSiteReload()
    return
  }
  try {
    const scope = await apiRequest('/admin/api/studio/reload-scope', {
      method: 'POST',
      body: { dir: studioWriteDir(), files: touchedFiles },
      schema: StudioReloadScopeResponseSchema,
    })
    if (scope.narrow && scope.pageIds.length > 0) {
      const { pages, missingPageIds, styleRules, conditions } = await fetchStudioPagesById(scope.pageIds, {
        refusedRuleIds: options.refusedRuleIds,
      })
      dispatchCmsSitePagesPatch({ pages, removedPageIds: missingPageIds, styleRules, conditions })
      return
    }
  } catch (err) {
    console.error('[studioBoardResync] reload-scope check failed, widening to a full reload:', err)
  }
  requestCmsSiteReload()
}
