/**
 * studioPageRequests — the page-LIFECYCLE wire contract: create a page, delete
 * a page. Separate from `studioSaveRequests.ts` (the save/edit contract) for
 * the reason those two change: that module is about writing INTO a page's
 * source, this one is about whether the page's file exists at all.
 *
 * Both calls leave the board to the server. Creating a page places its frame
 * (D5 §11.3); deleting one removes every frame of it. The caller's only job
 * afterwards is `requestCmsSiteReload()`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import type { PageKind } from '@core/studio-board'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'
import { studioWriteDir } from './studioSaveRequests'

/** POST /admin/api/studio/page response — the newly scaffolded page. */
const StudioCreatePageResponseSchema = Type.Object({
  ok: Type.Boolean(),
  relPath: Type.String(),
  /** Kebab id derived from the file path — the value a board frame references. */
  pageId: Type.String(),
  title: Type.String(),
  /**
   * WS-13 step 4 — the scaffolded root element's node id, read by the server
   * actually parsing the file it just wrote (never constructed). Absent only
   * on an unexpected parse failure; the browser doesn't need it (the reload
   * re-parses the whole workspace and the canvas selects by clicking), but an
   * MCP/agent caller (`studio_create_page`, WS-12 §3) needs it to address the
   * new screen's root before any reload.
   */
  rootNodeId: Type.Optional(Type.String()),
})
export type CreatedStudioPage = Static<typeof StudioCreatePageResponseSchema>

/**
 * Creates a new page (a canonical starter component, WS-13 step 4) in the
 * active project and resolves to its `{ pageId, title, rootNodeId }` — the
 * server has already placed it on the board (D5 §11.3), so there is nothing
 * else for the caller to do besides reload. Targets the SAME `dir` every
 * other studio call uses, so the file lands in the project the canvas is
 * currently showing.
 *
 * `name` is optional — omit it and the server auto-names the page from its
 * kind (`Page`, `Page2`, … for a screen; `Sheet`, `Sheet2`, … for a bottom
 * sheet). `kind` is optional too and defaults, server-side, to an ordinary
 * screen.
 *
 * Throws `ApiError` on failure (e.g. a name collision → 409) so the caller can
 * toast the message. The caller reloads the workspace afterwards
 * (`requestCmsSiteReload`) to render it.
 */
export function createStudioPage(
  name?: string,
  kind?: PageKind,
  boardId?: string,
): Promise<CreatedStudioPage> {
  const overrideDir = getStudioWorkspaceDir()
  const body: { name?: string; dir?: string; kind?: PageKind; boardId?: string } = {}
  if (name) body.name = name
  if (kind) body.kind = kind
  // The server places the frame (D5 §11.3); without this it placed it on the
  // FIRST board regardless of which one the author had open.
  if (boardId) body.boardId = boardId
  if (overrideDir) body.dir = overrideDir
  return apiRequest('/admin/api/studio/page', {
    method: 'POST',
    body,
    schema: StudioCreatePageResponseSchema,
  })
}

/** DELETE /admin/api/studio/page response — what the delete actually removed. */
const StudioDeletePageResponseSchema = Type.Object({
  ok: Type.Boolean(),
  pageId: Type.String(),
  /** Project-relative paths of every file removed — the page, plus a stylesheet nothing else imported. */
  removedFiles: Type.Array(Type.String()),
  /** How many board frames of this page went with it, across every board. */
  removedFrames: Type.Number(),
})
export type DeletedStudioPage = Static<typeof StudioDeletePageResponseSchema>

/**
 * Deletes a page from the project for real: its source file, a stylesheet
 * nothing else imports any more, and every board frame of it.
 *
 * This is what makes `deletePage` mean something in Studio. The editor store's
 * own `deletePage` only splices the page out of the in-memory `site.pages`, so
 * on its own the `.tsx` survives and the next reload parses it straight back
 * in — the same "a write must land in the source or it did not happen"
 * invariant every other studio commit answers to.
 *
 * Throws `ApiError` on failure (an unknown `pageId` → 404) so the caller can
 * toast the message and reload to put the page back on screen, since the
 * store already removed it optimistically.
 */
export function deleteStudioPage(pageId: string): Promise<DeletedStudioPage> {
  return apiRequest('/admin/api/studio/page', {
    method: 'DELETE',
    body: { dir: studioWriteDir(), pageId },
    schema: StudioDeletePageResponseSchema,
  })
}
