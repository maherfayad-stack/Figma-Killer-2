/**
 * TurnChangesCard — "Changed N files" under an assistant turn, with the
 * per-file diff, "Revert turn" and a per-file revert (AI-7).
 *
 * The list is the server's checkpoint of the turn (`agentTurnChanges`): what
 * each file held before the agent touched it and what the agent left. A revert
 * is compare-and-swap on the server — a file changed after the agent wrote it
 * (by the user on the canvas, in an editor, or by a later turn) is refused by
 * name and left alone. That refusal is an honest answer, so it is shown here,
 * where the button was, as a quiet note — never as a red toast. "Revert turn"
 * is all-or-nothing; when it cannot run, the files that still can are
 * reverted one by one from their own rows.
 *
 * The diff reuses the git panel's unified-diff view (`GitDiffView`): the
 * server writes the checkpoint's diff in git's format for exactly that reason.
 */
import { useState } from 'react'
import { fetchAgentTurnFileDiff, type AgentTurnChanges, type AgentTurnFileChange, type AgentTurnFileDiff } from '@site/agent'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { GitDiffView } from '../GitPanel/GitDiffView'
import styles from './AgentPanel.module.css'

export function TurnChangesCard({ changes, disabled }: { changes: AgentTurnChanges; disabled: boolean }) {
  const revertAgentTurn = useAgentStore((s) => s.revertAgentTurn)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const files = changes.files
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  const revertable = files.filter((file) => file.revertable)
  const allReverted = files.every((file) => file.state === 'reverted')

  async function revert(paths?: readonly string[]): Promise<void> {
    setBusy(true)
    setNotice(null)
    const result = await revertAgentTurn(changes.turnId, paths)
    setBusy(false)
    setNotice(result.ok
      ? `Reverted ${result.reverted.length === 1 ? result.reverted[0] : `${result.reverted.length} files`}.`
      : result.message)
  }

  return (
    <section className={styles.turnChanges} aria-label="Files this turn changed" data-testid="agent-turn-changes">
      <div className={styles.turnChangesHeader}>
        <span className={styles.turnChangesSummary}>
          {allReverted ? 'Reverted' : 'Changed'} {files.length} file{files.length === 1 ? '' : 's'}
          <span className={styles.turnChangesCounts} aria-label={`${added} lines added, ${removed} removed`}>
            <span className={styles.turnAdded}>+{added}</span>
            <span className={styles.turnRemoved}>−{removed}</span>
          </span>
        </span>
        {!allReverted && (
          <Button
            variant="secondary"
            size="xs"
            disabled={disabled || busy || revertable.length === 0}
            tooltip={revertable.length === 0 ? 'Nothing here can be reverted any more' : 'Put every file back the way it was before this turn'}
            onClick={() => void revert()}
          >
            Revert turn
          </Button>
        )}
      </div>
      <ul className={styles.turnFiles}>
        {files.map((file) => (
          <TurnFileRow key={file.path} turnId={changes.turnId} file={file} disabled={disabled || busy} onRevert={() => void revert([file.path])} />
        ))}
      </ul>
      {notice && (
        <p className={styles.turnNotice} role="status">
          {notice}
        </p>
      )}
    </section>
  )
}

function stateLabel(file: AgentTurnFileChange): string {
  if (file.state === 'reverted') return 'Reverted'
  if (file.state === 'changed-since') return 'Changed since'
  return file.change === 'created' ? 'New' : 'Edited'
}

function TurnFileRow({
  turnId,
  file,
  disabled,
  onRevert,
}: {
  turnId: string
  file: AgentTurnFileChange
  disabled: boolean
  onRevert(): void
}) {
  const conversationId = useAgentStore((s) => s.agentConversationId)
  const [diff, setDiff] = useState<AgentTurnFileDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const slash = file.path.lastIndexOf('/')
  const folder = slash >= 0 ? file.path.slice(0, slash + 1) : ''
  const name = file.path.slice(slash + 1)

  async function toggleDiff(): Promise<void> {
    const next = !open
    setOpen(next)
    if (!next || diff) return
    try {
      if (!conversationId) throw new Error('This conversation is not saved yet.')
      setDiff(await fetchAgentTurnFileDiff(conversationId, turnId, file.path))
      setDiffError(null)
    } catch (err) {
      // Shown where the diff would have been (a read nobody else needs to hear about).
      setDiffError(getErrorMessage(err, 'The diff could not be loaded.'))
    }
  }

  return (
    <li className={styles.turnFile}>
      <div className={styles.turnFileRow}>
        <span className={styles.turnFilePath} title={file.reason ?? file.path}>
          {folder}
          <span className={styles.turnFileName}>{name}</span>
        </span>
        <span className={styles.turnFileState}>{stateLabel(file)}</span>
        <span className={styles.turnFileActions}>
          <Button variant="ghost" size="micro" aria-expanded={open} onClick={() => void toggleDiff()}>
            Diff
          </Button>
          {file.state !== 'reverted' && (
            <Button
              variant="ghost"
              size="micro"
              disabled={disabled || !file.revertable}
              tooltip={file.revertable ? `Put ${name} back the way it was before this turn` : file.reason ?? undefined}
              aria-label={`Revert ${file.path}`}
              onClick={onRevert}
            >
              Revert
            </Button>
          )}
        </span>
      </div>
      {open && (
        <div className={styles.turnDiff}>
          {diffError ? (
            <p className={styles.turnNotice}>{diffError}</p>
          ) : diff ? (
            <GitDiffView diff={diff.diff} label={file.change === 'created' ? 'New file' : 'This turn'} />
          ) : (
            <p className={styles.turnNotice}>Loading…</p>
          )}
        </div>
      )}
    </li>
  )
}
