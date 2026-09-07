/**
 * VariablePickerPopover — the searchable list of project variables a field
 * can be bound to, anchored to that field's "Apply variable" button.
 *
 * Built on `InspectorPopover` rather than `ContextMenu` for two reasons the
 * spec forces: the surface holds a `SearchBar` the user types into (a menu
 * closes on the first gesture), and `InspectorPopover` already clamps itself
 * to the viewport through `fitFloatingToViewport` — a variable list opened
 * from the last row of a tall panel must not run off the bottom of the
 * screen.
 *
 * Rows are grouped by source (Project / Package / Framework) so a design
 * system's own token is never confused with one Studio generated. Within a
 * group the catalog's own order is preserved — stylesheet order is
 * meaningful (scales are declared small-to-large) and re-sorting
 * alphabetically would put `--space-10` between `--space-1` and `--space-2`.
 */
import { useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { cn } from '@ui/cn'
import {
  VARIABLE_SOURCE_LABEL,
  type VariableOption,
  type VariableSource,
} from './variableKind'
import { variableChipLabel } from './varBinding'
import styles from './VariableField.module.css'

const SOURCE_ORDER: readonly VariableSource[] = ['project', 'vendor', 'framework']

interface VariablePickerPopoverProps {
  anchorRef: RefObject<HTMLElement | null>
  /** Stable identity for sticky popover view state — the field's accessible name. */
  id: string
  options: readonly VariableOption[]
  /** Name (with dashes) of the variable currently bound, if any. */
  boundName: string | undefined
  onPick: (option: VariableOption) => void
  onClose: () => void
}

function matches(option: VariableOption, query: string): boolean {
  if (query.length === 0) return true
  const needle = query.toLowerCase()
  return (
    option.name.toLowerCase().includes(needle) ||
    option.resolvedValue.toLowerCase().includes(needle)
  )
}

export function VariablePickerPopover({
  anchorRef,
  id,
  options,
  boundName,
  onPick,
  onClose,
}: VariablePickerPopoverProps) {
  const [query, setQuery] = useState('')

  const visible = options.filter((option) => matches(option, query))
  const groups = SOURCE_ORDER.map((source) => ({
    source,
    entries: visible.filter((option) => option.source === source),
  })).filter((group) => group.entries.length > 0)

  return (
    <InspectorPopover
      id={`apply-variable-${id}`}
      anchorRef={anchorRef}
      onClose={onClose}
      title="Apply variable"
      width={264}
    >
      <SearchBar
        value={query}
        onValueChange={setQuery}
        placeholder="Search variables"
        aria-label="Search variables"
      />
      {groups.length === 0 ? (
        <p className={styles.pickerEmpty}>
          No matching variable for this property.
        </p>
      ) : (
        <ul className={styles.pickerList}>
          {groups.map((group) => (
            <li key={group.source}>
              <p className={styles.pickerGroupLabel}>{VARIABLE_SOURCE_LABEL[group.source]}</p>
              <ul className={styles.pickerGroup}>
                {group.entries.map((option) => (
                  <li key={`${group.source}:${option.name}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        styles.pickerRow,
                        option.name === boundName && styles.pickerRowActive,
                      )}
                      onClick={() => onPick(option)}
                    >
                      {option.kind === 'color' ? (
                        <span
                          className={styles.pickerSwatch}
                          style={{ '--variable-swatch': option.resolvedValue } as CSSProperties}
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className={styles.pickerName}>{variableChipLabel(option.name)}</span>
                      <span className={styles.pickerValue}>{option.resolvedValue}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </InspectorPopover>
  )
}
