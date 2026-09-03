/**
 * projectRoutes — the project-lifecycle HTTP surface: list, create, rename,
 * and scaffold-a-page. Split out of `studio.ts` (`module-size-budgets`'s
 * 700-line ceiling) as its own `tryServeStudioProjectRoutes` sub-router — the
 * same pattern every other `STUDIO_SUB_ROUTERS` entry in `studio.ts` already
 * follows: one concern, one file, `null` for a path it does not own.
 *
 *   GET  /admin/api/studio/projects
 *       Lists every on-disk studio project the Overview launcher can open.
 *       Read-only — never creates, clears, or writes a directory.
 *
 *   POST /admin/api/studio/create   body: { name? }
 *       Scaffolds a new project: one slugified folder under
 *       `studio-workspace/` with a starter `pages/Home.tsx`. Returns the
 *       created `{ project }`.
 *
 *   POST /admin/api/studio/rename   body: { dir?, name }
 *       Renames a project's DISPLAY name — never touches the folder (a
 *       stable identifier assigned once at creation). Just rewrites
 *       `.studio/meta.json`.
 *
 *   DELETE /admin/api/studio/page   body: { dir?, pageId }
 *       Deletes a page for real — its source file, a stylesheet nothing else
 *       imports any more, its board frames, and any directory those leave
 *       empty. See `./pageDelete.ts` for what it deliberately does NOT touch.
 *
 *   POST /admin/api/studio/delete   body: { dir }
 *       Deletes a project RECOVERABLY — moves its folder into
 *       `studio-workspace/.trash/` (`./projectTrash.ts`). Returns the
 *       refreshed `{ projects }` so the launcher can redraw without a
 *       second round trip.
 *
 *       Unlike every other route here, `dir` is REQUIRED and is never fed
 *       through `resolveProjectDir`: that helper's no-dir fallback resolves
 *       to the first project on disk, which on a delete would turn a client
 *       bug into deleting a project nobody named.
 *
 *       This is also the one route in this file that checks a capability,
 *       which is why the sub-router now takes a `runtime`. See the note on
 *       `tryServeStudioProjectRoutes` below.
 *
 *   POST /admin/api/studio/page   body: { dir?, name? }
 *       WS-13 step 4 — scaffolds a new page CANONICAL BY CONSTRUCTION, one
 *       starter file, auto-placed on the board's first board at the next
 *       free grid slot. `name` is optional — omit it for the one-click "New
 *       page" action and the server auto-names it `Page`, `Page2`, ….
 *
 * See `studio.ts`'s own module doc for the full behavioural writeup of each
 * route — this module only moved the wiring, not the meaning.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { DEFAULT_PAGE_KIND, DEFAULT_PROJECT_PLATFORM, frameDefaultsForPlatform, PageKindSchema } from '@core/studio-board'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { ProjectTrashError, trashStudioProject } from './projectTrash'
import { applyProjectSeed } from './projectSeed'
import { generateStudioProjectGuide } from './projectGuide'
import { deleteStudioPage } from './pageDelete'
import { createScaffoldedPage } from './pageScaffold'
import { detectPageTemplateKit, starterPage } from './pageTemplates'
import {
  discoverPageFiles,
  listStudioProjects,
  nextProjectName,
  projectPagesDir,
  projectsRootDir,
  renameProjectDisplayName,
  resolveProjectDir,
  safeProjectFolderName,
  writeProjectMeta,
  type StudioProjectSummary,
} from '../studioProjects'

/**
 * Body of POST /admin/api/studio/create — scaffold a new project folder.
 * `name` is optional: the "New project" dashboard action omits it entirely
 * (no name-prompt UI) and the server auto-names it `Untitled`, `Untitled 2`, ….
 *
 * `platform` is the form factor the dashboard asks for before creating — it
 * decides the `frameDefaults` every screen in this project starts at (see
 * `@core/studio-board`'s `platformPresets.ts`). Optional so a scripted or
 * older client that omits it still creates a working project; it then gets
 * `DEFAULT_PROJECT_PLATFORM`.
 */
const CreateProjectBodySchema = Type.Object({
  name: Type.Optional(Type.String()),
  platform: Type.Optional(Type.Union([Type.Literal('mobile'), Type.Literal('web')])),
})

/** Body of POST /admin/api/studio/rename — change a project's display name. */
const RenameProjectBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  name: Type.String(),
})

/**
 * Body of POST /admin/api/studio/page — scaffold a new page in a project.
 *
 * `name` is optional: when omitted (the "New page" action) the server auto-names
 * it from the kind's own base — `Page`, `Page2`, … for a screen, `Sheet`,
 * `Sheet2`, … for a bottom sheet.
 *
 * `kind` is optional too, so a scripted or older client that omits it still
 * creates a working page; it then gets `DEFAULT_PAGE_KIND` — an ordinary
 * screen, which is what this route has always produced.
 */
const CreatePageBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  kind: Type.Optional(PageKindSchema),
  /**
   * Which board the author is looking at, so the new page's frame lands there
   * rather than on whichever board happens to be first in the file. Optional:
   * a headless caller has no board open, and gets the first-board fallback
   * `autoPlaceBoardFrame` has always applied.
   */
  boardId: Type.Optional(Type.String()),
})

/**
 * Body of DELETE /admin/api/studio/page — remove a page from the project.
 *
 * `pageId`, never a path: the id is resolved back to a file by re-running the
 * loader's own id assignment (`pageDelete.ts`), so a caller cannot name a file
 * outside the project's pages directory in the first place.
 */
const DeletePageBodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  pageId: Type.String(),
})

/** Body of POST /admin/api/studio/delete. `dir` is required — see the module doc. */
const DeleteProjectBodySchema = Type.Object({
  dir: Type.String(),
})

/**
 * `runtime` is here for ONE route: `/delete` is capability-gated and needs the
 * `DbClient` to resolve the session. That is the same reason
 * `tryServeStudioComments` takes one, and it is why both are called outside
 * `STUDIO_SUB_ROUTERS`' plain `(req, url, pathname)` loop in `studio.ts`.
 */
export async function tryServeStudioProjectRoutes(
  req: Request,
  runtime: { db: DbClient },
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  // List every on-disk studio project for the Overview launcher. Read-only:
  // never creates, clears, or writes a directory.
  if (pathname === '/admin/api/studio/projects' && req.method === 'GET') {
    try {
      const projects = listStudioProjects(projectsRootDir())
      return jsonResponse({ projects })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Scaffold a new project — one folder under studio-workspace/ with a starter
  // page. An explicit name (if any) is slugified to a filesystem-safe folder
  // (never `..`, never a separator) so it can't escape the projects root; when
  // omitted, the folder is slugified from an auto-generated "Untitled" name
  // instead. Either way, the DISPLAY name (which may differ from the folder
  // once renamed later) is recorded in `.studio/meta.json`.
  if (pathname === '/admin/api/studio/create' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, CreateProjectBodySchema)
      if (!body) return badRequest('invalid create body')
      const requested = body.name?.trim()
      const displayName = requested || nextProjectName(projectsRootDir())
      const folder = safeProjectFolderName(displayName)
      if (!folder) return badRequest('project name must contain at least one letter or digit')
      const dir = join(projectsRootDir(), folder)
      if (existsSync(dir)) {
        return jsonResponse({ error: `A project named "${folder}" already exists.` }, { status: 409 })
      }
      const pagesDir = projectPagesDir(dir)
      mkdirSync(pagesDir, { recursive: true })
      // A brand-new folder has no `package.json` yet (the seed lands further
      // down), so this is always the plain kit — which is what a screen
      // scaffolds as under either one.
      const home = starterPage('Home', DEFAULT_PAGE_KIND, detectPageTemplateKit(dir))
      writeFileSync(join(pagesDir, 'Home.tsx'), home.component)
      if (home.styles !== undefined && home.stylesFileName !== undefined) {
        writeFileSync(join(pagesDir, home.stylesFileName), home.styles)
      }
      // The chosen form factor, and the frame size it implies. `frameDefaults`
      // is the field the board actually reads (`boardSlice`'s `addFrame`, and
      // `pageScaffold.ts` server-side), so every page added to this project
      // later opens at the right width without being resized by hand.
      const platform = body.platform ?? DEFAULT_PROJECT_PLATFORM
      writeProjectMeta(dir, { displayName, platform, frameDefaults: frameDefaultsForPlatform(platform) })
      // Design system + its declared dependency, copied from the local seed —
      // AFTER the scaffolder's own files, which the seed never overwrites.
      // Best-effort: a project without a seed is exactly what it used to be.
      // See `projectSeed.ts` for why this copies rather than installs.
      applyProjectSeed(dir)
      // `CLAUDE.md` + the design-system references, written now rather than on
      // the first chat turn — a project is never briefly one where the design
      // system is on disk but nothing tells the agent what is in it. AFTER the
      // seed: everything it generates is derived from what the seed just wrote.
      generateStudioProjectGuide(dir)
      const project: StudioProjectSummary = { dir, name: displayName, pageCount: 1 }
      return jsonResponse({ project })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Delete a project — recoverably. Nothing is erased: the folder is moved
  // into `studio-workspace/.trash/`, because `studio-workspace/<project>/` is
  // the user's own repository with no other copy. See `./projectTrash.ts`.
  if (pathname === '/admin/api/studio/delete' && req.method === 'POST') {
    // The only capability check in this file. Deleting a project is the most
    // destructive thing this API can do, so it does not ship ungated — even
    // though its neighbours here still are, which is a real gap and not a
    // precedent this route is following.
    const user = await requireCapability(req, runtime.db, 'studio.write')
    if (user instanceof Response) return user
    try {
      const body = await readValidatedBody(req, DeleteProjectBodySchema)
      if (!body) return badRequest('invalid delete body')
      const requested = body.dir.trim()
      if (!requested) return badRequest('delete requires an explicit project dir')
      trashStudioProject(projectsRootDir(), requested)
      return jsonResponse({ projects: listStudioProjects(projectsRootDir()) })
    } catch (err) {
      if (err instanceof ProjectTrashError) {
        return jsonResponse({ error: err.message }, { status: err.reason === 'not-found' ? 404 : 400 })
      }
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Rename a project's DISPLAY name — never touches the folder (a stable
  // identifier assigned once at creation; renaming it mid-session would
  // invalidate any already-open `studioWorkspaceDir` pointer). Just rewrites
  // `.studio/meta.json`.
  if (pathname === '/admin/api/studio/rename' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, RenameProjectBodySchema)
      if (!body) return badRequest('invalid rename body')
      const displayName = body.name.trim()
      if (!displayName) return badRequest('project name must not be empty')
      const dir = resolveProjectDir(body.dir)
      if (!existsSync(dir)) return jsonResponse({ error: 'Project not found.' }, { status: 404 })
      renameProjectDisplayName(dir, displayName)
      const pagesDir = projectPagesDir(dir)
      const pageCount = existsSync(pagesDir) ? discoverPageFiles(pagesDir).length : 0
      const project: StudioProjectSummary = { dir, name: displayName, pageCount }
      return jsonResponse({ project })
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Scaffold a new page in a project — WS-13 step 4: canonical by
  // construction, auto-placed on the board, with a real `rootNodeId`. The
  // name is turned into a PascalCase identifier (never `..`, never a
  // separator) so it can't escape the project's pages/ dir. See
  // `./pageScaffold.ts`.
  if (pathname === '/admin/api/studio/page' && req.method === 'POST') {
    try {
      const body = await readValidatedBody(req, CreatePageBodySchema)
      if (!body) return badRequest('invalid page body')
      const result = createScaffoldedPage(resolveProjectDir(body.dir), body.name ?? '', body.kind ?? DEFAULT_PAGE_KIND, body.boardId)
      if (!result.ok) return jsonResponse({ error: result.conflict }, { status: 409 })
      return jsonResponse(result)
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  // Delete a page for real: its file, its orphaned stylesheet, its board
  // frames. The editor store's own `deletePage` only ever spliced the page out
  // of the in-memory tree, so the next reload parsed the untouched `.tsx`
  // straight back in — see `./pageDelete.ts`.
  if (pathname === '/admin/api/studio/page' && req.method === 'DELETE') {
    try {
      const body = await readValidatedBody(req, DeletePageBodySchema)
      if (!body) return badRequest('invalid delete page body')
      const result = deleteStudioPage(resolveProjectDir(body.dir), body.pageId)
      if (!result.ok) return jsonResponse({ error: result.notFound }, { status: 404 })
      return jsonResponse(result)
    } catch (err) {
      console.error('[studio]', err)
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }
  }

  return null
}
