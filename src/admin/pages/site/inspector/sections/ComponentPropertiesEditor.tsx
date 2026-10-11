/**
 * ComponentPropertiesEditor — the Component section's "Component" mode (CV-3):
 * the component's OWN properties rather than one instance's values.
 *
 * Figma's component-properties panel, over a repository: each enum prop is a
 * variant axis listing its values, with "+" to add one (a copy of the default
 * value's style, written into the component's source) and a remove button per
 * value; a boolean or text prop is listed with its default; "+" on the header
 * adds a property. Every change is written to the component's definition, so
 * it applies to every instance — the section says so — and is one ⌘Z.
 *
 * Read from the catalog (`GET /admin/api/studio/components`), the same read the
 * instance rows use, so the two modes can never disagree about what the
 * component declares. A package or design-system component has no spec here
 * (it is a black box); the mode is simply not offered for it.
 */
import { useRef, useState } from 'react'
import type { LocalComponentSpec, LocalPropSpec } from '@site/property-controls/componentPropKind'
import { commitStudioRemoveVariant } from '@site/studio/studioVariantCommits'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { AddPropertyPopover } from './AddPropertyPopover'
import { AddVariantPopover } from './AddVariantPopover'
import { valuesOf } from './variantAxes'
import styles from './ComponentProperties.module.css'

interface ComponentPropertiesEditorProps {
  spec: LocalComponentSpec
}

/** A prop worth a row: a variant axis, an on/off flag, or a text. Handlers and slots are not properties of the design. */
function isListed(prop: LocalPropSpec): boolean {
  return prop.kind.kind === 'enum' || prop.kind.kind === 'boolean' || prop.kind.kind === 'string'
}

function describeDefault(prop: LocalPropSpec): string {
  if (prop.defaultValue === undefined) return prop.kind.kind === 'boolean' ? 'off' : 'none'
  return typeof prop.defaultValue === 'boolean' ? (prop.defaultValue ? 'on' : 'off') : `“${String(prop.defaultValue)}”`
}

export function ComponentPropertiesEditor({ spec }: ComponentPropertiesEditorProps) {
  const addPropertyRef = useRef<HTMLButtonElement>(null)
  const [addingProperty, setAddingProperty] = useState(false)
  const rows = spec.props.filter(isListed)

  return (
    <div className={styles.editor} data-testid="component-properties-editor">
      <div className={styles.header}>
        <span className={styles.headerLabel}>Component properties</span>
        <Button
          ref={addPropertyRef}
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add property"
          aria-haspopup="dialog"
          aria-expanded={addingProperty}
          tooltip="Add property"
          onClick={() => setAddingProperty((open) => !open)}
          data-testid="add-property-button"
        >
          <PlusIcon size={12} aria-hidden="true" />
        </Button>
      </div>
      <p className={styles.scopeNote}>Edits {spec.name} itself, so every instance changes.</p>
      {rows.length === 0 ? (
        <p className={styles.empty}>No properties yet.</p>
      ) : (
        <ul className={styles.propList} aria-label={`${spec.name} properties`}>
          {rows.map((prop) => (
            <PropertyRow key={prop.name} spec={spec} prop={prop} />
          ))}
        </ul>
      )}
      {addingProperty && (
        <AddPropertyPopover id="add-property" anchorRef={addPropertyRef} spec={spec} onClose={() => setAddingProperty(false)} />
      )}
    </div>
  )
}

function PropertyRow({ spec, prop }: { spec: LocalComponentSpec; prop: LocalPropSpec }) {
  const addRef = useRef<HTMLButtonElement>(null)
  const [adding, setAdding] = useState(false)
  const isAxis = prop.kind.kind === 'enum'
  const values = valuesOf(prop)

  return (
    <li className={styles.propRow} data-testid={`component-property-${prop.name}`}>
      <div className={styles.propHead}>
        <span className={styles.propName}>{prop.name}</span>
        <span className={styles.propMeta}>
          {isAxis ? `${values.length} values` : prop.kind.kind === 'boolean' ? 'on/off' : 'text'} · default {describeDefault(prop)}
        </span>
        {isAxis && (
          <Button
            ref={addRef}
            variant="ghost"
            size="xs"
            iconOnly
            aria-label={`Add ${prop.name} variant`}
            aria-haspopup="dialog"
            aria-expanded={adding}
            tooltip="Add variant"
            onClick={() => setAdding((open) => !open)}
            data-testid={`add-variant-button-${prop.name}`}
          >
            <PlusIcon size={12} aria-hidden="true" />
          </Button>
        )}
      </div>
      {isAxis && (
        <ul className={styles.valueList} aria-label={`${prop.name} values`}>
          {values.map((value) => {
            const isDefault = prop.defaultValue === value
            return (
              <li key={value} className={styles.valueRow} data-testid={`variant-value-${prop.name}-${value}`}>
                <span className={styles.valueName}>{value}</span>
                {isDefault && <span className={styles.valueTag}>default</span>}
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  aria-label={`Remove ${prop.name} ${value}`}
                  tooltip={isDefault ? 'The default value cannot be removed' : 'Remove value'}
                  disabled={isDefault || values.length < 2}
                  onClick={() => void commitStudioRemoveVariant(spec, prop.name, value)}
                  data-testid={`remove-variant-${prop.name}-${value}`}
                >
                  <CloseIcon size={10} aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {adding && <AddVariantPopover id={`add-variant-${prop.name}`} anchorRef={addRef} spec={spec} prop={prop.name} onClose={() => setAdding(false)} />}
    </li>
  )
}
