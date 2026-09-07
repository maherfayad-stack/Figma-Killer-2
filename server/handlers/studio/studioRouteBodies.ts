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

/**
 * Body of POST /admin/api/studio/import-github (Phase 7B).
 *
 * Deliberately has NO `dir` field. `runGithubImport` clears its target
 * directory before repopulating it, so a caller-supplied target would be an
 * arbitrary recursive-delete primitive driven by a request body. The import
 * target is therefore always derived server-side from the parsed repo
 * (`studio-workspace/<owner>-<repo>`); `runGithubImport`'s `dir`
 * option stays internal (tests only) and is never sourced from the wire.
 *
 * `token`, when present, is forwarded as a Bearer credential and never logged
 * or echoed back.
 *
 * `pagesDir`, when present, is NOT forwarded to `runGithubImport` at all — it
 * has nothing to do with fetching/writing the repo. It's persisted to the
 * freshly-imported project's `.studio/meta.json` afterwards (§1.1's
 * `pagesDir` override) so a repo whose screens don't live at the
 * hand-authored default of `<dir>/pages` (e.g. `src/screens`) is discoverable
 * without restructuring the imported source.
 */
export const GithubImportBodySchema = Type.Object({
  url: Type.String(),
  ref: Type.Optional(Type.String()),
  subdir: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
  pagesDir: Type.Optional(Type.String()),
})
