/**
 * AddPropertyPopover — "Add property" for one component (CV-3): a name, a
 * type (on/off, text or variant), and a default. Studio writes an OPTIONAL prop
 * with that default into the component's signature, so every existing call
 * site renders exactly as before.
 *
 * A variant property takes its values as a comma-separated list; the first is
 * the default. The name rules are the codemod's (`variantNameError`,
 * `propNameError`), asked here first so the form can say what is wrong before
 * a round trip; the server asks again from the files as they are.
 */
import { useState, type RefObject } from 'react'
import { PROP_NAME_PATTERN, VARIANT_NAME_PATTERN, propNameError } from '@core/component-variants'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { commitStudioAddComponentProp, type NewPropertyType } from '@site/studio/studioVariantCommits'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Switch } from '@ui/components/Switch'
import styles from './ComponentProperties.module.css'

type PropertyKind = NewPropertyType['kind']

interface AddPropertyPopoverProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  spec: LocalComponentSpec
  onClose: () => void
}

/** The values typed into a variant property's field: trimmed, de-duplicated, empties dropped. */
function parseMembers(text: string): string[] {
  return [...new Set(text.split(',').map((member) => member.trim()).filter((member) => member !== ''))]
}

/** What is wrong with the variant values typed so far, or `null`. */
function membersError(members: readonly string[]): string | null {
  const bad = members.find((member) => !VARIANT_NAME_PATTERN.test(member))
  if (bad !== undefined) return `"${bad}" is not a usable value: start with a letter, then letters, digits, "-" or "_".`
  return members.length > 0 && members.length < 2 ? 'A variant property needs at least two values.' : null
}

export function AddPropertyPopover({ id, anchorRef, spec, onClose }: AddPropertyPopoverProps) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<PropertyKind>('boolean')
  const [flag, setFlag] = useState(false)
  const [text, setText] = useState('')
  const [valuesText, setValuesText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const nameError = propNameError(name, spec.props.map((prop) => prop.name))
  const members = parseMembers(valuesText)
  const valuesError = kind === 'variant' ? membersError(members) : null
  const trimmed = name.trim()
  const ready =
    trimmed !== '' && PROP_NAME_PATTERN.test(trimmed) && nameError === null && (kind !== 'variant' || (members.length >= 2 && valuesError === null)) && !submitting

  async function submit() {
    if (!ready) return
    const propType: NewPropertyType =
      kind === 'boolean' ? { kind, defaultValue: flag } : kind === 'text' ? { kind, defaultValue: text } : { kind, members }
    setSubmitting(true)
    await commitStudioAddComponentProp(spec, trimmed, propType)
    setSubmitting(false)
    onClose()
  }

  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title="Add property" width={248}>
      <form
        className={styles.popoverForm}
        data-testid="add-property-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Input
          fieldSize="xs"
          autoFocus
          value={name}
          placeholder="Name, e.g. disabled"
          aria-label="New property name"
          invalid={nameError !== null}
          onChange={(event) => setName(event.target.value)}
          data-testid="add-property-name"
        />
        {nameError !== null && (
          <p className={styles.fieldError} role="alert">
            {nameError}
          </p>
        )}
        <SegmentedControl<PropertyKind>
          size="xs"
          fullWidth
          aria-label="Property type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'boolean', label: 'On/off' },
            { value: 'text', label: 'Text' },
            { value: 'variant', label: 'Variant' },
          ]}
          data-testid="add-property-type"
        />
        {kind === 'boolean' && (
          <label className={styles.inlineRow}>
            <span className={styles.hint}>Default on</span>
            <Switch checked={flag} onCheckedChange={setFlag} switchSize="sm" aria-label="Default on" />
          </label>
        )}
        {kind === 'text' && (
          <Input fieldSize="xs" value={text} placeholder="Default text" aria-label="Default text" onChange={(event) => setText(event.target.value)} />
        )}
        {kind === 'variant' && (
          <>
            <Input
              fieldSize="xs"
              value={valuesText}
              placeholder="Values, e.g. sm, md, lg"
              aria-label="Variant values"
              invalid={valuesError !== null}
              onChange={(event) => setValuesText(event.target.value)}
              data-testid="add-property-values"
            />
            {valuesError !== null ? (
              <p className={styles.fieldError} role="alert">
                {valuesError}
              </p>
            ) : (
              <p className={styles.hint}>The first value is the default.</p>
            )}
          </>
        )}
        <Button variant="primary" size="xs" type="submit" disabled={!ready} loading={submitting} data-testid="add-property-submit">
          Add property
        </Button>
      </form>
    </InspectorPopover>
  )
}
