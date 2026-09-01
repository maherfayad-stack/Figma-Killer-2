/**
 * PropertyControlRenderer — dispatches a PropertyControl schema entry to the
 * correct React control component.
 *
 * Adds a structural shell for data-testid/state attributes while the concrete
 * control component owns its own row layout via controls.module.css.
 *
 * Row layout:
 *   - The schema-level `layout` field on a PropertyControl ('inline' | 'stacked')
 *     wins when present.
 *   - Otherwise, the renderer falls back to a sensible per-type default
 *     (`image`, `media`, `textarea`, and `svg` are stacked; everything else
 *     is inline). See `defaultLayoutFor`.
 *   - The resolved layout is forwarded to each concrete control component
 *     so individual controls don't need to repeat the resolution logic.
 */
import { useState } from 'react'
import type {
  PropertyControl,
  PropertyControlLayout,
  PropertySchema,
} from '@core/module-engine'
import { resolvePropertyControlCategory } from '@core/module-engine'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { TextControl } from './TextControl'
import { TextareaControl } from './TextareaControl'
import { NumberControl } from './NumberControl'
import { ColorControl } from './ColorControl'
import { SelectControl } from './SelectControl'
import { ToggleControl } from './ToggleControl'
import { ImageControl } from './ImageControl'
import { MediaLibraryControl } from './MediaLibraryControl'
import { UrlControl } from './UrlControl'
import { SvgControl } from './SvgControl'
import { SlotControl } from './SlotControl'
import { CodeValueControl } from './CodeValueControl'
import { DataTableControl } from './DataTableControl'
import { cn } from '@ui/cn'
import styles from './controls.module.css'

interface RenderControlOptions {
  propKey: string
  control: PropertyControl
  value: unknown
  onChange: (key: string, val: unknown) => void
  isOverride?: boolean
  disabled?: boolean
  /**
   * Set when the selected node is SOURCE-LOCKED — `PageNode.lockReason`. Every
   * prop on such a node is unwritable (`updateNodeProps` returns early, and
   * silently, because agents and plugins call it too), so no control here may
   * present itself as an input. Carries the reason so the row can say it.
   */
  sourceLockReason?: string
  /** E2.5 — forwarded to `SlotControl` only; see `ControlProps.ownerNodeId`. */
  ownerNodeId?: string
  /**
   * The selected node's other resolved props, for a control whose OPTIONS are
   * another prop's value — `collection-index`, where `TabBar.value` names one
   * entry of `items`. Only that control reads it.
   */
  siblingProps?: Record<string, unknown>
}

/**
 * Per-control-type default row layout. A control that is fundamentally
 * unsuited to a 100px label column (media pickers with their own internal
 * layout, multi-line text areas) defaults to `stacked`; everything else
 * defaults to `inline`. The schema-level `layout` field overrides this.
 */
function defaultLayoutFor(controlType: PropertyControl['type']): PropertyControlLayout {
  switch (controlType) {
    case 'image':
    case 'media':
    case 'svg':
    case 'textarea':
      return 'stacked'
    default:
      return 'inline'
  }
}

/** Resolve the effective layout: explicit schema field beats per-type default. */
function resolveControlLayout(control: PropertyControl): PropertyControlLayout {
  return control.layout ?? defaultLayoutFor(control.type)
}

/**
 * An array/object value on a control that edits a scalar. Studio's page parser
 * captures these for design-system components (`actions={[{ label }, …]}`), and
 * every scalar control here coerces with `String(value)` — which would show
 * `[object Object]` and let one keystroke overwrite the whole structure.
 *
 * `group` is excluded because its value is not the edited thing: it holds the
 * child schema's props bag by design.
 */
function isStructuredValue(control: PropertyControl, value: unknown): value is readonly unknown[] | Record<string, unknown> {
  return control.type !== 'group' && typeof value === 'object' && value !== null
}

/**
 * The sibling collection's entries as select options, labelled the way a person
 * would name them.
 *
 * A design system's list entries are objects (`{ icon, label }`) or bare strings
 * (`SegmentedControl`'s `items={['Flights', 'Stays']}`), so both are read. An
 * entry with no readable name still gets a row — dropping it would shift every
 * index after it and silently select the wrong tab.
 */
function collectionIndexOptions(collection: unknown): { label: string; value: string }[] {
  if (!Array.isArray(collection)) return []
  return collection.map((item, index) => ({ label: collectionEntryLabel(item, index), value: String(index) }))
}

/** One entry's display name: its own label/title, the string it is, or its position. */
function collectionEntryLabel(item: unknown, index: number): string {
  if (typeof item === 'string' && item.trim() !== '') return item
  if (typeof item === 'object' && item !== null) {
    for (const key of ['label', 'title', 'name', 'text']) {
      const value = (item as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  }
  return `Item ${index + 1}`
}

/**
 * Render a single property control wrapped in the test/accessibility shell.
 * Returns null for unknown or unimplemented control types.
 */
export function PropertyControlRenderer({
  propKey,
  control,
  value,
  onChange,
  isOverride = false,
  disabled = false,
  sourceLockReason,
  ownerNodeId,
  siblingProps,
}: RenderControlOptions) {
  const layout = resolveControlLayout(control)

  // Caller-permission gate: content props and structural module props are
  // separate edit modes. Holding `site.structure.edit` does not imply copy
  // editing permission.
  const permissions = useEditorPermissions()
  const category = resolvePropertyControlCategory(control)
  const allowedByCategory = category === 'content'
    ? permissions.canEditContent
    : permissions.canEditStructure
  const effectiveDisabled = disabled || !allowedByCategory

  const shared = {
    propKey,
    value,
    onChange,
    label: control.label,
    isOverride,
    disabled: effectiveDisabled,
    layout,
    ownerNodeId,
  }

  // A `slot` is exempt, and this is the one exemption that matters. Both
  // conditions below ask "can a SCALAR write land on this attribute?" — the
  // right question for a text box, and the wrong one for a slot, which never
  // writes the attribute's value at all: "Add" runs the `insert-slot` codemod
  // against the CALL SITE (and does its own `explainStructuralConstraint`
  // check), while "Edit contents" merely selects a node that already exists.
  //
  // Without the exemption a slot became unusable the moment it was FILLED: a
  // JSX-valued prop is code, not a writable literal, so `propLockReason`
  // returned "set in code", and the row swapped itself for a padlocked code
  // value displaying the raw `studio-slot:<nodeId>` sentinel — an internal
  // marker no user should ever see, in place of the affordance for the icon
  // they had just successfully inserted.
  const isSlot = control.type === 'slot'

  // Nothing writable behind this control: either the value has no scalar form,
  // or the node itself refuses writes. Same read-only row for both.
  if (!isSlot && (sourceLockReason !== undefined || isStructuredValue(control, value))) {
    return (
      <div
        data-testid={`property-control-${propKey}`}
        data-disabled="true"
        data-category={category}
        data-layout={layout}
      >
        <CodeValueControl {...shared} value={value} {...(sourceLockReason ? { hint: sourceLockReason } : {})} />
      </div>
    )
  }

  let inner: React.ReactNode

  switch (control.type) {
    case 'text':
      inner = (
        <TextControl
          {...shared}
          value={String(value ?? '')}
          placeholder={control.placeholder}
          normalize={control.normalize}
        />
      )
      break

    case 'textarea':
      inner = (
        <TextareaControl
          {...shared}
          value={String(value ?? '')}
          rows={control.rows}
          placeholder={control.placeholder}
        />
      )
      break

    case 'number':
      inner = (
        <NumberControl
          {...shared}
          value={Number(value ?? 0)}
          min={control.min}
          max={control.max}
          step={control.step}
          unit={control.unit}
        />
      )
      break

    case 'color':
      inner = <ColorControl {...shared} value={String(value ?? '')} format={control.format} />
      break

    case 'select':
      inner = <SelectControl {...shared} options={control.options} />
      break

    case 'collection-index': {
      // Options are the sibling list's OWN entries, read from the node rather
      // than from the schema — five tabs today, three tomorrow. The control
      // shows names and writes back the index the component actually takes.
      const options = collectionIndexOptions(siblingProps?.[control.collection])
      inner =
        options.length === 0 ? (
          // Nothing to choose between yet. A select with no options is a dead
          // control; the number is at least honest about what the prop holds.
          <NumberControl {...shared} value={Number(value ?? 0)} min={0} />
        ) : (
          <SelectControl
            {...shared}
            value={String(Number(value ?? 0))}
            options={options}
            onChange={(key, next) => onChange(key, Number(next))}
          />
        )
      break
    }

    case 'toggle':
      inner = <ToggleControl {...shared} value={Boolean(value)} />
      break

    case 'image':
      inner = <ImageControl {...shared} value={String(value ?? '')} />
      break

    case 'media':
      inner = (
        <MediaLibraryControl
          {...shared}
          value={String(value ?? '')}
          mediaKind={control.mediaKind}
        />
      )
      break

    case 'url':
      inner = <UrlControl {...shared} value={String(value ?? '')} />
      break

    case 'dataTable':
      inner = (
        <DataTableControl
          {...shared}
          value={String(value ?? '')}
          includeSystem={control.includeSystem}
        />
      )
      break

    case 'svg':
      inner = <SvgControl {...shared} value={String(value ?? '')} />
      break

    case 'slot':
      inner = <SlotControl {...shared} value={value} />
      break

    case 'richtext':
      return null

    case 'group':
      inner = (
        <GroupSection
          label={control.label}
          schema={control.children}
          props={{ [propKey]: value } as Record<string, unknown>}
          onChange={onChange}
          isOverride={isOverride}
          disabled={disabled}
          defaultCollapsed={control.collapsed}
        />
      )
      break

    default:
      return null
  }

  if (control.type === 'group') {
    return (
      <div data-testid={`property-control-${propKey}`}>
        {inner}
      </div>
    )
  }

  const isDisabled = effectiveDisabled

  return (
    <div
      data-testid={`property-control-${propKey}`}
      data-disabled={isDisabled ? 'true' : undefined}
      data-category={category}
      data-override={isOverride ? 'true' : undefined}
      data-layout={layout}
    >
      {inner}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GroupSection — visual grouping with collapsible header
// ---------------------------------------------------------------------------

interface GroupSectionProps {
  label: string
  schema: PropertySchema
  props: Record<string, unknown>
  onChange: (key: string, val: unknown) => void
  isOverride?: boolean
  disabled?: boolean
  defaultCollapsed?: boolean
}

function GroupSection({
  label,
  schema,
  props,
  onChange,
  isOverride,
  disabled,
  defaultCollapsed = false,
}: GroupSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div className={styles.groupWrapper}>
      {/* Group header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={styles.groupHeader}
      >
        <span className={cn(styles.groupChevron, !collapsed && styles.groupChevronExpanded)}>
          <ChevronRightIcon size={10} />
        </span>
        {label}
      </button>

      {/* Group children */}
      {!collapsed && (
        <div className={styles.groupChildren}>
          {Object.entries(schema).map(([key, ctrl]) => (
            <PropertyControlRenderer
              key={key}
              propKey={key}
              control={ctrl}
              value={props[key]}
              onChange={onChange}
              isOverride={isOverride}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  )
}
