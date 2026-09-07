/**
 * EffectEditorPopover — F21's per-effect editor, opened from a
 * `PropertyList` row in `EffectsSection.tsx`.
 *
 * Three targets, one popover shell:
 *
 *   - `'shadow'`  — a single shadow layer. For `box-shadow` that is F21
 *     exactly: X, Y, Blur, Spread, Colour, and an inset checkbox. For
 *     `text-shadow` (`variant: 'text'`) the Spread field and the inset
 *     checkbox are ABSENT, because `text-shadow` has neither — drawing them
 *     would offer two controls whose writes CSS discards. Every field writes
 *     back through `onSave` with the FULL patched layer; `EffectsSection`
 *     owns re-joining the layer list into the stored value.
 *   - `'blur'`    — a single blur radius, backing `filter: blur()` (Layer
 *     blur) or `backdrop-filter: blur()` (Background blur).
 *   - `'raw'`     — the honest-refusal case (docs/features/inspector-disclosure.md
 *     §7 / §4 G8): a `box-shadow`/`filter`/`backdrop-filter` value this
 *     module can't restructure without risking a silent rewrite. Reuses
 *     `ClassPropertyRow` directly — the SAME raw-text control every other
 *     unstructured property in this panel already has — rather than
 *     building a second one, plus the reason it's here instead of a
 *     structured editor.
 */
import type { RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ClassPropertyRow } from './ClassPropertyRow'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { ControlRow } from '@ui/components/ControlRow'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Switch } from '@ui/components/Switch'
import type { BoxShadowLayer } from './boxShadowLayers'
import type { PropertyProvenance } from './stylePropertyProvenance'
import styles from './EffectsSection.module.css'

export type EffectEditorTarget =
  | {
      kind: 'shadow'
      label: string
      /** `'box'` (default) draws Spread + inset; `'text'` omits both — see the module doc. */
      variant?: 'box' | 'text'
      layer: BoxShadowLayer
      onSave: (layer: BoxShadowLayer) => void
      /** As-you-drag/type preview — `EffectsSection` re-serialises the WHOLE `box-shadow` value with this one layer patched in. */
      onPreview?: (layer: BoxShadowLayer) => void
      onClearPreview?: () => void
    }
  | {
      kind: 'blur'
      label: string
      radius: string
      onSave: (radius: string) => void
      onPreview?: (radius: string) => void
      onClearPreview?: () => void
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
      /** Track F1 — passed through to the reused `ClassPropertyRow` so a raw fallback row still shows why another declaration shadows it. */
      provenance?: PropertyProvenance
    }

interface EffectEditorPopoverProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  target: EffectEditorTarget
}

export function EffectEditorPopover({ id, anchorRef, onClose, target }: EffectEditorPopoverProps) {
  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={target.label} width={248}>
      {target.kind === 'shadow' ? (
        <ShadowLayerFields
          layer={target.layer}
          variant={target.variant ?? 'box'}
          onSave={target.onSave}
          onPreview={target.onPreview}
          onClearPreview={target.onClearPreview}
        />
      ) : target.kind === 'blur' ? (
        <ControlRow propKey="effect-blur-radius" label="Radius" layout="caption">
          <ScrubInput
            aria-label={`${target.label} radius`}
            label="B"
            value={target.radius}
            unit="px"
            onChange={(next) => target.onSave(next)}
            onPreview={target.onPreview}
            onClearPreview={target.onClearPreview}
          />
        </ControlRow>
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
            provenance={target.provenance}
          />
        </div>
      )}
    </InspectorPopover>
  )
}

function ShadowLayerFields({
  layer,
  variant,
  onSave,
  onPreview,
  onClearPreview,
}: {
  layer: BoxShadowLayer
  variant: 'box' | 'text'
  onSave: (layer: BoxShadowLayer) => void
  onPreview?: (layer: BoxShadowLayer) => void
  onClearPreview?: () => void
}) {
  function patch(next: Partial<BoxShadowLayer>) {
    onSave({ ...layer, ...next })
  }

  function previewPatch(next: Partial<BoxShadowLayer>) {
    onPreview?.({ ...layer, ...next })
  }

  function setInset(checked: boolean) {
    patch({ inset: checked, insetPosition: checked ? 'leading' : 'none' })
  }

  function setColor(value: string) {
    patch({
      color: value,
      colorPosition: value === '' ? 'none' : layer.colorPosition === 'leading' ? 'leading' : 'trailing',
    })
  }

  return (
    <div className={styles.shadowFields}>
      {variant === 'box' && (
        <label className={styles.insetRow}>
          <Switch checked={layer.inset} onCheckedChange={setInset} switchSize="sm" />
          <span>Inset</span>
        </label>
      )}
      <div className={styles.shadowGrid}>
        <ControlRow propKey="effect-shadow-x" label="X" layout="caption">
          <ScrubInput
            aria-label="Shadow X offset"
            label="X"
            value={layer.offsetX}
            unit="px"
            onChange={(next) => patch({ offsetX: next })}
            onPreview={(next) => previewPatch({ offsetX: next })}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
        <ControlRow propKey="effect-shadow-y" label="Y" layout="caption">
          <ScrubInput
            aria-label="Shadow Y offset"
            label="Y"
            value={layer.offsetY}
            unit="px"
            onChange={(next) => patch({ offsetY: next })}
            onPreview={(next) => previewPatch({ offsetY: next })}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
        <ControlRow propKey="effect-shadow-blur" label="Blur" layout="caption">
          <ScrubInput
            aria-label="Shadow blur radius"
            label="B"
            value={layer.blurRadius}
            unit="px"
            min={0}
            onChange={(next) => patch({ blurRadius: next })}
            onPreview={(next) => previewPatch({ blurRadius: next })}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
        {variant === 'box' && (
          <ControlRow propKey="effect-shadow-spread" label="Spread" layout="caption">
            <ScrubInput
              aria-label="Shadow spread radius"
              label="S"
              value={layer.spreadRadius}
              unit="px"
              onChange={(next) => patch({ spreadRadius: next })}
              onPreview={(next) => previewPatch({ spreadRadius: next })}
              onClearPreview={onClearPreview}
            />
          </ControlRow>
        )}
      </div>
      <ControlRow propKey="effect-shadow-color" label="Colour" layout="caption">
        <ColorValueInput
          value={layer.color}
          ariaLabel="Shadow colour"
          swatchLabel="Shadow colour swatch"
          onChange={setColor}
          onPreview={onPreview ? (value) => previewPatch({ color: value }) : undefined}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    </div>
  )
}
