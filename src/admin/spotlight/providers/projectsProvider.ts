/**
 * Projects provider — "Open project …" in ⌘K.
 *
 * Opening a different project is the one navigation the palette could not do:
 * it required going back to `/admin/dashboard` and finding the tile. This
 * provider puts every on-disk project one keystroke away from anywhere in the
 * admin, which is what a command palette is for.
 *
 * REMOTE provider (`GET /admin/api/studio/projects`), unlike `pagesProvider`'s
 * local store read — so it carries the default debounce. It is built on
 * `fetchOnAbortEmpty` rather than `makeServerProvider`: this endpoint takes no
 * `?query=` (it lists every folder under `studio-workspace/`, which is small)
 * and the match therefore happens client-side, which is exactly the
 * "genuinely different shape" case that primitive exists for.
 *
 * An EMPTY query still lists, the way `pagesProvider` does — a user who opens
 * ⌘K to switch projects should see which ones there are, and the
 * `ProviderRunner`'s 30-second cache keeps that to one request per palette
 * session rather than one per keystroke.
 *
 * Opening is the same three steps the launcher performs, in the same order and
 * for the same reasons: `requestCmsSiteReload()` so the next Site-editor mount
 * reloads from disk rather than short-circuiting on the previous project's
 * still-mounted `existingSite`, then `setStudioWorkspaceDir`, then navigate.
 * Doing it here rather than routing through the dashboard is the point — the
 * palette must not make you look at the launcher on the way.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { setStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import type { Command, SpotlightProvider } from '../types'
import { MAX_RESULTS, fetchOnAbortEmpty } from './serverProvider'

/**
 * Only the three fields a palette row needs. The endpoint's answer is richer
 * (badges, trust tier, last-edited — see `StudioProjectSummary`), and
 * `additionalProperties: true` lets those through unread: a row is a name and
 * a destination, and validating fields nobody renders would tie this file to a
 * shape it has no opinion about.
 */
const ProjectsResponseSchema = Type.Object(
  {
    projects: Type.Array(
      Type.Object(
        { dir: Type.String(), name: Type.String(), pageCount: Type.Number() },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

export const projectsProvider: SpotlightProvider = {
  id: 'projects',
  label: 'Projects',

  async search(query, _ctx, signal): Promise<Command[]> {
    const body = await fetchOnAbortEmpty('/admin/api/studio/projects', ProjectsResponseSchema, signal)
    // `null` means the runner cancelled this call (a new keystroke), not a
    // failure. Nothing to render, nothing to report.
    if (body === null) return []

    const needle = query.trim().toLowerCase()
    const matched = needle
      ? body.projects.filter((project) => project.name.toLowerCase().includes(needle))
      : body.projects

    return matched.slice(0, MAX_RESULTS).map((project): Command => ({
      id: `project:${project.dir}`,
      title: `Open ${project.name}`,
      subtitle: `${project.pageCount} page${project.pageCount === 1 ? '' : 's'}`,
      group: 'navigation',
      iconName: 'folder-glyph',
      keywords: ['project', 'open', 'switch', 'workspace', project.name],
      workspaces: ['any'],
      capability: 'site.read',
      run: (ctx) => {
        ctx.closeSpotlight()
        requestCmsSiteReload()
        setStudioWorkspaceDir(project.dir)
        ctx.navigate('/admin/site')
      },
    }))
  },
}
