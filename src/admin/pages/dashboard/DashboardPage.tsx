/**
 * DashboardPage — `/admin/dashboard`, the studio Overview.
 *
 * The admin home is a project launcher: a searchable grid of every studio
 * project (each an immediate subfolder of `studio-workspace/`, listed by
 * `GET /admin/api/studio/projects`). Opening a project points Studio at its
 * directory (`setStudioWorkspaceDir`) and jumps into the Site editor's studio
 * canvas; "New project" scaffolds a fresh, blank folder + starter page via
 * `createStudioProject()` and drops straight into it. "New project" first
 * opens `NewProjectDialog` to ask the one question that cannot be changed
 * cheaply afterwards — mobile or web — because that answer becomes the
 * project's `frameDefaults`, the size every screen in it opens at. The name
 * stays optional there, so the previous one-click behaviour (auto-named
 * `Untitled`, `Untitled 2`, … and renamed later from the toolbar) is still one
 * Enter away.
 *
 * "Import project" is its peer, not a Studio-toolbar-only action. Opening an
 * existing React repository — from GitHub, a `.zip`, or a local folder — is
 * the product's core entry path, and it used to be reachable only from inside
 * the Studio toolbar, which meant scaffolding a throwaway project first just
 * to get at it. Both buttons sit in the launcher toolbar and in the empty
 * state, so a fresh install has two honest ways to start. The dialog itself
 * (`LazyImportProjectDialog`) is shared with the toolbar, not duplicated; it
 * already points Studio at the imported directory, so this page's `onImported`
 * only has to navigate.
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
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { LazyImportProjectDialog } from '@admin/shared/dialogs/ImportProjectDialog'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { setStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import type { ProjectPlatform } from '@core/studio-board'
import {
  createStudioProject,
  useStudioProjects,
  type StudioProject,
} from './hooks/useStudioProjects'
import { NewProjectDialog } from './NewProjectDialog'
import styles from './DashboardPage.module.css'

// Placeholder tiles shown while the project list is in flight — enough to
// read as "a grid of project cards is about to appear", not so many that the
// page reflows dramatically once the real (usually shorter) list lands.
const SKELETON_TILE_KEYS = ['a', 'b', 'c', 'd', 'e', 'f'] as const

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
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
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
    navigate('/admin/site')
  }

  async function handleCreate(options: { name?: string; platform: ProjectPlatform }) {
    if (busy) return
    setBusy(true)
    try {
      const project = await createStudioProject(options)
      setCreated((prev) => [...prev, project])
      setCreateOpen(false)
      openProject(project)
    } catch (err) {
      console.error('[DashboardPage] create project failed:', err)
      // The dialog stays open on failure so the entered name and chosen
      // platform survive a name collision (409) and can be corrected in place.
      pushToast({
        kind: 'error',
        title: 'Could not create project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setBusy(false)
    }
  }

  const newProjectButton = (
    <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={busy}>
      <PlusIcon size={12} aria-hidden="true" /> New project
    </Button>
  )
  const importProjectButton = (
    <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={busy}>
      <CodeIcon size={12} aria-hidden="true" /> Import project
    </Button>
  )

  return (
    <AdminPageLayout
      workspace="dashboard"
      title={greetingFor(currentUser.displayName)}
      description="Your studio projects — open one to keep editing, start a new one, or import an existing React repository."
    >
      <div className={styles.toolbar}>
        <SearchBar
          value={query}
          onValueChange={setQuery}
          placeholder="Search projects…"
          aria-label="Search projects"
          className={styles.search}
        />
        {importProjectButton}
        {newProjectButton}
      </div>

      {isLoading ? (
        <ul className={styles.grid} aria-busy="true" aria-label="Loading projects">
          {SKELETON_TILE_KEYS.map((key) => (
            <li key={key} className={styles.cardSkeleton}>
              <SkeletonBlock />
            </li>
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        needle ? (
          <EmptyState
            variant="centered"
            size="large"
            title={`No projects match “${query.trim()}”.`}
            description="Try a different search, or clear it to see every project."
          />
        ) : (
          <EmptyState
            variant="centered"
            size="large"
            icon={<FolderGlyphIcon size={22} aria-hidden="true" />}
            title="No projects yet."
            description="Start a blank project, or import a React repository from GitHub, a .zip, or a folder on this machine."
            action={
              <span className={styles.emptyActions}>
                {newProjectButton}
                {importProjectButton}
              </span>
            }
          />
        )
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

      <NewProjectDialog
        open={createOpen}
        busy={busy}
        onClose={() => setCreateOpen(false)}
        onCreate={(options) => void handleCreate(options)}
      />

      {/* The dialog has already pointed Studio at the imported directory and
          requested a reload by the time `onImported` fires — all that's left
          from the launcher is to go there. */}
      <LazyImportProjectDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => navigate('/admin/site')}
      />
    </AdminPageLayout>
  )
}
