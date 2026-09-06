/**
 * storiesRoutes — `GET/POST /admin/api/studio/stories`, W5-3's read/write
 * surface for a project's Storybook import.
 *
 *   GET  /admin/api/studio/stories?dir=<abs>
 *     -> `{ enabled, files, stories, refusals }`. `stories` is what became a
 *        board frame; `refusals` is every story (or whole file) that did NOT,
 *        each with a NAMED reason and one sentence about what was in the
 *        source. This is the only place those refusals surface: a refusal a
 *        user cannot read is indistinguishable from a parser that silently
 *        lost their work, and the `/load` envelope is a delicate NDJSON
 *        contract this has no business growing into (same reasoning
 *        `previewAxes.ts` gives for staying out of it).
 *   POST /admin/api/studio/stories { dir, enabled }
 *     -> `{ ok: true, enabled }`. The explicit off switch. `false` stops
 *        stories being parsed into pages and placed on the board at all;
 *        already-placed frames are left exactly where they are, because
 *        deleting a board the user has been arranging is not what "turn this
 *        off" means.
 *
 * Costs nothing on a project with no story files: `storyFilesIn` is a filename
 * filter over the directory walk, and the expensive `createWorkspaceProject`
 * below only happens once it matches something.
 *
 * Same containment posture as every other project-scoped route:
 * `resolveProjectDir` + `isRealpathContained(dir, projectsRootDir())`.
 */
import { createWorkspaceProject } from '@core/page-parser'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { mergeStudioMeta, readStudioMeta } from './studioMeta'
import { discoverStories, storyFilesIn } from './storyDiscovery'

const ROUTE_PATH = '/admin/api/studio/stories'

const StoriesPostBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  enabled: Type.Boolean(),
})

/** `GET/POST /admin/api/studio/stories` — see module doc for the full contract. */
export async function tryServeStudioStories(req: Request, url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH) return null

  if (req.method === 'GET') {
    try {
      const dir = resolveProjectDir(url.searchParams.get('dir'))
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      const enabled = readStudioMeta(dir).stories?.enabled !== false
      const files = storyFilesIn(dir)
      if (files.length === 0) return jsonResponse({ enabled, files, stories: [], refusals: [] })

      const { stories, refusals } = discoverStories(dir, createWorkspaceProject(dir), files)
      return jsonResponse({ enabled, files, stories: stories.map((story) => story.summary), refusals })
    } catch (err) {
      console.error('[studio:stories]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, StoriesPostBodySchema)
      if (!body) return badRequest('invalid stories body')
      const dir = resolveProjectDir(body.dir)
      if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })

      const existing = readStudioMeta(dir).stories ?? {}
      mergeStudioMeta(dir, { stories: { ...existing, enabled: body.enabled } })
      return jsonResponse({ ok: true, enabled: body.enabled })
    } catch (err) {
      console.error('[studio:stories]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
