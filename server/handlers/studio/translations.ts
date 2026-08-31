/**
 * translations — `GET/POST /admin/api/studio/translations`, the read/write
 * surface behind the editor's Content panel.
 *
 *   GET  ?dir=<abs>
 *     -> `{ catalog: … | null, hardcoded: HardcodedString[] }`
 *        `catalog: null` means the project declares no locales at all — a
 *        distinct answer from an empty `entries` array, and the panel says a
 *        different thing about each. `hardcoded` is the copy written inline
 *        in the JSX (`findHardcodedStrings`), which is the ONLY content a
 *        project without a dictionary has: without it the panel could only
 *        tell such a project it had nothing, which is the opposite of true.
 *        Both are returned every time — a project WITH a dictionary can still
 *        have strings that never made it in.
 *
 *   POST { dir?, locale, key, value }
 *     -> `{ ok: true }` | `{ ok: false, message }`
 *        Writes ONE entry into the project's own dictionary. A structured
 *        refusal (`ok: false`) is a 200, not a 4xx: "this key holds a
 *        function call, so Studio won't overwrite it" is an answer about the
 *        user's source, not a failed request — the same posture the studio
 *        writeback routes take with their refusal lists.
 *
 * Same containment posture as every other project-scoped route:
 * `resolveProjectDir` + `isRealpathContained(dir, projectsRootDir())`.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { readTranslationCatalog } from './translationCatalog'
import { findHardcodedStrings } from './hardcodedStrings'
import { writeTranslationEntry } from './translationWrite'

const ROUTE_PATH = '/admin/api/studio/translations'

const WriteBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  locale: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
  value: Type.String(),
})

export async function tryServeStudioTranslations(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  try {
    if (req.method === 'GET') {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      const catalog = readTranslationCatalog(dir)
      return jsonResponse({
        hardcoded: findHardcodedStrings(dir),
        catalog: catalog
          ? {
              capability: catalog.capability,
              perLocaleFiles: catalog.perLocaleFiles,
              entries: catalog.entries,
            }
          : null,
      })
    }

    if (req.method === 'POST') {
      const body = await readValidatedBody(req, WriteBodySchema)
      // `readValidatedBody` returns null for an unparsable/invalid body — a
      // malformed request, distinct from the structured refusal below.
      if (!body) return badRequest('Expected { locale, key, value }.')
      const dir = resolveProjectDir(body.dir ?? null)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
      return jsonResponse(writeTranslationEntry(dir, { locale: body.locale, key: body.key, value: body.value }))
    }

    return null
  } catch (err) {
    console.error('[studio:translations]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
