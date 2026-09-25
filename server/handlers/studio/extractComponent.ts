/**
 * extractComponent — `POST /admin/api/studio/extract-component`, WS-4.4's
 * detach-refusal escape hatch (`extractComponentCopy`) as a plain HTTP route
 * the ADMIN BROWSER can call.
 *
 * `studio_codemod`'s `extract-component` verb
 * (`server/ai/mcp/tools/studio/editTools.ts`) already reaches the same
 * codemod for AI agents, but there was no `/admin/api/studio/*` path for it
 * at all — the Properties panel's own "Card uses useState — duplicate it as
 * Card2.tsx and edit that instead?" offer (instance-ui-01) had nothing to
 * call. Exactly the "engine shipped, nothing invokes it" gap this work order
 * exists to close (see STATE.md's `parser-05` entry, "Honest gaps" #3).
 *
 * Not folded into `POST /admin/api/studio/save`'s `StudioEdit` union: every
 * kind in that union applies to exactly the calling node's own location and
 * returns a plain applied/refused outcome. Extract additionally MINTS a
 * brand-new file and a brand-new component name — the caller needs both
 * back to know what just happened (and, in the panel, to say so) — which
 * doesn't fit that union's shared response shape without special-casing it
 * there too. One field, one job, same reasoning `trustTier.ts` documents for
 * its own narrow sub-router.
 *
 *   POST /admin/api/studio/extract-component  body: { dir?, nodeId }
 *     -> `{ ok: true, newFile, newComponentName, undoToken? }` on success —
 *        the SAME call site now points at the copy (an ordinary
 *        `swap`-shaped structural rewrite under the hood), so the client
 *        reloads exactly the way it does for a successful swap. `undoToken`
 *        (P3-F) names the undo-journal entry that puts the call site back
 *        and removes the copy: the editor posts it as a `restore` edit.
 *     -> `{ ok: false, reason, message }` on refusal (`not-a-component`,
 *        `unresolvable`, `copy-exists`) — never a silent no-op.
 */
import { join } from 'node:path'
import { extractComponentCopy } from '@core/ast-codemods'
import { withProjectWriteLock } from './projectWriteLock'
import { captureUndoPreImage, recordUndoJournal } from './undoJournal'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody, internalServerError } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { studioEditLocation } from '../studioWriteback'

const ROUTE_PATH = '/admin/api/studio/extract-component'

const ExtractComponentBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  /** A `studio.instance` node's own id — the call site's plain (non-composite) location. */
  nodeId: Type.String(),
})
export type ExtractComponentBody = Static<typeof ExtractComponentBodySchema>

/** `POST /admin/api/studio/extract-component` — see module doc for the full contract. */
export async function tryServeStudioExtractComponent(req: Request, _url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'POST') return null

  try {
    const body = await readValidatedBody(req, ExtractComponentBodySchema)
    if (!body) return badRequest('invalid extract-component body')
    const dir = resolveProjectDir(body.dir)

    const target = studioEditLocation(dir, body.nodeId)
    if (!target) {
      // Mirrors `applyStudioEdit`'s own "no writable source location" outcome
      // for every other edit kind — a synthetic/unresolvable node id is not
      // an unexpected error, just nothing this route can act on.
      return jsonResponse({
        ok: false,
        reason: 'unresolvable',
        message: 'This node has no writable source location.',
      })
    }

    const file = join(dir, target.rel)
    // Under the project write lock like every other writer — a git verb must
    // never see half of it — which is also what makes the journal's
    // pre-image and the write one step.
    const outcome = await withProjectWriteLock(dir, () => {
      const preImage = captureUndoPreImage([file])
      const result = extractComponentCopy({ file, line: target.line, col: target.col, workspaceRoot: dir })
      if (!result.ok) return { result }
      return { result, undoToken: recordUndoJournal(dir, preImage, [join(dir, ...result.newFile.split('/'))]) }
    })
    const { result } = outcome
    if (!result.ok) {
      return jsonResponse({ ok: false, reason: result.refusal.reason, message: result.refusal.message })
    }
    return jsonResponse({
      ok: true,
      newFile: result.newFile,
      newComponentName: result.newComponentName,
      ...(outcome.undoToken ? { undoToken: outcome.undoToken } : {}),
    })
  } catch (err) {
    rethrowProjectDirRefusal(err)
    return internalServerError('[studio:extractComponent]', err)
  }
}
