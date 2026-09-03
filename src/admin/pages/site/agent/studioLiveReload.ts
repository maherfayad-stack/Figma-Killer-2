/**
 * studioLiveReload — the browser-side handler for the server's internal
 * live-reload push (`server/ai/mcp/tools/studio/liveReloadPush.ts`).
 *
 * After a headless MCP Studio write tool (`studio_apply_edits`/
 * `studio_codemod`/`studio_create_page`/`studio_set_frames`) lands a write on
 * disk, the server relays a `studio_live_reload` request down this user's
 * live editor bridge — the SAME `toolRequest`/`toolResult` transport every
 * browser-executed `AiTool` uses (`editorBridge.ts`), which is why
 * `executor.ts` dispatches it here exactly like any other browser tool.
 *
 * NOT a registered `AiTool`: no model ever calls this by name, no MCP client
 * can invoke it directly (`server/ai/mcp/server.ts`'s `tools/list` only ever
 * advertises the real registry) — it only ever originates from
 * `liveReloadPush.ts`, right after a capability-gated server tool already
 * succeeded and wrote to disk.
 *
 * Fail-soft throughout, per this feature's own constraint: a stale canvas
 * after a failed/declined push is an expected, acceptable outcome (no open
 * board is the common case for a headless MCP connector) — this never
 * throws, always resolves `aiToolOk`, and never corrupts store state.
 */
import { aiToolOk, type AiToolOutput } from '@core/ai'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { EditorStore } from '@site/store/types'
import { fetchBoards } from '../studio/boardsApi'
import { fetchComments } from '../studio/commentsApi'
import { fetchPrototype } from '../studio/prototypeApi'
import { studioWriteDir } from '../studio/studioSaveRequests'
import { fetchStudioPagesById } from '../studio/studioLiveReloadFetch'
import { getAgentStoreApi } from './storeRef'

const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

/**
 * `studio_live_reload` is not a registered `AiTool` (see this module's own
 * doc) — its request never travels through a provider's tool-call JSON, only
 * through the server's own internal push, so it has no matching entry in
 * `@core/ai`'s shared schema module. This is its one definition; `executor.ts`
 * imports it rather than redefining a parallel shape.
 */
export const StudioLiveReloadInputSchema = Type.Object({
  dir: Type.String(),
  pageIds: Type.Array(Type.String()),
  boardsChanged: Type.Boolean(),
  /*
   * Optional so an older push (or a test fixture) that predates review
   * comments still validates — the server always sends it now. Absent is
   * read as false by the handler below.
   */
  commentsChanged: Type.Optional(Type.Boolean()),
  /** Same optionality, same reason: an older push predating the interaction tools still validates. */
  prototypeChanged: Type.Optional(Type.Boolean()),
})
export type StudioLiveReloadInput = Static<typeof StudioLiveReloadInputSchema>

/**
 * Re-fetch `.studio/boards.json` and apply it, preserving whichever board the
 * user is currently looking at. `loadBoards` (an existing, unmodified
 * `boardSlice.ts` action) always jumps `activeBoardId` to `boards[0]` —
 * correct for a genuine fresh project load, wrong here: yanking the user off
 * their current board because an agent resized a frame on a DIFFERENT board
 * would be a worse regression than the stale geometry this reload fixes.
 * `setActiveBoard` (also pre-existing) restores it afterward when it still
 * exists in the freshly-fetched file.
 */
async function reloadStudioBoards(dir: string): Promise<void> {
  const previousActiveBoardId = getStoreState().activeBoardId
  const file = await fetchBoards(dir)
  getStoreState().loadBoards(file)
  if (previousActiveBoardId && file.boards.some((b) => b.id === previousActiveBoardId)) {
    getStoreState().setActiveBoard(previousActiveBoardId)
  }
}

/**
 * Re-read `.studio/comments.json`. An agent's reply touches no page source, so
 * nothing on the canvas needs to re-parse — without this the reply would sit
 * unseen in a thread the reviewer already has open.
 *
 * Goes through `commentsApi` + `getStoreState()` rather than reusing
 * `commentActions.reloadComments`, for the same structural reason
 * `reloadStudioBoards` above uses `boardsApi` instead of a UI action: this
 * module is reachable from `store.ts` (store → agent/index →
 * agentSliceConfig.site → executor → here), and `commentActions` imports the
 * store, so either edge — static OR dynamic — closes a loop that
 * `no-circular-dependencies` fails on. `commentsApi` is pure HTTP and imports
 * no store, which is exactly why the agent-side modules talk to it directly.
 */
async function reloadStudioComments(dir: string): Promise<void> {
  getStoreState().loadComments(await fetchComments(dir))
}

/** `prototypeApi` for the same reason `commentsApi` is used above: `prototypeActions` imports the store and would close the cycle. */
async function reloadStudioPrototype(dir: string): Promise<void> {
  getStoreState().loadPrototype(await fetchPrototype(dir))
}

export async function runStudioLiveReload(input: StudioLiveReloadInput): Promise<AiToolOutput> {
  // A different project is open than the one the write landed in — applying
  // THAT project's pages/boards to THIS board would silently cross-
  // contaminate two unrelated projects. Not an error: the write already
  // succeeded on disk; this board simply has nothing to refresh.
  if (studioWriteDir() !== input.dir) {
    return aiToolOk({ applied: false, reason: 'different-project-open' })
  }

  const failed: string[] = []
  if (input.pageIds.length > 0) {
    try {
      // `styleRules`/`conditions` ride along deliberately: they are the
      // project-wide registry the SAME reload recomputed, and applying the
      // pages without them renders freshly-parsed nodes against the previous
      // stylesheet — see `studioLiveReloadFetch.ts`'s doc for what that looks
      // like on screen.
      const { pages, missingPageIds, styleRules, conditions } = await fetchStudioPagesById(input.pageIds)
      getStoreState().patchPages({ pages, removedPageIds: missingPageIds, styleRules, conditions })
    } catch (err) {
      console.error('[studioLiveReload] page reload failed — canvas may be stale for the touched page(s):', err)
      failed.push('pages')
    }
  }
  if (input.boardsChanged) {
    try {
      await reloadStudioBoards(input.dir)
    } catch (err) {
      console.error('[studioLiveReload] board reload failed — frame geometry may be stale:', err)
      failed.push('boards')
    }
  }
  if (input.commentsChanged) {
    try {
      await reloadStudioComments(input.dir)
    } catch (err) {
      console.error('[studioLiveReload] comment reload failed — threads may be stale:', err)
      failed.push('comments')
    }
  }
  if (input.prototypeChanged) {
    try {
      await reloadStudioPrototype(input.dir)
    } catch (err) {
      console.error('[studioLiveReload] prototype reload failed — links may be stale:', err)
      failed.push('prototype')
    }
  }
  return aiToolOk({ applied: true, failed })
}
