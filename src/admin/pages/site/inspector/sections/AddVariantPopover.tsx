/**
 * AddVariantPopover — "Add variant" for one component: pick the axis (when the
 * component has several), type the new value's name, and Studio writes it into
 * the component's own source (CV-3): the union member, plus a copy of the
 * default value's style as the starting point.
 *
 * Mounted from two places that share this one form: the Component section's
 * "Component properties" editor (axis fixed by the row's "+"), and the "+" in
 * a variants-gallery frame's header (axis chosen here).
 *
 * When the component styles that prop in code Studio cannot extend safely (a
 * ternary, a switch — the variant read model's `opaque`), the form says so, with
 * the line, and offers to open it; it never offers a button that would only be
 * refused. The server decides again at write time from the files as they are.
 */
import { useState, type RefObject } from 'react'
import { variantNameError } from '@core/component-variants'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { jumpToSource } from '@site/panels/PropertiesPanel/jumpToSource'
import { commitStudioAddVariant } from '@site/studio/studioVariantCommits'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { Select } from '@ui/components/Select'
import { blockerOf, copySourceOf, enumPropsOf, valuesOf } from './variantAxes'
import styles from './ComponentProperties.module.css'

interface AddVariantPopoverProps {
  /** Distinguishes popovers that can be open at once (a row's and a gallery header's). */
  id: string
  anchorRef: RefObject<HTMLElement | null>
  spec: LocalComponentSpec
  /** Fixed axis (the editor row's "+"); omit to choose among the component's enum props. */
  prop?: string
  onClose: () => void
}

export function AddVariantPopover({ id, anchorRef, spec, prop, onClose }: AddVariantPopoverProps) {
  const axes = enumPropsOf(spec)
  const [axisName, setAxisName] = useState(prop ?? axes[0]?.name ?? '')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const axis = axes.find((candidate) => candidate.name === axisName)
  const error = variantNameError(name, axis ? valuesOf(axis) : [])
  const blocker = blockerOf(axis)
  const copiedFrom = axis ? copySourceOf(axis) : null
  const ready = blocker === null && name.trim() !== '' && error === null && !submitting

  async function submit() {
    if (!ready) return
    setSubmitting(true)
    await commitStudioAddVariant(spec, axisName, name.trim())
    setSubmitting(false)
    onClose()
  }

  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title="Add variant" width={248}>
      <form
        className={styles.popoverForm}
        data-testid="add-variant-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {prop === undefined && axes.length > 1 && (
          <Select
            fieldSize="xs"
            aria-label="Property to add a variant to"
            value={axisName}
            options={axes.map((candidate) => ({ value: candidate.name, label: candidate.name }))}
            onChange={(event) => setAxisName(event.target.value)}
          />
        )}
        {blocker ? (
          <div className={styles.notice} role="status" data-testid="add-variant-blocked">
            <p className={styles.noticeText}>{blocker.message}</p>
            {blocker.file !== undefined && blocker.line !== undefined && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => jumpToSource({ rel: blocker.file!, line: blocker.line!, col: 1 })}
                data-testid="add-variant-open-code"
              >
                Open in code
              </Button>
            )}
          </div>
        ) : (
          <>
            <Input
              fieldSize="xs"
              autoFocus
              value={name}
              placeholder="Name, e.g. danger"
              aria-label="New variant name"
              invalid={error !== null}
              onChange={(event) => setName(event.target.value)}
              data-testid="add-variant-name"
            />
            {error !== null && (
              <p className={styles.fieldError} role="alert">
                {error}
              </p>
            )}
            {copiedFrom !== null && <p className={styles.hint}>Starts as a copy of "{copiedFrom}"'s style.</p>}
            <Button variant="primary" size="xs" type="submit" disabled={!ready} loading={submitting} data-testid="add-variant-submit">
              Add variant
            </Button>
          </>
        )}
      </form>
    </InspectorPopover>
  )
}
