/**
 * SyncSection — everything between this project and its remote: fetch, pull,
 * push, and the conflict a pull can leave behind.
 *
 * ## What this surface refuses to hide
 *
 * - **Push is disabled while the branch is behind**, with "Pull first" on the
 *   tooltip. The push would be rejected by the remote anyway; saying so before
 *   the click is the difference between a tool and a terminal.
 * - **A pull is `--ff-only` unless the user picks otherwise.** When both sides
 *   have commits, this section does not choose: it says so and offers *Rebase
 *   onto origin* and *Merge* as two explicit buttons. Rebase and merge write
 *   different history, and which one a team wants is not a design tool's call.
 * - **A conflict is a list you can act on**, not a message telling you to open
 *   a terminal. Each unmerged file gets *Keep mine* / *Keep theirs* / *Open in
 *   code*, then one *Continue*. The `mine`/`theirs` wording is the user's;
 *   git's `--ours`/`--theirs` (which invert during a rebase) never reach this
 *   file.
 * - **The conflict state survives a reload.** It is read from the repository,
 *   not remembered from the pull that caused it, so closing the tab mid-
 *   conflict does not hide it.
 * - **Abort is the one destructive verb here**, so it sits behind the same
 *   two-step danger confirmation `restore` uses. It is narrower than it looks:
 *   a pull refuses to start over a dirty tree, so abort has no uncommitted
 *   work to discard.
 *
 * Studio holds no git credentials of its own beyond a GitHub token the user
 * deliberately connected; a push or fetch that needs a password fails fast
 * with git's real message rather than blocking on a prompt nobody will answer.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import { jumpToSource } from '@site/panels/PropertiesPanel/jumpToSource'
import type { GitBranchStatus, GitConflictSide } from '@site/studio/gitRequests'
import {
  abortGitConflict,
  continueGitConflict,
  fetchGitRemote,
  pullGitRemote,
  pushGitBranch,
  resolveGitConflict,
} from '@site/studio/gitRequests'
import { useGitConflicts } from './useGitConflicts'
import styles from './SyncSection.module.css'

interface SyncSectionProps {
  dir: string | undefined
  branch: GitBranchStatus | undefined
  /** Whether an `origin` remote exists at all. Without one there is nothing to sync with. */
  hasOrigin: boolean
  /** The panel is open. Nothing is fetched while it is not. */
  active: boolean
  /** Bumped by anything that can change the ref list; also bumped by this section after a fetch or pull. */
  refsNonce: number
  onRefsChanged: () => void
  /** A pull moved the working tree — the board must re-read the files under every frame. */
  onWorkingTreeChanged: () => void
  busy: string | null
  run: (label: string, action: () => Promise<void>) => Promise<void>
}

export function SyncSection({
  dir,
  branch,
  hasOrigin,
  active,
  refsNonce,
  onRefsChanged,
  onWorkingTreeChanged,
  busy,
  run,
}: SyncSectionProps) {
  const conflicts = useGitConflicts(dir, active, refsNonce)
  const [output, setOutput] = useState<string | null>(null)
  const [confirmAbort, setConfirmAbort] = useState(false)

  const ahead = branch?.ahead ?? 0
  const behind = branch?.behind ?? 0
  const diverged = ahead > 0 && behind > 0
  const conflict = conflicts.state?.kind ? conflicts.state : null
  const detached = branch?.detached === true

  const fetchRemote = () =>
    run('Fetch', async () => {
      const result = await fetchGitRemote(dir)
      setOutput(result.output || 'origin had nothing new.')
      onRefsChanged()
    })

  const pull = (strategy: 'ff-only' | 'rebase' | 'merge') =>
    run(strategy === 'ff-only' ? 'Pull' : strategy === 'rebase' ? 'Rebase' : 'Merge', async () => {
      const result = await pullGitRemote(dir, strategy)
      setOutput(result.output || 'Already up to date.')
      onRefsChanged()
      // A pull that moved HEAD changed the .tsx files under every frame.
      onWorkingTreeChanged()
    })

  const push = () =>
    run('Push', async () => {
      const result = await pushGitBranch(dir)
      setOutput(result.output || `origin is up to date with ${result.branch}.`)
      onRefsChanged()
      pushToast({ kind: 'success', title: `Pushed ${result.branch}`, body: 'origin is up to date with this branch.' })
    })

  const keep = (file: string, side: GitConflictSide) =>
    run(side === 'mine' ? 'Keep mine' : 'Keep theirs', async () => {
      await resolveGitConflict(dir, file, side)
      conflicts.refresh()
      onWorkingTreeChanged()
    })

  const finish = () =>
    run('Continue', async () => {
      const result = await continueGitConflict(dir)
      conflicts.refresh()
      onRefsChanged()
      onWorkingTreeChanged()
      pushToast({
        kind: 'success',
        title: result.kind === 'rebase' ? 'Rebase finished' : 'Merge finished',
        body: 'The board is reloading from disk.',
      })
    })

  const abort = () =>
    run('Abort', async () => {
      const result = await abortGitConflict(dir)
      setConfirmAbort(false)
      conflicts.refresh()
      onRefsChanged()
      onWorkingTreeChanged()
      pushToast({
        kind: 'success',
        title: result.kind === 'rebase' ? 'Rebase aborted' : 'Merge aborted',
        body: 'The branch is back where it was before the pull.',
      })
    })

  return (
    <Section title="Sync" defaultOpen meta={conflict ? 'Conflict' : divergenceMeta(ahead, behind)}>
      {!hasOrigin ? (
        <p className={styles.hint}>
          This project has no <code>origin</code> remote, so there is nothing to fetch, pull, or push to yet.
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" disabled={busy !== null || !hasOrigin} onClick={fetchRemote}>
          {busy === 'Fetch' ? 'Fetching…' : 'Fetch'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null || !hasOrigin || detached || conflict !== null || diverged}
          tooltip={
            diverged
              ? 'Both sides have new commits — choose rebase or merge below.'
              : 'git pull --ff-only, which never rewrites anything'
          }
          onClick={() => pull('ff-only')}
        >
          {busy === 'Pull' ? 'Pulling…' : 'Pull'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy !== null || !hasOrigin || detached || behind > 0 || conflict !== null}
          tooltip={behind > 0 ? 'Pull first — origin has commits this branch does not.' : 'git push --set-upstream origin'}
          onClick={push}
        >
          {busy === 'Push' ? 'Pushing…' : 'Push'}
        </Button>
      </div>

      {diverged && !conflict ? (
        <div className={styles.choice} role="group" aria-label="Reconcile with origin">
          <p className={styles.choiceBody}>
            This branch has {ahead} commit{ahead === 1 ? '' : 's'} origin does not, and origin has {behind} this branch
            does not. A fast-forward is not possible, and Studio will not choose for you — these write different
            history.
          </p>
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => pull('rebase')}>
              {busy === 'Rebase' ? 'Rebasing…' : 'Rebase onto origin'}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => pull('merge')}>
              {busy === 'Merge' ? 'Merging…' : 'Merge'}
            </Button>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <div className={styles.conflict}>
          <p className={styles.conflictHead}>
            {conflict.kind === 'rebase' ? 'Rebase' : 'Merge'} stopped on {conflict.files.length} conflicted file
            {conflict.files.length === 1 ? '' : 's'}. Choose a version for each one, then continue.
          </p>
          <ul className={styles.conflictList}>
            {conflict.files.map((file) => (
              <li key={file} className={styles.conflictRow}>
                <span className={styles.conflictPath}>{file}</span>
                <span className={styles.conflictActions}>
                  <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => keep(file, 'mine')}>
                    Keep mine
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy !== null} onClick={() => keep(file, 'theirs')}>
                    Keep theirs
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    tooltip="Open this file in the code panel, conflict markers and all"
                    onClick={() => jumpToSource({ rel: file, line: 1, col: 1 })}
                  >
                    Open in code
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null || conflict.files.length > 0}
              tooltip={conflict.files.length > 0 ? 'Some files are still unmerged.' : undefined}
              onClick={finish}
            >
              {busy === 'Continue' ? 'Continuing…' : 'Continue'}
            </Button>
            <Button
              variant={confirmAbort ? 'destructive' : 'ghost'}
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                if (confirmAbort) void abort()
                else setConfirmAbort(true)
              }}
            >
              {busy === 'Abort'
                ? 'Aborting…'
                : confirmAbort
                  ? `Really abort the ${conflict.kind}?`
                  : `Abort the ${conflict.kind}`}
            </Button>
          </div>
          {confirmAbort ? (
            <p className={styles.danger} role="alert">
              Aborting throws away the {conflict.kind} and puts this branch back where it was before the pull. Nothing
              uncommitted is at risk — the pull refused to start over a dirty tree.
            </p>
          ) : null}
        </div>
      ) : null}

      {conflicts.error ? (
        <p className={styles.danger} role="alert">
          {conflicts.error}
        </p>
      ) : null}

      {output ? <pre className={styles.output}>{output}</pre> : null}
    </Section>
  )
}

/** The one-line summary the section header carries, so divergence is visible without opening anything. */
function divergenceMeta(ahead: number, behind: number): string | undefined {
  if (ahead === 0 && behind === 0) return undefined
  if (ahead > 0 && behind > 0) return `${ahead}↑ ${behind}↓`
  return ahead > 0 ? `${ahead}↑` : `${behind}↓`
}
