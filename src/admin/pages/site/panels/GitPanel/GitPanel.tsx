/**
 * GitPanel — version control as Studio's publish verb.
 *
 * Studio's document IS the user's repository, so "publish" here is not an
 * export step: it is a commit, a branch, and a push against the real files on
 * disk. Before this panel every canvas edit was an unattributed working-tree
 * mutation, and a designer had no way to ship one without leaving the tool.
 *
 * The panel reads top to bottom the way the work does:
 *
 *   branch → what changed → what it changed → say what you did → send it →
 *   see it live
 *
 * The last step is `DeploySection` (W5-4): a preview deploy through the
 * provider CLI the user already has. It sits here rather than on its own rail
 * entry because it is the end of this sentence, and because the branch and
 * dirty state it reports are the ones this panel already has on screen.
 *
 * ## The decisions worth knowing
 *
 * - **Nothing is selected for you.** The commit acts on the files the user
 *   ticked, and the server stages exactly those. There is no "commit all"
 *   button, because in a tool where an AI agent also writes files, "all" is not
 *   a set the user has reviewed. Select-all exists as a row action — an
 *   explicit click, not a default.
 * - **Branch is a dropdown of the branches that exist**, not a free-text field
 *   — `BranchSection` owns it, along with "New branch from current" and the
 *   commit-and-switch dialog a dirty tree needs. The panel never stashes; see
 *   that module's doc for the three decisions behind it.
 * - **Switching branches reloads the board.** The `.tsx` files under the canvas
 *   are about to be different files; leaving the board showing a parse of the
 *   old ones would be the "shows something the files do not say" failure this
 *   codebase has been bitten by before.
 * - **Fetch, pull, push, conflicts and "Open PR" live in `SyncSection`**, which
 *   shows git's own output — an auth failure's real message is the only useful
 *   thing to show. Authentication is the GitHub account signed in at the top of
 *   this panel (`RepositorySection`, G2) — resolved server-side from the
 *   session, never sent on this wire — or, failing that, the host's own
 *   credential helper.
 */
import { useRef, useState } from 'react'
import { Panel, useAutoFocusPanel } from '@admin/shared/Panel'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Textarea } from '@ui/components/Input'
import { EmptyState } from '@ui/components/EmptyState'
import { Section } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { getStudioWorkspaceDir } from '@site/studio/studioWorkspaceDir'
import {
  commitGitFiles,
  getGitFileDiff,
  initGitRepository,
  isGitStateRefusal,
  type GitFileDiff,
  type GitStatusEntry,
} from '@site/studio/gitRequests'
import { BranchSection } from './BranchSection'
import { DeploySection } from './DeploySection'
import { GitDiffView } from './GitDiffView'
import { GitHistorySection } from './GitHistorySection'
import { RepositorySection } from './RepositorySection'
import { SyncSection } from './SyncSection'
import { useGitStatus } from './useGitStatus'
import styles from './GitPanel.module.css'

interface GitPanelProps {
  variant?: 'docked'
}

export function GitPanel({ variant = 'docked' }: GitPanelProps) {
  const isOpen = useEditorStore((s) => s.gitPanelOpen)
  const setGitPanelOpen = useEditorStore((s) => s.setGitPanelOpen)
  const panelRef = useRef<HTMLElement>(null)
  useAutoFocusPanel(panelRef, isOpen)

  const dir = getStudioWorkspaceDir()
  const { loading, error, isRepo, status, refresh } = useGitStatus(dir, isOpen)

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [historyNonce, setHistoryNonce] = useState(0)
  // Bumped by anything that changes the ref list, so the branch dropdown
  // re-reads without this panel knowing which action did it.
  const [refsNonce, setRefsNonce] = useState(0)

  if (!isOpen || variant !== 'docked') return null

  const entries = status?.entries ?? []
  const branch = status?.branch

  function toggleFile(path: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function openDiff(path: string) {
    if (openFile === path) {
      setOpenFile(null)
      setDiff(null)
      return
    }
    setOpenFile(path)
    setDiff(null)
    try {
      setDiff(await getGitFileDiff(dir, path))
    } catch (err) {
      if (isAbortError(err)) return
      console.error('[GitPanel] failed to read a file diff:', err)
      pushToast({ kind: 'error', title: 'Could not read the diff', body: getErrorMessage(err, 'Unknown git error') })
    }
  }

  /** One wrapper for every mutating action: busy flag, toast on failure, refresh on success. */
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label)
    try {
      await action()
    } catch (err) {
      console.error(`[GitPanel] ${label} failed:`, err)
      pushToast({
        // A 409 is the repository's state answering, not a fault — it reads as
        // a warning, and its message is already written for a human.
        kind: isGitStateRefusal(err) ? 'warning' : 'error',
        title: `${label} failed`,
        body: getErrorMessage(err, 'Unknown git error'),
      })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const commit = () =>
    run('Commit', async () => {
      const files = [...selected]
      const result = await commitGitFiles(dir, message, files)
      pushToast({
        kind: 'success',
        title: `Committed ${result.files.length} file${result.files.length === 1 ? '' : 's'}`,
        body: `${result.shortSha} · ${message.trim()}`,
      })
      setMessage('')
      setSelected(new Set())
      setOpenFile(null)
      setDiff(null)
      setHistoryNonce((n) => n + 1)
    })

  const init = () =>
    run('Initialise repository', async () => {
      const result = await initGitRepository(dir)
      pushToast({
        kind: 'success',
        title: 'Repository created',
        body: `${result.filesCommitted} files committed on ${result.branch}.`,
      })
      setHistoryNonce((n) => n + 1)
    })

  return (
    <Panel
      ref={panelRef}
      panelId="git"
      title="Version control"
      testId="git-panel"
      onClose={() => setGitPanelOpen(false)}
    >
      {/* -----------------------------------------------------------------
          Repository — who you are on GitHub, and where this project pushes.
          Above everything, and deliberately OUTSIDE the `isRepo` branch:
          signing in is worth doing before `git init`, and a project with no
          repository yet is exactly the one about to need a remote.
      ----------------------------------------------------------------- */}
      <RepositorySection active={isOpen} dir={dir} isRepo={isRepo} onRemoteChanged={refresh} />

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {!isRepo && !loading && !error ? (
        <EmptyState
          title="This project is not under version control."
          description="Create a repository and commit the project as it stands. Studio writes a .gitignore for node_modules and its own .studio/ folder if you don't already have one."
          action={
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={init}>
              {busy === 'Initialise repository' ? 'Creating…' : 'Create a repository'}
            </Button>
          }
        />
      ) : null}

      {isRepo && status ? (
        <>
          {/* ---------------------------------------------------------------
              Branch — which one you are on, and how you get to another.
              Owns the dropdown, "New branch from current", and the
              commit-and-switch dialog a dirty tree needs. See BranchSection.
          --------------------------------------------------------------- */}
          <BranchSection
            dir={dir}
            branch={branch}
            entries={entries}
            selectedFiles={[...selected]}
            active={isOpen}
            refsNonce={refsNonce}
            onRefsChanged={() => setRefsNonce((n) => n + 1)}
            onSwitched={() => {
              // The files under every frame are different files now.
              setSelected(new Set())
              setOpenFile(null)
              setDiff(null)
              requestCmsSiteReload()
            }}
            busy={busy}
            run={run}
          />

          {/* ---------------------------------------------------------------
              Sync — fetch, pull, push, and the conflict a pull can leave.
              Owns the rebase-or-merge choice and the per-file resolution.
              See SyncSection.
          --------------------------------------------------------------- */}
          <SyncSection
            dir={dir}
            branch={branch}
            hasOrigin={status.hasOrigin}
            active={isOpen}
            refsNonce={refsNonce}
            onRefsChanged={() => setRefsNonce((n) => n + 1)}
            onWorkingTreeChanged={() => {
              setSelected(new Set())
              setOpenFile(null)
              setDiff(null)
              setHistoryNonce((n) => n + 1)
              requestCmsSiteReload()
            }}
            busy={busy}
            run={run}
          />

          {/* ---------------------------------------------------------------
              Changes
          --------------------------------------------------------------- */}
          <Section
            title="Changes"
            defaultOpen
            meta={entries.length > 0 ? `${entries.length}` : undefined}
            actions={
              entries.length > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    setSelected((current) =>
                      current.size === entries.length ? new Set() : new Set(entries.map((e) => e.path)),
                    )
                  }
                >
                  {selected.size === entries.length ? 'None' : 'All'}
                </Button>
              ) : null
            }
          >
            {entries.length === 0 ? (
              <EmptyState compact plain title="Nothing has changed." description="Every file matches the last commit." />
            ) : (
              <ul className={styles.changes}>
                {entries.map((entry) => (
                  <li key={entry.path} className={styles.changeRow}>
                    <Checkbox
                      boxSize="sm"
                      checked={selected.has(entry.path)}
                      aria-label={`Include ${entry.path} in the commit`}
                      disabled={entry.unmerged}
                      onCheckedChange={() => toggleFile(entry.path)}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(styles.changeButton, openFile === entry.path && styles.changeButtonOpen)}
                      onClick={() => void openDiff(entry.path)}
                    >
                      <span className={cn(styles.statusMark, statusClass(entry))}>{statusMark(entry)}</span>
                      <span className={styles.changePath}>{entry.path}</span>
                      {entry.agentAuthored ? <span className={styles.agentTag}>AI</span> : null}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {status.excludedCount > 0 ? (
              <p className={styles.hint}>
                {status.excludedCount} more path{status.excludedCount === 1 ? '' : 's'} changed inside node_modules,
                build output, or Studio&rsquo;s own .studio/ folder. Studio never commits those.
              </p>
            ) : null}

            {openFile && diff ? (
              <div className={styles.diffWrap}>
                <GitDiffView diff={diff.staged} label="Staged" />
                <GitDiffView diff={diff.unstaged} label={diff.untracked ? 'New file' : 'Not staged'} />
                {diff.truncated ? <p className={styles.hint}>This diff is too large to show in full.</p> : null}
              </div>
            ) : null}
          </Section>

          {/* ---------------------------------------------------------------
              Commit
          --------------------------------------------------------------- */}
          <div className={styles.commitBox}>
            <Textarea
              fieldSize="sm"
              rows={3}
              value={message}
              placeholder="What did you change?"
              aria-label="Commit message"
              onChange={(e) => setMessage(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null || selected.size === 0 || message.trim().length === 0}
              onClick={commit}
            >
              {busy === 'Commit'
                ? 'Committing…'
                : `Commit ${selected.size} file${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>

          {/* ---------------------------------------------------------------
              History
          --------------------------------------------------------------- */}
          <Section title="History">
            <GitHistorySection dir={dir} reloadNonce={historyNonce} selectedFile={openFile} />
          </Section>
        </>
      ) : null}

      {/* -----------------------------------------------------------------
          Deploy — the last step of the same sentence: see it live.

          Deliberately OUTSIDE the `isRepo` branch: a project nobody has put
          under version control can still be deployed, and refusing to show
          the section there would be a gate the server does not have.
      ----------------------------------------------------------------- */}
      <DeploySection dir={dir} branch={branch?.branch ?? null} dirtyCount={entries.length} active={isOpen} />
    </Panel>
  )
}

/** The single letter git itself uses, chosen from whichever half of the entry is set. */
function statusMark(entry: GitStatusEntry): string {
  if (entry.unmerged) return '!'
  if (entry.untracked) return 'U'
  const kind = entry.unstaged ?? entry.staged
  switch (kind) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'type-changed':
      return 'T'
    default:
      return 'M'
  }
}

function statusClass(entry: GitStatusEntry): string {
  if (entry.unmerged) return styles.markConflict
  if (entry.untracked || entry.staged === 'added' || entry.unstaged === 'added') return styles.markAdded
  if (entry.staged === 'deleted' || entry.unstaged === 'deleted') return styles.markRemoved
  return styles.markModified
}
