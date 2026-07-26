/**
 * DashboardPage — `/admin/dashboard`, the studio Overview.
 *
 * The admin home is a project launcher: a searchable grid of every studio
 * project (each an immediate subfolder of `studio-workspace/`, listed by
 * `GET /admin/api/studio/projects`). Opening a project points Studio at its
 * directory (`setStudioWorkspaceDir`) and jumps into the Site editor's studio
 * canvas; "New project" scaffolds a fresh, blank folder + starter page via
 * `createStudioProject()` (no name prompt — the project starts `Untitled`,
 * `Untitled 2`, … and is renamed later from the toolbar) and drops straight
 * into it.
 *
 * `requestCmsSiteReload()` is called before every `openProject` (new or
 * existing) so `usePersistence`'s mount effect doesn't short-circuit on a
 * still-mounted, previous project's `existingSite` — without it, switching
 * projects in the same session can leave the previous project's page tree
 * showing under the new project's directory.
 *
 * This replaced the old CMS widget-grid dashboard: the app now presents as a
 * studio-first project launcher, reached from the toolbar brand (the logo).
 */
import { useState } from 'react'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { setStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import {
  createStudioProject,
  useStudioProjects,
  type StudioProject,
} from './hooks/useStudioProjects'
import styles from './DashboardPage.module.css'

function greetingFor(displayName: string | null | undefined): string {
  const hour = new Date().getHours()
  const time = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = displayName?.split(' ')[0] ?? 'there'
  return `Good ${time}, ${name}.`
}

export function DashboardPage() {
  const currentUser = useAuthenticatedAdminUser()
  const navigate = useAdminNavigate()
  const projects = useStudioProjects()

  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  // Projects created this session, layered over the fetched list so a new
  // project shows up immediately without waiting for a refetch.
  const [created, setCreated] = useState<StudioProject[]>([])

  const isLoading = projects === null
  // Merge fetched + session-created, de-duped by dir (a refetch may already
  // include a just-created one).
  const merged = Array.from(
    new Map([...(projects ?? []), ...created].map((p) => [p.dir, p])).values(),
  )
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? merged.filter((p) => p.name.toLowerCase().includes(needle))
    : merged

  function openProject(project: StudioProject) {
    // Force the next Site-editor mount to reload from disk instead of
    // short-circuiting on a previous project's still-mounted `existingSite`.
    requestCmsSiteReload()
    setStudioWorkspaceDir(project.dir)
    navigate('/admin/site?studio')
  }

  async function handleCreate() {
    if (busy) return
    setBusy(true)
    try {
      const project = await createStudioProject()
      setCreated((prev) => [...prev, project])
      openProject(project)
    } catch (err) {
      console.error('[DashboardPage] create project failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not create project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminPageLayout
      workspace="dashboard"
      title={greetingFor(currentUser.displayName)}
      description="Your studio projects — open one to keep editing, or start a new one."
    >
      <div className={styles.toolbar}>
        <SearchBar
          value={query}
          onValueChange={setQuery}
          placeholder="Search projects…"
          aria-label="Search projects"
          className={styles.search}
        />
        <Button variant="primary" onClick={() => void handleCreate()} disabled={busy}>
          <PlusIcon size={12} aria-hidden="true" /> New project
        </Button>
      </div>

      {isLoading ? (
        <p className={styles.state}>Loading projects…</p>
      ) : filtered.length === 0 ? (
        <p className={styles.state}>
          {needle
            ? `No projects match “${query.trim()}”.`
            : 'No projects yet — create one to get started.'}
        </p>
      ) : (
        <ul className={styles.grid}>
          {filtered.map((project) => (
            <li key={project.dir}>
              <button
                type="button"
                className={styles.card}
                onClick={() => openProject(project)}
              >
                <span className={styles.cardIcon}>
                  <FolderGlyphIcon size={22} aria-hidden="true" />
                </span>
                <span className={styles.cardName}>{project.name}</span>
                <span className={styles.cardMeta}>
                  {project.pageCount} page{project.pageCount === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </AdminPageLayout>
  )
}
