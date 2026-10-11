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

/**
 * Persist `boards` to `dir` (server default workspace when omitted) and return
 * the file as the server now holds it. `knownBoardIds` is every board this
 * editor has read or written: the server keeps any board on disk that is
 * neither in `boards` nor listed (one it made since this editor last read),
 * so the answer can hold boards the caller does not have yet.
 */
export async function saveBoards(boards: BoardsFile, dir: string | undefined, knownBoardIds: readonly string[]): Promise<BoardsFile> {
  const res = await apiRequest('/admin/api/studio/boards', {
    method: 'POST',
    body: { dir, boards, knownBoardIds },
    schema: BoardsPostResponseSchema,
  })
  return parseBoardsFile(res.boards)
}
