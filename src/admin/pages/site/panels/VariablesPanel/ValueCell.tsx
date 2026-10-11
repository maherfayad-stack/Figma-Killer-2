/**
 * ValueCell - one token's value under one mode, editable in place (CT-3).
 *
 * The edit contract the panel promises:
 *   - typing previews the value on every board frame (`studioTokenPreview`),
 *     writing nothing;
 *   - Enter or leaving the field COMMITS - one write, one undo entry;
 *   - Escape cancels and the canvas shows what is on disk again.
 *
 * A mode the token has no value for yet shows an empty field; typing a value
 * and committing declares it under that mode (an `insert` edit). A cell whose
 * declaration is not a project file renders as plain text - a control that
 * cannot write must not look like one that can.
 */
import { useState, type CSSProperties } from 'react'
import { gateSelector } from '@core/studio-tokens'
import { Input } from '@ui/components/Input'
import { setStudioTokenPreview } from '@site/studio/studioTokenPreview'
import type { VariableCell } from './variablesModel'
import styles from './ValueCell.module.css'

interface ValueCellProps {
  name: string
  cell: VariableCell
  isColor: boolean
  /** False when the token's declarations are not all project files. */
  editable: boolean
  /** True while a write is in flight. */
  busy: boolean
  /** Commits `value`; rejects with the server's refusal. The cell clears its preview either way. */
  onCommit: (value: string) => Promise<void>
}

function previewTarget(cell: VariableCell): { selector: string | null; atRules: readonly string[] } {
  if (cell.decl) return { selector: cell.decl.selector, atRules: cell.decl.atRules }
  const gate = cell.column.gate
  if (gate.kind === 'base') return { selector: ':root', atRules: [] }
  if (gate.kind === 'media') return { selector: ':root', atRules: [`@media ${gate.query}`] }
  return { selector: gateSelector(gate), atRules: [] }
}

function Swatch({ color }: { color: string }) {
  return <span className={styles.swatch} style={{ '--swatch': color } as CSSProperties} />
}

export function ValueCell({ name, cell, isColor, editable, busy, onCommit }: ValueCellProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const current = cell.decl?.value ?? ''
  const label = `${name} ${cell.column.label}`

  if (!editable || (cell.decl && cell.decl.origin !== 'project')) {
    return (
      <span className={styles.readOnly} title={cell.decl ? `${cell.decl.file} - not a project file Studio edits in place` : undefined}>
        {isColor && cell.decl ? <Swatch color={cell.decl.resolvedValue} /> : null}
        <span className={styles.readOnlyText}>{current}</span>
      </span>
    )
  }

  function change(value: string) {
    setDraft(value)
    setStudioTokenPreview({ name, value, ...previewTarget(cell) })
  }

  function cancel() {
    setDraft(null)
    setStudioTokenPreview(null)
  }

  async function commit() {
    const value = draft?.trim()
    // Nothing typed, nothing changed, or cleared: there is nothing to write.
    // (Emptying a field does not remove the value - Remove on the row does.)
    if (value === undefined || value === '' || value === current) {
      cancel()
      return
    }
    try {
      await onCommit(value)
    } finally {
      cancel()
    }
  }

  const shown = draft ?? current
  return (
    <Input
      className={styles.cell}
      fieldSize="xs"
      monospace
      aria-label={label}
      placeholder={cell.decl ? undefined : 'Inherits default'}
      value={shown}
      disabled={busy}
      prefix={isColor ? <Swatch color={cell.decl ? cell.decl.resolvedValue : shown} /> : undefined}
      onChange={(event) => change(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void commit()
        else if (event.key === 'Escape') cancel()
      }}
    />
  )
}
