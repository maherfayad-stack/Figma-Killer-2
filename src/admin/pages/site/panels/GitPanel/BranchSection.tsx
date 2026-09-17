/**
 * BranchSection — which branch you are on, and how you get to another one.
 *
 * Replaces the v1 free-text branch field, which asked the user to type a name
 * they had no way to look up and then guess whether "Create" or "Switch" was
 * the right button. A designer knows *which branch*, not *how git spells it*,
 * so the control is a list of the branches that exist.
 *
 * ## The three decisions
 *
 * - **Remote-tracking refs are offered by their LOCAL name.** `origin/feature`
 *   appears as `feature (from origin)` and switches with `git switch feature`,
 *   which git resolves to "create a local branch tracking origin/feature".
 *   Offering `origin/feature` literally would detach HEAD — a state this panel
 *   exists to keep people out of.
 * - **Creating a branch is not gated on a clean tree**, because `git switch -c`
 *   at HEAD moves a pointer and cannot lose a byte. That asymmetry is what
 *   makes the intended flow work: edit on the canvas, *then* branch, then
 *   commit.
 * - **Switching with uncommitted work opens a dialog with exactly two ways
 *   out: Commit and switch, or Cancel.** Studio never stashes — a stash is an
 *   invisible place a designer's screen went. "Commit and switch" is one
 *   server action (`commit-and-switch`), so a save landing between the two
 *   halves cannot turn it into a refusal the user did nothing to cause.
 *
 * Switching reloads the board, because the `.tsx` files under every frame are
 * about to be different files.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import type { GitBranchStatus, GitStatusEntry } from '@site/studio/gitRequests'
import { createGitBranch, switchGitBranch } from '@site/studio/gitRequests'
import { commitAndSwitchGitBranch, type GitBranchList } from '@site/studio/gitSyncRequests'
import { useGitBranches } from './useGitBranches'
import styles from './BranchSection.module.css'

interface BranchSectionProps {
  dir: string | undefined
  /** From the panel's git status — the authority on what HEAD is doing right now. */
  branch: GitBranchStatus | undefined
  /** Every changed path the panel is showing. Non-empty means a switch needs the dialog. */
  entries: GitStatusEntry[]
  /** The files ticked in Changes — exactly what "Commit and switch" will commit. */
  selectedFiles: readonly string[]
  /** The panel is open. Nothing is fetched while it is not. */
  active: boolean
  /** Bumped by anything that can change the ref list — a create or switch here, a fetch or pull in the sync section. */
  refsNonce: number
  /** Announces that this section changed the ref list, so the panel can bump `refsNonce` for everyone reading it. */
  onRefsChanged: () => void
  /** A different commit is checked out — the board must re-read the files under every frame. */
  onSwitched: () => void
  /** The panel's shared "an action is running" flag, so two mutations can never overlap in the UI. */
  busy: string | null
  /** Runs an action with the panel's busy flag, toast-on-failure, and refresh. */
  run: (label: string, action: () => Promise<void>) => Promise<void>
}

/** A branch already checked out locally takes precedence over the remote-tracking ref of the same name. */
function switchOptions(list: GitBranchList | null): { value: string; label: string }[] {
  if (!list) return []
  const locals = list.branches.filter((b) => !b.remote)
  const localNames = new Set(locals.map((b) => b.name))
  const options = locals.map((b) => ({ value: b.name, label: b.name }))

  for (const remote of list.branches.filter((b) => b.remote)) {
    // `origin/feature` → `feature`. A remote name always has exactly one
    // leading remote segment in `refname:short` form.
    const localName = remote.name.slice(remote.name.indexOf('/') + 1)
    if (!localName || localNames.has(localName)) continue
    localNames.add(localName)
    options.push({ value: localName, label: `${localName} (from ${remote.name.slice(0, remote.name.indexOf('/'))})` })
  }
  return options
}

export function BranchSection({
  dir,
  branch,
  entries,
  selectedFiles,
  active,
  refsNonce,
  onRefsChanged,
  onSwitched,
  busy,
  run,
}: BranchSectionProps) {
  const { list, error } = useGitBranches(dir, active, refsNonce)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [switchMessage, setSwitchMessage] = useState('')

  const current = branch?.branch ?? null
  const options = switchOptions(list)
  const dirty = entries.length > 0

  function onPick(name: string) {
    if (!name || name === current) return
    // Uncommitted work is the ONLY reason a switch needs a conversation. The
    // server would refuse it anyway — asking first is what turns that refusal
    // into a choice.
    if (dirty) {
      setSwitchMessage('')
      setPendingSwitch(name)
      return
    }
    void run('Switch branch', async () => {
      const result = await switchGitBranch(dir, name)
      onRefsChanged()
      onSwitched()
      pushSwitched(result.branch)
    })
  }

  const commitAndSwitch = () => {
    const target = pendingSwitch
    if (!target) return
    void run('Commit and switch', async () => {
      const result = await commitAndSwitchGitBranch(dir, switchMessage, selectedFiles, target)
      setPendingSwitch(null)
      setSwitchMessage('')
      onRefsChanged()
      onSwitched()
      pushSwitched(result.branch)
    })
  }

  const createBranch = () =>
    run('Create branch', async () => {
      const result = await createGitBranch(dir, newName.trim())
      setNewName('')
      setCreating(false)
      onRefsChanged()
      pushToast({
        kind: 'success',
        title: `On branch ${result.branch}`,
        body: 'Your uncommitted work came with you.',
      })
    })

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <span className={styles.label}>Branch</span>
        {branch?.detached ? (
          <strong className={styles.detached}>detached HEAD</strong>
        ) : (
          <Select
            fieldSize="sm"
            className={styles.select}
            aria-label="Branch"
            value={current ?? ''}
            disabled={busy !== null || options.length === 0}
            options={options}
            placeholder={current ?? 'No branches yet'}
            onChange={(e) => onPick(e.target.value)}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null || branch?.detached}
          tooltip="Create a branch at the current commit and switch to it"
          onClick={() => setCreating((open) => !open)}
        >
          New
        </Button>
      </div>

      {branch?.upstream ? (
        <p className={styles.divergence}>
          {branch.ahead ? `${branch.ahead} ahead` : null}
          {branch.ahead && branch.behind ? ' · ' : null}
          {branch.behind ? `${branch.behind} behind` : null}
          {!branch.ahead && !branch.behind ? 'Up to date with ' : ''}
          {!branch.ahead && !branch.behind ? branch.upstream : ` ${branch.upstream}`}
        </p>
      ) : (
        <p className={styles.divergence}>No upstream — a push will set one.</p>
      )}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {creating ? (
        <div className={styles.createRow}>
          <Input
            fieldSize="sm"
            autoFocus
            value={newName}
            placeholder="new-branch-name"
            aria-label="New branch name"
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button variant="secondary" size="sm" disabled={busy !== null || !newName.trim()} onClick={createBranch}>
            {busy === 'Create branch' ? 'Creating…' : 'Create'}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </div>
      ) : null}

      <Dialog
        open={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        title="Commit before switching?"
        eyebrow="Uncommitted changes"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingSwitch(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy !== null || selectedFiles.length === 0 || switchMessage.trim().length === 0}
              onClick={commitAndSwitch}
            >
              {busy === 'Commit and switch'
                ? 'Committing…'
                : `Commit ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} and switch`}
            </Button>
          </>
        }
      >
        <p className={styles.dialogBody}>
          Switching to <strong>{pendingSwitch}</strong> would check out different files under every frame, and there
          {entries.length === 1 ? ' is 1 change' : ` are ${entries.length} changes`} that are not committed yet. Studio
          never stashes your work, so it can commit it first — or do nothing.
        </p>
        {selectedFiles.length === 0 ? (
          <p className={styles.dialogHint} role="status">
            Tick the files to commit in <strong>Changes</strong> first. Nothing is selected for you.
          </p>
        ) : null}
        <Textarea
          fieldSize="sm"
          rows={2}
          value={switchMessage}
          placeholder="What did you change?"
          aria-label="Commit message"
          onChange={(e) => setSwitchMessage(e.target.value)}
        />
      </Dialog>
    </div>
  )
}

function pushSwitched(name: string) {
  pushToast({ kind: 'success', title: `Switched to ${name}`, body: 'Reloading the board from disk.' })
}
