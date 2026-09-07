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
 * A third way to start sits in the empty state: "Start with the sample
 * project" copies `examples/studio-sample-project/` — three real pages of
 * plain React — into the workspace. It is never created for the user; the
 * button is the only thing that makes one.
 *
 * Above all of it, until it is dismissed or finished, is the onboarding
 * checklist (`OnboardingPanel`). Its five steps derive from live server facts
 * and each of its buttons performs the real action, which is why this page —
 * the one place that already owns "open a project", "create a project" and the
 * admin UI store — is where those actions are wired.
 *
 * This replaced the old CMS widget-grid dashboard: the app now presents as a
 * studio-first project launcher, reached from the toolbar brand (the logo).
 */
import { useState } from 'react'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useAdminUi } from '@admin/state/adminUi'
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
  createSampleStudioProject,
  createStudioProject,
  deleteStudioProject,
  duplicateStudioProject,
  renameStudioProject,
  useStudioProjects,
  type StudioProject,
} from './hooks/useStudioProjects'
import { useOnboardingFacts } from './hooks/useOnboardingFacts'
import { OnboardingPanel, type OnboardingAction } from './OnboardingPanel'
import { dismissOnboarding, isOnboardingDismissed } from './onboardingDismissal'
import { isOnboardingComplete } from './onboardingSteps'
import { NewProjectDialog } from './NewProjectDialog'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { ProjectCard } from './ProjectCard'
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
  // W7-5's onboarding checklist. Read here with the page's other resources;
  // everything derived from it is in the one block further down.
  const { facts: onboardingFacts } = useOnboardingFacts()

  const [query, setQuery] = useState('')
  const [onboardingDismissed, setOnboardingDismissed] = useState(() =>
    isOnboardingDismissed(currentUser.id),
  )
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // The project awaiting confirmation. `null` closes `DeleteProjectDialog`.
  const [pendingDelete, setPendingDelete] = useState<StudioProject | null>(null)

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

  function openProject(project: StudioProject, options: { prototype?: boolean } = {}) {
    // Force the next Site-editor mount to reload from disk instead of
    // short-circuiting on a previous project's still-mounted `existingSite`.
    requestCmsSiteReload()
    setStudioWorkspaceDir(project.dir)
    // `?mode=prototype` is consumed once and stripped by `useSiteEditorUrlSync`
    // — an instruction to arrive in prototype mode, which is what the
    // checklist's "Try prototype mode" step has to actually do.
    navigate(options.prototype ? '/admin/site?mode=prototype' : '/admin/site')
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

  async function handleSample() {
    if (busy) return
    setBusy(true)
    try {
      const project = await createSampleStudioProject()
      openProject(project)
    } catch (err) {
      console.error('[DashboardPage] sample project failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not copy the sample project',
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
  const sampleProjectButton = (
    <Button variant="ghost" onClick={() => void handleSample()} disabled={busy}>
      <SparklesSolidIcon size={12} aria-hidden="true" /> Start with the sample project
    </Button>
  )

  // ── Onboarding checklist (W7-5) ────────────────────────────────────────────
  // Deliberately one contained block: everything the checklist needs is
  // computed here and consumed by the single `<OnboardingPanel>` above the
  // toolbar, so the rest of this page is unchanged by its presence.
  //
  // Shown only when every one of these holds — a checklist that appears for a
  // user who has finished, or that a user has already sent away, is noise on
  // the surface they came to for their projects:
  //   - the facts loaded (a failed read renders nothing rather than claiming
  //     nothing is done — see `useOnboardingFacts`);
  //   - this user has not dismissed it in this browser;
  //   - at least one of the five steps is still open.
  const showOnboarding =
    onboardingFacts !== null && !onboardingDismissed && !isOnboardingComplete(onboardingFacts)

  // The project the "open it" steps act on: the one edited most recently, which
  // is the one the user was last working in. `editedAt` rather than the
  // launcher's display-name sort — "a project" in those steps means "the one
  // you would have opened anyway".
  const mostRecentProject = listed.reduce<StudioProject | null>(
    (newest, project) => (newest === null || project.editedAt > newest.editedAt ? project : newest),
    null,
  )

  function runOnboardingAction(action: OnboardingAction) {
    if (action === 'create-project') {
      setCreateOpen(true)
      return
    }
    if (action === 'open-ai-settings') {
      // The same Settings section the agent panel's own "no credential" state
      // opens, so there is one place AI setup happens.
      useAdminUi.getState().openSettings('ai')
      return
    }
    // Both remaining actions open a project; only the mode differs. The
    // buttons are disabled without one, so this is defensive rather than a
    // silent no-op path a user can reach.
    if (!mostRecentProject) return
    openProject(mostRecentProject, { prototype: action === 'open-prototype-mode' })
  }

  function handleDismissOnboarding() {
    dismissOnboarding(currentUser.id)
    setOnboardingDismissed(true)
  }

  return (
    <AdminPageLayout
      workspace="dashboard"
      title={greetingFor(currentUser.displayName)}
      description="Your studio projects — open one to keep editing, start a new one, or import an existing React repository."
    >
      {/* W7-5 — the onboarding checklist, above the launcher's own toolbar and
          grid. See the block that computes `showOnboarding` for the three
          conditions that have to hold for it to be here at all. */}
      {showOnboarding && onboardingFacts !== null && (
        <OnboardingPanel
          facts={onboardingFacts}
          hasProject={mostRecentProject !== null}
          onRunAction={runOnboardingAction}
          onDismiss={handleDismissOnboarding}
        />
      )}

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
            description="Start a blank project, import a React repository from GitHub, a .zip, or a folder on this machine, or copy in the three-page sample to have something to open."
            action={
              <span className={styles.emptyActions}>
                {newProjectButton}
                {importProjectButton}
                {/* The third path, and the only one that needs nothing from
                    the user: `examples/studio-sample-project/` is copied into
                    the workspace on click. Never on load — see
                    `server/handlers/studio/sampleProject.ts`. */}
                {sampleProjectButton}
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
