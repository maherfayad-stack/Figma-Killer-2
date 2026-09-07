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
 * The server's listing is the only listing. `useStudioProjects` hands back a
 * `refresh()`, so every mutation — delete, rename, duplicate — redraws by
 * refetching; the page keeps no optimistic created/removed shadow copy to
 * reconcile against a list it can only read. A failed load is a state of its
 * own — a retry, not an eternal skeleton.
 *
 * The per-project verbs and everything a card renders live in `ProjectCard`
 * (Open / Rename / Duplicate / Delete, off one `ContextMenu`); this page owns
 * only the server calls behind them, so all four share one `busy` latch and
 * one refetch.
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
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
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
import type { ImportSummary } from '@site/studio/importSummary'
import { LazyImportSummaryDialog } from '@admin/shared/dialogs/ImportProjectDialog'
import type { ProjectPlatform } from '@core/studio-board'
import {
  createStudioProject,
  deleteStudioProject,
  duplicateStudioProject,
  renameStudioProject,
  useStudioProjects,
  type StudioProject,
} from './hooks/useStudioProjects'
import {
  purgeTrashedProject,
  restoreTrashedProject,
  useProjectTrash,
  type TrashedProject,
} from './hooks/useProjectTrash'
import { NewProjectDialog } from './NewProjectDialog'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { LauncherDropZone } from './LauncherDropZone'
import { ProjectCard } from './ProjectCard'
import { TrashDialog } from './TrashDialog'
import styles from './DashboardPage.module.css'

// Placeholder tiles shown while the project list is in flight — enough to
// read as "a grid of project cards is about to appear", not so many that the
// page reflows dramatically once the real (usually shorter) list lands. Three
// is the honest number: most installs have a handful of projects, and six
// placeholders that collapse to two is a bigger lie than a short row.
const SKELETON_TILE_KEYS = ['a', 'b', 'c'] as const

function greetingFor(displayName: string | null | undefined): string {
  const hour = new Date().getHours()
  const time = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = displayName?.split(' ')[0] ?? 'there'
  return `Good ${time}, ${name}.`
}

export function DashboardPage() {
  const currentUser = useAuthenticatedAdminUser()
  const navigate = useAdminNavigate()
  const { projects, error, refresh } = useStudioProjects()
  const { trashed, error: trashError, refresh: refreshTrash } = useProjectTrash()

  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // The project awaiting confirmation. `null` closes `DeleteProjectDialog`.
  const [pendingDelete, setPendingDelete] = useState<StudioProject | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  // The finished import awaiting its summary step. Set by the drop zone; the
  // Import dialog runs its own copy of this step internally.
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)

  // Before the first successful load there is nothing to draw: either the
  // request is still out (skeletons) or it failed (the retry state below).
  // After it, the server's list is the only list — every mutation redraws by
  // refetching rather than by splicing a local copy.
  const isLoading = projects === null && error === null
  const isFailed = projects === null && error !== null
  const listed = projects ?? []
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? listed.filter((p) => p.name.toLowerCase().includes(needle))
    : listed

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

  async function handleDelete(project: StudioProject) {
    if (busy) return
    setBusy(true)
    try {
      await deleteStudioProject(project.dir)
      refresh()
      refreshTrash()
      setPendingDelete(null)
      pushToast({
        kind: 'success',
        title: `Moved “${project.name}” to the trash`,
        body: 'Nothing was erased — restore it from Trash whenever you like.',
      })
    } catch (err) {
      console.error('[DashboardPage] delete project failed:', err)
      // The dialog stays open on failure so the user can see which project the
      // message is about, and retry without hunting for the tile again.
      pushToast({
        kind: 'error',
        title: 'Could not delete project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleRename(project: StudioProject, name: string) {
    try {
      await renameStudioProject(project.dir, name)
      refresh()
    } catch (err) {
      console.error('[DashboardPage] rename project failed:', err)
      // No optimistic name to roll back — the card is rendered from the
      // server's list, so a failed rename simply leaves the old name on
      // screen, which is the truth.
      pushToast({
        kind: 'error',
        title: 'Could not rename project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    }
  }

  async function handleDuplicate(project: StudioProject) {
    if (busy) return
    setBusy(true)
    try {
      const copy = await duplicateStudioProject(project.dir)
      refresh()
      pushToast({
        kind: 'success',
        title: `Duplicated as “${copy.name}”`,
        // Naming what was left out is the honest version: the copy will not
        // build until its dependencies are installed, and nobody should have
        // to discover that by opening it.
        body: 'Everything except node_modules, build output and .git was copied.',
      })
    } catch (err) {
      console.error('[DashboardPage] duplicate project failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not duplicate project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setBusy(false)
    }
  }

  // Deleting a project MOVES it into the trash, so the count beside the Trash
  // button has to change in the same beat as the grid.
  async function handleRestore(project: TrashedProject) {
    if (busy) return
    setBusy(true)
    try {
      const restored = await restoreTrashedProject(project.entry)
      refresh()
      refreshTrash()
      pushToast({ kind: 'success', title: `Restored “${restored.name}”` })
    } catch (err) {
      console.error('[DashboardPage] restore project failed:', err)
      // A 409's message names the live project standing in the way, which is
      // the one thing the user needs in order to fix it.
      pushToast({
        kind: 'error',
        title: 'Could not restore project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setBusy(false)
    }
  }

  async function handlePurge(project: TrashedProject) {
    if (busy) return
    setBusy(true)
    try {
      await purgeTrashedProject(project.entry)
      refreshTrash()
      pushToast({ kind: 'success', title: `Deleted “${project.name}” forever` })
    } catch (err) {
      console.error('[DashboardPage] purge project failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not delete project',
        body: getErrorMessage(err, 'Unknown project error'),
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * A dropped import lands in the launcher immediately, and the summary step
   * decides whether the board opens. The grid refreshes either way — the
   * project exists on disk from the moment the upload returned, and a user who
   * dismisses the summary should still see it.
   */
  function handleDropImported(summary: ImportSummary) {
    refresh()
    setImportSummary(summary)
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
        {trashed !== null && trashed.length > 0 && (
          <Button variant="secondary" onClick={() => setTrashOpen(true)} disabled={busy}>
            <TrashSolidIcon size={12} aria-hidden="true" /> Trash ({trashed.length})
          </Button>
        )}
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
      ) : isFailed ? (
        // A failed listing used to leave the skeletons shimmering forever,
        // which reads as "nearly there" rather than "this went wrong". Say
        // what happened and put the retry where the projects would be.
        <EmptyState
          variant="centered"
          size="large"
          role="alert"
          icon={<CircleAlertSolidIcon size={22} aria-hidden="true" />}
          title="Could not load your projects."
          description={error ?? undefined}
          action={
            <Button variant="secondary" onClick={refresh}>
              <ReloadIcon size={12} aria-hidden="true" /> Try again
            </Button>
          }
        />
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
        // `aria-live` so creating, importing or deleting a project — all of
        // which redraw this list rather than navigating — is announced instead
        // of changing silently under a screen reader.
        <ul className={styles.grid} aria-live="polite" aria-label="Projects">
          {filtered.map((project) => (
            <ProjectCard
              key={project.dir}
              project={project}
              busy={busy}
              onOpen={openProject}
              onRename={handleRename}
              onDuplicate={(target) => void handleDuplicate(target)}
              onDelete={setPendingDelete}
            />
          ))}
        </ul>
      )}

      {/* Drop a folder or .zip anywhere on the launcher. Renders nothing until
          a drag carrying files enters the window. */}
      <LauncherDropZone onImported={handleDropImported} disabled={busy} />

      <TrashDialog
        open={trashOpen}
        trashed={trashed}
        error={trashError}
        busy={busy}
        onClose={() => setTrashOpen(false)}
        onRestore={(project) => void handleRestore(project)}
        onPurge={(project) => void handlePurge(project)}
      />

      {/* The drop path's post-import step. The Import dialog shows its own,
          because it owns the form the summary replaces. */}
      <LazyImportSummaryDialog
        summary={importSummary}
        onClose={() => setImportSummary(null)}
        onOpen={(summary) => {
          setImportSummary(null)
          requestCmsSiteReload()
          setStudioWorkspaceDir(summary.dir)
          navigate('/admin/site')
        }}
      />

      <DeleteProjectDialog
        project={pendingDelete}
        busy={busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete)
        }}
      />

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
