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
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { setStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import type { ProjectPlatform } from '@core/studio-board'
import {
  createStudioProject,
  deleteStudioProject,
  useStudioProjects,
  type StudioProject,
} from './hooks/useStudioProjects'
import { NewProjectDialog } from './NewProjectDialog'
import { DeleteProjectDialog } from './DeleteProjectDialog'
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
  const [createOpen, setCreateOpen] = useState(false)
  // Projects created this session, layered over the fetched list so a new
  // project shows up immediately without waiting for a refetch.
  const [created, setCreated] = useState<StudioProject[]>([])
  // Deleted this session, subtracted from the fetched list for the same reason
  // `created` is added to it: `useStudioProjects` has no refetch handle, so the
  // launcher reconciles its own optimistic edits against a list it only reads.
  const [removed, setRemoved] = useState<string[]>([])
  // The project awaiting confirmation. `null` closes `DeleteProjectDialog`.
  const [pendingDelete, setPendingDelete] = useState<StudioProject | null>(null)

  const isLoading = projects === null
  // Merge fetched + session-created, de-duped by dir (a refetch may already
  // include a just-created one).
  const merged = Array.from(
    new Map([...(projects ?? []), ...created].map((p) => [p.dir, p])).values(),
  ).filter((p) => !removed.includes(p.dir))
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

  async function handleDelete(project: StudioProject) {
    if (busy) return
    setBusy(true)
    try {
      await deleteStudioProject(project.dir)
      setRemoved((prev) => [...prev, project.dir])
      // A project created this session and then deleted has to leave `created`
      // too, or it would be re-added by the merge on the next render.
      setCreated((prev) => prev.filter((p) => p.dir !== project.dir))
      setPendingDelete(null)
      pushToast({
        kind: 'success',
        title: `Moved “${project.name}” to the trash`,
        body: 'The folder is in studio-workspace/.trash/ — move it back to restore it.',
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
        <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={busy}>
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
            <li key={project.dir} className={styles.cell}>
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
              {/*
                A SIBLING of the card, never a child: the card is itself a
                <button> (§8.11 of the button-primitive allowlist), and a
                button nested in a button is invalid HTML that browsers
                silently un-nest — the delete control would stop being
                clickable in its own right.
              */}
              <Button
                variant="ghost"
                className={styles.cardDelete}
                aria-label={`Delete ${project.name}`}
                disabled={busy}
                onClick={() => setPendingDelete(project)}
              >
                <TrashSolidIcon size={12} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

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
    </AdminPageLayout>
  )
}
