/**
 * `GET|POST /admin/api/studio/token-catalog` - the project's design tokens as
 * a catalog with modes and usage (CT-1), and the one write path for them from
 * the editor (CT-2). Declared in `routeCapabilities.ts` (GET `site.read`,
 * POST `studio.write`); `studio/routeGate.ts` has already checked the
 * capability and the Origin by the time this runs.
 *
 *   GET  ?dir=<abs>[&usage=1]  -> `TokenCatalog` (`@core/studio-tokens`)
 *        `usage=1` adds where each token is read, and the values a JavaScript
 *        theme defines (`jsTheme`, read-only, CT-6); the picker does not ask,
 *        the Variables panel does.
 *   POST { dir, edits: TokenEdit[] } -> { ok, files, changed, unchanged, inserted, renamed, removed, undoToken }
 *        `set` changes the ONE declaration that is a token for a mode;
 *        `insert` declares a new token (or a new mode of one, or the
 *        project's override of a package token). All-or-nothing; the plan is
 *        `tokenWrite.ts`'s `planTokenEdits`, the SAME planner `studio_set_tokens`
 *        uses. A `rename` or `remove` (CT-3) is the only edit of its request:
 *        it rewrites every mention of the token across the project's source
 *        (`tokenRefactor.ts`). Every write is journaled (`undoJournal.ts`):
 *        `undoToken` is what one undo posts back. A refusal is a 422 `{ error, code, remedy?, entryIndex }`
 *        (409 `stale-source` when a file moved since it was read).
 *
 * The write holds `withProjectWriteLock`, re-reads each file inside it and
 * refuses `stale-source` if it no longer equals what the plan was made
 * against, and goes through the agent file gate's containment rule
 * (`resolveAgentFilePath`) so a stylesheet outside the project, under
 * `.studio/` or behind a link is refused here exactly as for the file tools.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { TokenEditSchema } from '@core/studio-tokens'
import { writeFileAtomic } from '@core/page-parser'
import { toLf } from '@core/utils/lineEndings'
import { internalServerError, jsonResponse, readValidatedBody, badRequest } from '../../http'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../studioProjects'
import { contentHash, hasOtherHardLinks, readTextFile, resolveAgentFilePath, statIfPresent } from './agentFileAccess'
import { ProjectWriteLockBusyError, withProjectWriteLock } from './projectWriteLock'
import { collectProjectTokenSources } from './projectTokenSources'
import { buildTokenCatalog, scanTokenUsage, themeTokenNames, withTokenUsage } from './tokenCatalog'
import { extractJsThemeEntries } from './tokenExtractJsTheme'
import { planTokenEdits } from './tokenWrite'
import type { TokenWriteCode } from './tokenWriteTypes'
import { readTokenWorkspaceFiles } from './tokenWorkspaceFiles'
import { captureUndoPreImage, recordUndoJournal } from './undoJournal'

const ROUTE_PATH = '/admin/api/studio/token-catalog'
/** Edits per request - a palette, bounded. */
const MAX_EDITS = 40
/** Same ceiling the agent file tools use for a text file. */
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

const PostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  edits: Type.Array(TokenEditSchema, { minItems: 1, maxItems: MAX_EDITS }),
})

function refusalResponse(code: TokenWriteCode | 'path-outside-project' | 'protected-path' | 'needs-user' | 'not-text', message: string, entryIndex: number, remedy?: string, declarations?: readonly string[]): Response {
  return jsonResponse(
    { error: remedy ? `${message} ${remedy}` : message, code, entryIndex, ...(remedy ? { remedy } : {}), ...(declarations ? { details: { declarations } } : {}) },
    { status: code === 'stale-source' ? 409 : 422 },
  )
}

export async function tryServeStudioTokenCatalog(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      const sources = await collectProjectTokenSources(dir)
      const catalog = buildTokenCatalog(sources)
      // `usage=1` is the Variables panel's full read: where each token is read, and the
      // values a JavaScript theme (a Tailwind v3 config, a theme.ts) defines.
      if (url.searchParams.get('usage') !== '1') return jsonResponse(catalog)
      return jsonResponse({ ...withTokenUsage(catalog, scanTokenUsage(dir, themeTokenNames(catalog))), jsTheme: extractJsThemeEntries(dir) })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      return internalServerError('[studio:tokenCatalog]', err)
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, PostBodySchema)
      if (!body) return badRequest('invalid token-catalog body')
      const dir = resolveProjectDir(body.dir)

      // The scan may compile the project's styles, so it runs outside the lock;
      // the lock re-reads every file and refuses if one moved since.
      const sources = await collectProjectTokenSources(dir)
      // Only a rename or remove reads the project's other files (all of them: a
      // Tailwind theme name is also spelled as classes, which hold no `--`).
      const needsWorkspace = body.edits.some((edit) => edit.op === 'rename' || edit.op === 'remove')
      const plan = planTokenEdits(sources, body.edits, needsWorkspace ? readTokenWorkspaceFiles(dir, { allText: true }) : [])
      if (!plan.ok) return refusalResponse(plan.code, plan.message, plan.entryIndex, plan.remedy, plan.details?.declarations)

      return await withProjectWriteLock(dir, () => {
        const writes: Array<{ abs: string; rel: string; original: string; next: string }> = []
        for (const file of plan.files) {
          const target = resolveAgentFilePath(dir, file.file, 'write')
          if (!target.ok) return refusalResponse(target.code, target.message, 0, target.remedy)
          const stat = statIfPresent(target.abs)
          if (stat && hasOtherHardLinks(stat)) {
            return refusalResponse('protected-path', `"${target.rel}" has other hard-linked names on disk, so writing it would change them too.`, 0)
          }
          const read = readTextFile(target.abs, MAX_STYLESHEET_BYTES)
          if (read.kind !== 'text') return refusalResponse('not-text', `"${target.rel}" could not be read as a text stylesheet.`, 0)
          if (toLf(read.content) !== toLf(file.original)) {
            return refusalResponse('stale-source', `"${target.rel}" changed while its tokens were being read, so nothing was written.`, 0, 'Try again; the file is re-read.')
          }
          writes.push({ abs: target.abs, rel: target.rel, original: read.content, next: file.next })
        }

        const preImage = captureUndoPreImage(writes.map((write) => write.abs))
        const written: typeof writes = []
        try {
          for (const write of writes) {
            writeFileAtomic(write.abs, write.next)
            written.push(write)
          }
        } catch (err) {
          for (const write of written) {
            try {
              writeFileAtomic(write.abs, write.original)
            } catch (restoreErr) {
              console.error('[studio:tokenCatalog] could not restore a stylesheet after a failed batch write:', write.rel, restoreErr)
            }
          }
          return internalServerError('[studio:tokenCatalog]', err)
        }

        return jsonResponse({
          ok: true,
          // What puts the stylesheets (and, for a rename, the source files) back
          // byte for byte; `null` when the write could not be journaled.
          undoToken: recordUndoJournal(dir, preImage),
          files: writes.map((write) => ({ path: write.rel, hash: contentHash(write.next) })),
          changed: plan.changed,
          unchanged: plan.unchanged,
          inserted: plan.inserted,
          renamed: plan.renamed,
          removed: plan.removed,
        })
      })
    } catch (err) {
      if (err instanceof ProjectWriteLockBusyError) return jsonResponse({ error: err.message, code: 'busy' }, { status: 409 })
      rethrowProjectDirRefusal(err)
      return internalServerError('[studio:tokenCatalog]', err)
    }
  }

  return null
}
