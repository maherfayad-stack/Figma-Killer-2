/**
 * boardsApi — client for the `/admin/api/studio/boards` endpoints.
 *
 * Only the HTTP envelope is validated with TypeBox here (`dir` / `ok` +
 * an opaque `boards` payload) — the real shape validation for `boards` is
 * `parseBoardsFile` from `@core/studio-board`, which defensively coerces
 * whatever the server returns into a well-formed `BoardsFile` and never
 * throws. Duplicating the full `BoardsFile` shape as a second TypeBox schema
 * would just be a parallel, driftable copy of what `parseBoardsFile` already
 * does.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { parseBoardsFile, type BoardsFile } from '@core/studio-board'

const BoardsGetResponseSchema = Type.Object({
  dir: Type.String(),
  boards: Type.Unknown(),
})

const BoardsPostResponseSchema = Type.Object({
  ok: Type.Boolean(),
  boards: Type.Unknown(),
})

/** Fetch and parse the boards file for `dir` (server default workspace when omitted). */
export async function fetchBoards(dir?: string): Promise<BoardsFile> {
  const res = await apiRequest('/admin/api/studio/boards', {
    schema: BoardsGetResponseSchema,
    query: dir ? { dir } : undefined,
  })
  return parseBoardsFile(res.boards)
}

/** Persist `boards` to `dir` (server default workspace when omitted). */
export async function saveBoards(boards: BoardsFile, dir?: string): Promise<void> {
  await apiRequest('/admin/api/studio/boards', {
    method: 'POST',
    body: { dir, boards },
    schema: BoardsPostResponseSchema,
  })
}
