/**
 * VariableRow - one design token: its name, its value under each mode, how
 * many places read it, and the actions that rewrite it (CT-3).
 *
 * Every write here is one request to the token write planner, so a refusal
 * (`in-use`, `already-declared`, `read-only-source`...) arrives as the
 * server's own sentence and is shown next to the row it came from - never a
 * toast, never a silent no-op. Rename and remove are offered only for a token
 * whose every declaration is a project file; for the others the row says why
 * instead of offering a control that cannot write.
 */
import { useState } from 'react'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { themeApplyClasses, type TokenEdit } from '@core/studio-tokens'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { ApplyClassStrip } from './ApplyClassStrip'
import { ValueCell } from './ValueCell'
import type { VariableCell, VariableRow as VariableRowModel } from './variablesModel'
import styles from './VariableRow.module.css'

const TOKEN_NAME_RE = /^--[A-Za-z0-9_-]+$/

export interface VariableRowWrite {
  edits: TokenEdit[]
  /** The undo entry's label. */
  undoLabel: string
  /** The sentence shown once it lands. */
  summary: (result: { renamed: number; moved: number }) => string
}

interface VariableRowProps {
  row: VariableRowModel
  /** Same-family tokens a removed token's readers can move to. */
  replacements: readonly string[]
  busy: boolean
  /** Runs a write; rejects with the server's refusal. */
  onWrite: (write: VariableRowWrite) => Promise<void>
  /** Why no class can be applied to the selection right now, or `null`. */
  applyBlockedReason: string | null
  /** Adds a utility class to the selection (a Tailwind theme variable is also a class vocabulary). */
  onApplyClass: (className: string) => Promise<void>
}

function valueEdit(row: VariableRowModel, cell: VariableCell, value: string): TokenEdit {
  const target = cell.column.gate
  return cell.decl
    ? { op: 'set', name: row.token.name, value, target }
    : { op: 'insert', name: row.token.name, value, target }
}

function useRowRunner(onWrite: VariableRowProps['onWrite']) {
  const [error, setError] = useState<string | null>(null)
  async function run(write: VariableRowWrite): Promise<boolean> {
    setError(null)
    try {
      await onWrite(write)
      return true
    } catch (err) {
      setError(getErrorMessage(err, 'The variable could not be changed.'))
      return false
    }
  }
  return { error, run, clearError: () => setError(null) }
}

export function VariableRow({ row, replacements, busy, onWrite, applyBlockedReason, onApplyClass }: VariableRowProps) {
  const { token } = row
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view')
  const [showApply, setShowApply] = useState(false)
  const [nameDraft, setNameDraft] = useState(token.name)
  const [replacement, setReplacement] = useState('')
  const { error, run, clearError } = useRowRunner(onWrite)
  const uses = row.usage?.count ?? null
  const isColor = token.family === 'color'
  const nameValid = TOKEN_NAME_RE.test(nameDraft)
  // A Tailwind v4 `@theme` variable is also the classes that read it (`--color-brand` is `bg-brand`).
  const classes = token.decls.some((decl) => decl.inTheme) ? themeApplyClasses(token.name) : []

  function close() {
    setMode('view')
    setNameDraft(token.name)
    setReplacement('')
    clearError()
  }

  async function rename() {
    if (!nameValid || nameDraft === token.name) {
      close()
      return
    }
    const ok = await run({
      edits: [{ op: 'rename', name: token.name, to: nameDraft }],
      undoLabel: `Rename ${token.name}`,
      summary: ({ renamed }) => `Renamed ${token.name} to ${nameDraft} - ${renamed} place${renamed === 1 ? '' : 's'} updated.`,
    })
    if (ok) close()
  }

  async function remove() {
    const ok = await run({
      edits: [{ op: 'remove', name: token.name, ...(replacement ? { replaceWith: replacement } : {}) }],
      undoLabel: `Remove ${token.name}`,
      summary: ({ moved }) => (moved > 0 ? `Removed ${token.name} - ${moved} use${moved === 1 ? '' : 's'} moved to ${replacement}.` : `Removed ${token.name}.`),
    })
    if (ok) close()
  }

  const readOnlyReason = row.editable ? null : `Declared outside the project (${token.decls.find((decl) => decl.origin !== 'project')?.file ?? 'a package'}), so Studio does not edit it in place.`

  return (
    <li className={styles.row} data-testid={`variable-row-${token.name}`}>
      <div className={styles.nameCell}>
        {mode === 'rename' ? (
          <Input
            fieldSize="xs"
            monospace
            autoFocus
            aria-label={`New name for ${token.name}`}
            invalid={!nameValid}
            value={nameDraft}
            disabled={busy}
            onChange={(event) => setNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
              else if (event.key === 'Escape') close()
            }}
          />
        ) : (
          <span className={styles.name} title={readOnlyReason ?? token.name}>
            {token.name}
          </span>
        )}
        <span className={styles.uses} title={row.usage ? row.usage.sites.map((site) => `${site.file}:${site.line}`).join('\n') : undefined}>
          {uses === null ? '' : uses === 0 ? 'unused' : `${uses} use${uses === 1 ? '' : 's'}`}
        </span>
      </div>

      {row.cells.map((cell) => (
        <div key={cell.column.id} className={styles.valueCell}>
          <ValueCell
            name={token.name}
            cell={cell}
            isColor={isColor}
            editable={row.editable}
            busy={busy}
            onCommit={async (value) => {
              await run({
                edits: [valueEdit(row, cell, value)],
                undoLabel: `Edit ${token.name}`,
                summary: () => `${token.name} (${cell.column.label}) is now ${value}.`,
              })
            }}
          />
        </div>
      ))}

      <div className={styles.actions}>
        {mode === 'rename' ? (
          <>
            <Button variant="primary" size="xs" disabled={busy || !nameValid} onClick={() => void rename()}>
              Rename
            </Button>
            <Button variant="ghost" size="xs" onClick={close}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {classes.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label={`Apply ${token.name} as a class`}
                tooltip="Apply as a class"
                pressed={showApply}
                onClick={() => setShowApply(!showApply)}
              >
                <CodeIcon size={11} aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={`Rename ${token.name}`}
              tooltip={readOnlyReason ?? 'Rename (updates every use)'}
              disabled={busy || !row.editable}
              onClick={() => setMode('rename')}
            >
              <EditSolidIcon size={11} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              dangerHover
              aria-label={`Remove ${token.name}`}
              tooltip={readOnlyReason ?? 'Remove'}
              disabled={busy || !row.editable || uses === null}
              pressed={mode === 'remove'}
              onClick={() => setMode(mode === 'remove' ? 'view' : 'remove')}
            >
              <TrashSolidIcon size={11} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>

      {row.otherDeclarations > 0 ? (
        <p className={styles.note}>
          Also declared under {row.otherDeclarations} other condition{row.otherDeclarations === 1 ? '' : 's'} (a width breakpoint or component scope).
        </p>
      ) : null}
      {readOnlyReason ? <p className={styles.note}>{readOnlyReason}</p> : null}

      {showApply && classes.length > 0 ? (
        <ApplyClassStrip subject={token.name} classes={classes} blockedReason={applyBlockedReason} busy={busy} onApply={onApplyClass} />
      ) : null}

      {mode === 'remove' ? (
        <div className={styles.confirm} role="group" aria-label={`Remove ${token.name}`}>
          {uses === 0 ? (
            <p className={styles.confirmText}>Nothing reads {token.name}. Removing it deletes its value in every mode.</p>
          ) : replacements.length === 0 ? (
            <p className={styles.confirmText}>
              {token.name} is used {uses} times and no other {token.family} variable exists to move those to.
            </p>
          ) : (
            <>
              <p className={styles.confirmText}>
                {token.name} is used {uses} time{uses === 1 ? '' : 's'}. Replace those uses with:
              </p>
              <Select
                fieldSize="xs"
                aria-label={`Replace ${token.name} with`}
                value={replacement}
                placeholder="Choose a variable"
                options={replacements.map((name) => ({ value: name, label: name }))}
                onChange={(event) => setReplacement(event.target.value)}
              />
            </>
          )}
          <div className={styles.confirmActions}>
            <Button
              variant="destructive"
              size="xs"
              disabled={busy || (uses !== 0 && replacement === '')}
              onClick={() => void remove()}
            >
              {uses === 0 ? 'Remove' : 'Replace and remove'}
            </Button>
            <Button variant="ghost" size="xs" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  )
}
