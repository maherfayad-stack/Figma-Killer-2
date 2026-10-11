/**
 * StructuredValueControl - the editable face of a list or object prop whose
 * value is written inline in the user's JSX:
 * `<Navbar segmentedControl={{ items: ['Flights', 'Stays'], value: 0 }} />`,
 * `<Navbar chips={[{ label: 'Dates', selected: false }]} />`.
 *
 * `CodeValueControl` is the read-only answer for a value a field cannot hold;
 * this is the answer for the literals INSIDE one. Every scalar leaf is its own
 * row with the control its type calls for (a boolean a switch, a number next to
 * its list a select of that list's entries, a string a text field), and a write
 * names the leaf by its path (`['segmentedControl', 'value']`) - one literal in
 * the user's source changes, nothing around it.
 *
 * What it does NOT do: add, remove or reorder entries (that is editing the list,
 * not a value in it), and it never draws a field for a leaf that is code - the
 * caller only mounts it when the prop is writable (`explainPropConstraint`
 * said nothing), and the server refuses a path that crosses an expression.
 *
 * A key the component documents but the call site does not write yet
 * (`example`) is offered as an unset row; changing it appends the key.
 *
 * ## The row shows the write, not the click
 *
 * A write lands in the file and the board re-reads it, so the value a row holds
 * moves a beat after the click. The row keeps what the user chose until the
 * value it was drawn from changes (or a few seconds pass), so a switch does not
 * snap back and forth.
 */
import { useEffect, useState } from 'react'
import { INDEX_PROP_NAME_RE, pickIndexedCollection } from '@core/utils/collectionIndexNames'
import { Button } from '@ui/components/Button'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { cn } from '@ui/cn'
import type { ControlProps } from './shared'
import { collectionEntryLabel, collectionIndexOptions } from './collectionIndexOptions'
import { SelectControl } from './SelectControl'
import { TextControl } from './TextControl'
import { ToggleControl } from './ToggleControl'
import styles from './StructuredValueControl.module.css'

export type PropPath = readonly (string | number)[]
export type PropScalar = string | number | boolean

/** One leaf write: where in the prop's value, what to, and what it was (for the undo label and the unchanged check). */
export interface PropPathWrite {
  path: PropPath
  value: PropScalar
  previous: PropScalar | undefined
}

/** A group opens by itself when everything under it fits in a screenful of rows. */
const OPEN_BY_DEFAULT_LEAVES = 8
/** Nested lists inside lists stop being a panel and start being a document. */
const MAX_DEPTH = 5

function isScalar(value: unknown): value is PropScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countLeaves(value: unknown, depth: number): number {
  if (isScalar(value)) return 1
  if (depth >= MAX_DEPTH) return 0
  if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + countLeaves(entry, depth + 1), 0)
  if (isRecord(value)) return Object.values(value).reduce<number>((sum, entry) => sum + countLeaves(entry, depth + 1), 0)
  return 0
}

/** The entries to draw under a group: what the value holds, then what the example documents and the value lacks. */
function entriesOf(value: unknown, example: unknown): { key: string | number; child: unknown; childExample: unknown }[] {
  if (Array.isArray(value)) {
    const shape = Array.isArray(example) ? example[0] : undefined
    return value.map((child, index) => ({ key: index, child, childExample: shape }))
  }
  const held = isRecord(value) ? value : {}
  const documented = isRecord(example) ? example : {}
  const keys = [...Object.keys(held), ...Object.keys(documented).filter((key) => !(key in held))]
  return keys.map((key) => ({ key, child: held[key], childExample: documented[key] }))
}

/** What a group header says about its size. */
function summarise(value: unknown): string {
  if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`
  return ''
}

/** A key names an object entry; an array entry is named by its position and what it calls itself. */
function labelOf(key: string | number, child: unknown): string {
  if (typeof key === 'string') return key
  if (isScalar(child)) return `Item ${key + 1}`
  const name = collectionEntryLabel(child, key)
  return name === `Item ${key + 1}` ? name : `${key + 1} · ${name}`
}

/** Keeps what the user just chose until the value it was drawn from changes. */
function usePending<T>(value: T): [T, (next: T) => void] {
  const [pending, setPending] = useState<{ base: T; next: T } | null>(null)
  useEffect(() => {
    if (pending === null) return
    const timer = setTimeout(() => setPending(null), 4000)
    return () => clearTimeout(timer)
  }, [pending])
  const shown = pending !== null && Object.is(pending.base, value) ? pending.next : value
  return [shown, (next) => setPending({ base: value, next })]
}

interface LeafProps {
  rowKey: string
  label: string
  value: PropScalar | undefined
  /** The documented example's value, when the call site does not write this key. */
  exampleValue: unknown
  /** Choices for a number that names one entry of a list. */
  options: { label: string; value: string }[] | null
  disabled?: boolean
  layout: ControlProps['layout']
  onCommit: (next: PropScalar) => void
}

function Leaf(props: LeafProps) {
  return <div data-testid={`property-control-${props.rowKey}`}><LeafControl {...props} /></div>
}

function LeafControl({ rowKey, label, value, exampleValue, options, disabled, layout, onCommit }: LeafProps) {
  const [shown, choose] = usePending(value)
  const type = typeof (value ?? exampleValue)
  const commit = (next: PropScalar) => {
    if (Object.is(next, value)) return
    choose(next)
    onCommit(next)
  }

  if (type === 'boolean') {
    return (
      <ToggleControl
        propKey={rowKey}
        label={label}
        disabled={disabled}
        layout={layout}
        value={Boolean(shown)}
        onChange={(_key, next) => commit(next)}
      />
    )
  }
  if (type === 'number' && options !== null && options.length > 0) {
    return (
      <SelectControl
        propKey={rowKey}
        label={label}
        disabled={disabled}
        layout={layout}
        value={String(Number(shown ?? 0))}
        options={options}
        onChange={(_key, next) => commit(Number(next))}
      />
    )
  }
  if (type === 'number') {
    return (
      <TextControl
        propKey={rowKey}
        label={label}
        disabled={disabled}
        layout={layout}
        value={shown === undefined ? '' : String(shown)}
        numericUnit=""
        onChange={(_key, next) => {
          const parsed = Number(next)
          if (next.trim() !== '' && Number.isFinite(parsed)) commit(parsed)
        }}
      />
    )
  }
  return (
    <TextControl
      propKey={rowKey}
      label={label}
      disabled={disabled}
      layout={layout}
      value={shown === undefined ? '' : String(shown)}
      onChange={(_key, next) => commit(next)}
    />
  )
}

interface GroupProps {
  rowKey: string
  label: string
  value: unknown
  example: unknown
  path: PropPath
  depth: number
  disabled?: boolean
  layout: ControlProps['layout']
  onWrite: (write: PropPathWrite) => void
}

function Group({ rowKey, label, value, example, path, depth, disabled, layout, onWrite }: GroupProps) {
  const leaves = countLeaves(value, depth)
  const [open, setOpen] = useState(depth === 0 || leaves <= OPEN_BY_DEFAULT_LEAVES)
  const entries = depth >= MAX_DEPTH ? [] : entriesOf(value, example)
  // "Which entry is current": a number key next to the list it indexes, inside the same object.
  const siblingLists = isRecord(value) ? Object.entries(value).filter(([, entry]) => Array.isArray(entry)).map(([key]) => key) : []
  const indexed = pickIndexedCollection(siblingLists)

  return (
    <div className={styles.group} data-testid={`property-group-${rowKey}`}>
      <Button
        variant="ghost"
        size="xs"
        className={styles.header}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={cn(styles.chevron, open && styles.chevronOpen)}>
          <ChevronRightIcon size={10} />
        </span>
        <span className={styles.title}>{label}</span>
        <span className={styles.summary}>{summarise(value)}</span>
      </Button>
      {open && (
        <div className={styles.children}>
          {entries.map(({ key, child, childExample }) => {
            const childPath = [...path, key]
            const childKey = `${rowKey}.${key}`
            const shape = child ?? childExample
            if (isScalar(shape)) {
              const options =
                typeof key === 'string' && indexed !== undefined && INDEX_PROP_NAME_RE.test(key) && typeof shape === 'number' && isRecord(value)
                  ? collectionIndexOptions(value[indexed])
                  : null
              return (
                <Leaf
                  key={childKey}
                  rowKey={childKey}
                  label={labelOf(key, child)}
                  value={isScalar(child) ? child : undefined}
                  exampleValue={childExample}
                  options={options}
                  disabled={disabled}
                  layout={layout}
                  onCommit={(next) => onWrite({ path: childPath, value: next, previous: isScalar(child) ? child : undefined })}
                />
              )
            }
            if (Array.isArray(shape) || isRecord(shape)) {
              return (
                <Group
                  key={childKey}
                  rowKey={childKey}
                  label={labelOf(key, child)}
                  value={child ?? (Array.isArray(shape) ? [] : {})}
                  example={childExample}
                  path={childPath}
                  depth={depth + 1}
                  disabled={disabled}
                  layout={layout}
                  onWrite={onWrite}
                />
              )
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}

interface StructuredValueControlProps extends ControlProps<unknown> {
  /** The component's documented example value for this prop - keys it shows that the call site lacks are offered unset. */
  example?: unknown
  onChangePath: (propKey: string, write: PropPathWrite) => void
}

export function StructuredValueControl({ propKey, value, label, layout, disabled, example, onChangePath }: StructuredValueControlProps) {
  return (
    <Group
      rowKey={propKey}
      label={label ?? propKey}
      value={value}
      example={example}
      path={[]}
      depth={0}
      disabled={disabled}
      layout={layout}
      onWrite={(write) => onChangePath(propKey, write)}
    />
  )
}
