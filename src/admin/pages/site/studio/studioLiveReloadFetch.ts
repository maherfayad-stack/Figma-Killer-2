/**
 * studioLiveReloadFetch — the read half of mcp-tooling's live-reload bridge.
 *
 * After a headless MCP Studio write tool (`studio_apply_edits`/
 * `studio_codemod`/`studio_create_page`/`studio_set_frames`) lands a write on
 * disk, the server relays a best-effort push naming exactly the pages that
 * changed (`server/ai/mcp/tools/studio/liveReloadPush.ts`). This fetches ONLY
 * those pages via the same `?stream=1&pageIds=` filtered load `loadSite`
 * itself supports (`studioLoadStreamSchema.ts`), instead of a full
 * `loadSite()` re-read of the whole project.
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
import type { Page } from '@core/page-tree'
import { ndjsonRequest } from '@core/http'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'
import { StudioLoadStreamLineSchema, type StudioLoadStreamLine } from './studioLoadStreamSchema'
import { mergeLoadedValuesBaseline } from './loadedValuesBaseline'

export interface StudioPagesByIdResult {
  pages: Page[]
  missingPageIds: string[]
}

export async function fetchStudioPagesById(pageIds: readonly string[]): Promise<StudioPagesByIdResult> {
  const overrideDir = getStudioWorkspaceDir()
  let missingPageIds: string[] = []
  const pages: Page[] = []
  await ndjsonRequest('/admin/api/studio/load', {
    lineSchema: StudioLoadStreamLineSchema,
    query: { ...(overrideDir ? { dir: overrideDir } : {}), stream: 1, pageIds: pageIds.join(',') },
    onLine: (line: StudioLoadStreamLine) => {
      if (line.kind === 'meta') missingPageIds = line.missingPageIds ?? []
      else pages.push(line.page)
    },
  })

  mergeLoadedValuesBaseline(pages)

  return { pages, missingPageIds }
}
