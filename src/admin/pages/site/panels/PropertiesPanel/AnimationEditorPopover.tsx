/**
 * AnimationEditorPopover — the per-animation editor opened from a
 * `PropertyList` row in `AnimationsSection.tsx`.
 *
 * Three targets, one popover shell, exactly as `EffectEditorPopover` has:
 *
 *   - `'animation'` — the eight components of one CSS animation across two
 *     tabs. **Timing** is duration / delay / easing / iterations / direction /
 *     fill; **Keyframes** is the steps of the `@keyframes` block the
 *     animation's name refers to.
 *   - `'transition'` — duration / easing / delay only. The property list is
 *     shown but not editable; see `transitionValue.ts` for why that is the
 *     scope rather than an omission.
 *   - `'raw'` — the honest-refusal case, reusing `ClassPropertyRow` (the same
 *     raw-text control every unstructured property in this panel already has)
 *     plus the sentence saying why a structured editor is not offered.
 *
 * ## Easing: presets AND `cubic-bezier`
 *
 * The easing control is a `Select` of the CSS keywords plus a "Custom…" entry
 * that reveals a text field. A select alone would silently discard a
 * `cubic-bezier(.17,.67,.83,.67)` the moment anything else in the row changed,
 * which is the class of quiet destruction this whole pipeline exists to
 * refuse; a text field alone would make the common case (pick `ease-out`)
 * needlessly expert. A value that is already a function shows the field open,
 * with the function in it.
 *
 * ## Keyframes editing, and its lock
 *
 * A step's declarations are edited as text — property and value, one row per
 * declaration. Not because a typed control per property would be worse, but
 * because a keyframe body can hold ANY property, including ones this panel has
 * no control for, and a typed grid would have to either hide them or invent
 * controls for them. Every edit goes through `applyKeyframeStepEdit`, i.e.
 * through the same codemod the server runs on the real file.
 *
 * When the `@keyframes` block cannot be written — it came from compiled output,
 * or Studio could not map it to a hand-authored file — the steps are shown
 * READ-ONLY with the standard lock sentence above them. Showing them still
 * helps: knowing what `shimmer` does is most of why anyone opens this.
 */
import { useState, type RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { Input } from '@ui/components/Input'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Select } from '@ui/components/Select'
import { ClassPropertyRow } from './ClassPropertyRow'
import { ClassCssLockedNotice } from './ClassCssLockedNotice'
import {
  isTimingFunction,
  type AnimationField,
  type ResolvedAnimation,
} from './animationValue'
import { applyKeyframeStepEdit, type ResolvedKeyframes } from './keyframesModel'
import type { ResolvedTransition, TransitionField } from './transitionValue'
import styles from './AnimationsSection.module.css'

/** The CSS easing keywords, in the order a designer reaches for them. `custom` opens the free-text field. */
const EASING_PRESETS = ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end'] as const

const DIRECTIONS = ['normal', 'reverse', 'alternate', 'alternate-reverse'] as const
const FILL_MODES = ['none', 'forwards', 'backwards', 'both'] as const

export type AnimationEditorTarget =
  | {
      kind: 'animation'
      label: string
      animation: ResolvedAnimation
      /** The `@keyframes` block this animation's name refers to, or `null` when no such block exists. */
      keyframes: ResolvedKeyframes | null
      onFieldChange: (field: AnimationField, value: string) => void
      onKeyframesChange: (ruleId: string, rawCss: string) => void
    }
  | {
      kind: 'transition'
      label: string
      transition: ResolvedTransition
      onFieldChange: (field: TransitionField, value: string) => void
    }
  | {
      kind: 'raw'
      label: string
      property: keyof CSSPropertyBag
      value: string
      reason: string
      onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
      onRemove: (property: keyof CSSPropertyBag) => void
      onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
      onClearPreview?: () => void
    }

interface AnimationEditorPopoverProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  target: AnimationEditorTarget
}

export function AnimationEditorPopover({ id, anchorRef, onClose, target }: AnimationEditorPopoverProps) {
  if (target.kind === 'animation') {
    return (
      <InspectorPopover
        id={id}
        anchorRef={anchorRef}
        onClose={onClose}
        title={target.label}
        width={272}
        tabs={[
          { value: 'timing', label: 'Timing', content: <AnimationTimingTab target={target} /> },
          { value: 'keyframes', label: 'Keyframes', content: <KeyframesTab target={target} /> },
        ]}
      />
    )
  }

  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={target.label} width={272}>
      {target.kind === 'transition' ? (
        <TransitionFields target={target} />
      ) : (
        <div className={styles.rawEditor}>
          <p className={styles.rawEditorReason}>{target.reason}</p>
          <ClassPropertyRow
            property={target.property}
            value={target.value}
            isSet
            layout="stacked"
            onChange={target.onChange}
            onRemove={target.onRemove}
            onPreview={target.onPreview}
            onClearPreview={target.onClearPreview}
          />
        </div>
      )}
    </InspectorPopover>
  )
}

// ---------------------------------------------------------------------------
// Easing — presets + cubic-bezier (see module doc)
// ---------------------------------------------------------------------------

const CUSTOM_EASING = '__custom__'

function EasingField({
  propKey,
  value,
  onChange,
}: {
  propKey: string
  value: string
  onChange: (next: string) => void
}) {
  const isPreset = (EASING_PRESETS as readonly string[]).includes(value)
  // A value that is already a function opens the field, so an existing
  // `cubic-bezier(…)` is visible and editable rather than silently replaced by
  // whichever preset the select would otherwise land on.
  const [custom, setCustom] = useState(!isPreset && isTimingFunction(value))

  return (
    <>
      <ControlRow propKey={propKey} label="Easing" layout="caption">
        <Select
          fieldSize="sm"
          aria-label="Easing"
          value={custom ? CUSTOM_EASING : value}
          onChange={(event) => {
            const next = event.target.value
            if (next === CUSTOM_EASING) {
              setCustom(true)
              return
            }
            setCustom(false)
            onChange(next)
          }}
        >
          {EASING_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
          <option value={CUSTOM_EASING}>Custom…</option>
        </Select>
      </ControlRow>
      {custom && (
        <ControlRow propKey={`${propKey}-custom`} label="Curve" layout="caption">
          <Input
            fieldSize="sm"
            aria-label="Custom easing function"
            placeholder="cubic-bezier(.4, 0, .2, 1)"
            defaultValue={isPreset ? '' : value}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next) onChange(next)
            }}
          />
        </ControlRow>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Animation — Timing tab
// ---------------------------------------------------------------------------

function AnimationTimingTab({ target }: { target: Extract<AnimationEditorTarget, { kind: 'animation' }> }) {
  const { animation, onFieldChange } = target
  const infinite = animation.iterationCount.trim().toLowerCase() === 'infinite'

  return (
    <div className={styles.tabBody}>
      <div className={styles.fieldGrid}>
        <ControlRow propKey="animation-duration" label="Duration" layout="caption">
          <ScrubInput
            aria-label="Animation duration"
            label="D"
            value={animation.duration}
            unit="ms"
            min={0}
            step={10}
            onChange={(next) => onFieldChange('duration', next)}
          />
        </ControlRow>
        <ControlRow propKey="animation-delay" label="Delay" layout="caption">
          <ScrubInput
            aria-label="Animation delay"
            label="W"
            value={animation.delay}
            unit="ms"
            step={10}
            onChange={(next) => onFieldChange('delay', next)}
          />
        </ControlRow>
      </div>
      <EasingField
        propKey="animation-easing"
        value={animation.timingFunction}
        onChange={(next) => onFieldChange('timingFunction', next)}
      />
      <ControlRow propKey="animation-iterations" label="Repeat" layout="caption">
        <div className={styles.iterationRow}>
          <Input
            fieldSize="sm"
            type="number"
            min={1}
            aria-label="Iteration count"
            disabled={infinite}
            value={infinite ? '' : animation.iterationCount}
            placeholder={infinite ? '∞' : '1'}
            onChange={(event) => {
              const next = event.target.value.trim()
              if (next) onFieldChange('iterationCount', next)
            }}
          />
          <Button
            variant="ghost"
            size="xs"
            pressed={infinite}
            aria-label="Repeat forever"
            tooltip="Repeat forever"
            onClick={() => onFieldChange('iterationCount', infinite ? '1' : 'infinite')}
          >
            ∞
          </Button>
        </div>
      </ControlRow>
      <ControlRow propKey="animation-direction" label="Direction" layout="caption">
        <Select
          fieldSize="sm"
          aria-label="Animation direction"
          value={animation.direction}
          onChange={(event) => onFieldChange('direction', event.target.value)}
        >
          {DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {direction}
            </option>
          ))}
        </Select>
      </ControlRow>
      <ControlRow
        propKey="animation-fill"
        label="Fill"
        layout="caption"
        description="What the element looks like before the animation starts and after it ends."
      >
        <Select
          fieldSize="sm"
          aria-label="Animation fill mode"
          value={animation.fillMode}
          onChange={(event) => onFieldChange('fillMode', event.target.value)}
        >
          {FILL_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </Select>
      </ControlRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Animation — Keyframes tab
// ---------------------------------------------------------------------------

function KeyframesTab({ target }: { target: Extract<AnimationEditorTarget, { kind: 'animation' }> }) {
  const { animation, keyframes, onKeyframesChange } = target

  if (!animation.name) {
    return <p className={styles.emptyNote}>This animation has no name, so there is no @keyframes block to show.</p>
  }
  if (!keyframes) {
    return (
      <p className={styles.emptyNote}>
        No <code>@keyframes {animation.name}</code> in this project. It may be defined in a stylesheet Studio could not
        parse, or the name may be a typo.
      </p>
    )
  }
  if (keyframes.steps === null) {
    return <p className={styles.emptyNote}>Studio could not read this @keyframes block, so it is left untouched.</p>
  }

  const locked = keyframes.lockReason !== null
  const rawCss = typeof keyframes.rule.rawCss === 'string' ? keyframes.rule.rawCss : ''

  function editStep(keyText: string, property: string, value: string | undefined) {
    const next = applyKeyframeStepEdit(rawCss, animation.name, keyText, property, value)
    if (next !== null) onKeyframesChange(keyframes!.rule.id, next)
  }

  return (
    <div className={styles.tabBody}>
      {keyframes.lockReason && (
        <ClassCssLockedNotice selector={keyframes.rule.selector} reason={keyframes.lockReason} />
      )}
      {keyframes.steps.length === 0 && <p className={styles.emptyNote}>This animation has no steps yet.</p>}
      {keyframes.steps.map((step) => (
        <div key={step.keyText} className={styles.keyframeStep}>
          <div className={styles.keyframeOffset}>{step.keyText}</div>
          {Object.entries(step.declarations).map(([property, value]) => (
            <ControlRow key={property} propKey={`kf-${step.keyText}-${property}`} label={property} layout="caption">
              <div className={styles.keyframeDeclaration}>
                <Input
                  fieldSize="sm"
                  aria-label={`${step.keyText} ${property}`}
                  defaultValue={value}
                  disabled={locked}
                  onBlur={(event) => {
                    const next = event.target.value.trim()
                    if (next && next !== value) editStep(step.keyText, property, next)
                  }}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  disabled={locked}
                  aria-label={`Remove ${property} from ${step.keyText}`}
                  tooltip="Remove declaration"
                  onClick={() => editStep(step.keyText, property, undefined)}
                >
                  ×
                </Button>
              </div>
            </ControlRow>
          ))}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transition fields
// ---------------------------------------------------------------------------

function TransitionFields({ target }: { target: Extract<AnimationEditorTarget, { kind: 'transition' }> }) {
  const { transition, onFieldChange } = target

  return (
    <div className={styles.tabBody}>
      <ControlRow
        propKey="transition-property"
        label="Property"
        layout="caption"
        description="Which properties a transition covers is edited in the CSS itself — Studio only changes its timing."
      >
        <Input fieldSize="sm" aria-label="Transitioned property" value={transition.property} readOnly disabled />
      </ControlRow>
      <div className={styles.fieldGrid}>
        <ControlRow propKey="transition-duration" label="Duration" layout="caption">
          <ScrubInput
            aria-label="Transition duration"
            label="D"
            value={transition.duration}
            unit="ms"
            min={0}
            step={10}
            onChange={(next) => onFieldChange('duration', next)}
          />
        </ControlRow>
        <ControlRow propKey="transition-delay" label="Delay" layout="caption">
          <ScrubInput
            aria-label="Transition delay"
            label="W"
            value={transition.delay}
            unit="ms"
            step={10}
            onChange={(next) => onFieldChange('delay', next)}
          />
        </ControlRow>
      </div>
      <EasingField
        propKey="transition-easing"
        value={transition.timingFunction}
        onChange={(next) => onFieldChange('timingFunction', next)}
      />
    </div>
  )
}
