/**
 * studioRouteBodies — the TypeBox request-body schemas for the studio routes
 * that live directly in `server/handlers/studio.ts` (save, boards, framework,
 * frame-defaults, GitHub import).
 *
 * Extracted when that file reached the 700-line module ceiling. They belong
 * together anyway: each one is a boundary contract with the browser, and the
 * reasoning about what each field may and may not carry — most sharply
 * `GithubImportBodySchema`'s missing `dir` — is the kind of thing that should
 * be read as a set, not hunted for between route branches.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { StudioEditSchema } from '../studioWriteback'

/** Body of POST /admin/api/studio/save — a batch of typed source writebacks. */
export const SaveBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  edits: Type.Optional(Type.Array(StudioEditSchema)),
})

/**
 * Body of POST /admin/api/studio/boards. `boards` stays `Unknown` at the
 * boundary because `parseBoardsFile` is the real validator — it defensively
 * coerces any payload into a well-formed BoardsFile — so there is no parallel
 * TypeBox mirror of the board model to drift.
 */
export const BoardsPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  boards: Type.Unknown(),
})

/**
 * Body of POST /admin/api/studio/framework. `framework` stays `Unknown` at
 * the boundary because `writeStudioFrameworkFile` is the real validator (via
 * `FrameworkSettingsSchema`) — no parallel mirror to drift.
 */
export const FrameworkPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  framework: Type.Unknown(),
})

/**
 * Body of POST /admin/api/studio/frame-defaults (WS-7.2 — "apply to all
 * pages"). Both fields optional: a bulk width-only apply must be able to
 * merge without touching a previously-saved default height.
 */
export const FrameDefaultsBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  width: Type.Optional(Type.Number({ minimum: 1 })),
  height: Type.Optional(Type.Number({ minimum: 1 })),
})
