/**
 * EffectEditorPopover — the per-row editor behind every Effects row
 * (`EffectsSection.tsx`). One popover shell, three shapes, chosen by the
 * row's own `EffectEntryData`:
 *
 *   - a parsed shadow layer (`box-shadow` or `text-shadow`) → F21's fields:
 *     X, Y, Blur, Spread, Colour, Inset. `variant: 'text'` omits Spread and
 *     Inset, which `text-shadow` has no concept of;
 *   - a lone `blur(<length>)` (`filter` / `backdrop-filter`) → one radius
 *     field, written back as `blur(<value>)`;
 *   - anything the models refuse to restructure — a shadow that does not
 *     round-trip, a filter that is more than one `blur()`, or a
 *     multi-selection whose members disagree — → the WHOLE declaration as one
 *     raw field, with the reason above it. Never a guessed rewrite
 *     (`CLAUDE.md` §"Studio-specific"), and never a stringified `MIXED`
 *     Symbol: `ClassPropertyRow` turns the sentinel into its own "Mixed"
 *     placeholder.
 *
 * Shadow and Blur used to carry one copy each of this file's raw-row shape;
 * merging the two sections into Effects (P2-F, owner decision OD-4) made
 * them one.
 */
import type { RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { ControlRow } from '@ui/components/ControlRow'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import type { PropertyListEntry } from '@ui/components/PropertyList'
import { ScrubInput } from '@ui/components/ScrubInput'
import { Switch } from '@ui/components/Switch'
import { MIXED } from '@ui/components/MixedValue'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { ClassPropertyRow } from '../../panels/PropertiesPanel/ClassPropertyRow'
import {
  serializeBoxShadowLayers,
  updateBoxShadowLayer,
  type BoxShadowLayer,
  type BoxShadowParseResult,
} from './boxShadowLayers'
import styles from './EffectsSection.module.css'

/** What one Effects row stands for — the payload `PropertyList` hands back. */
export type EffectEntryData =
  | { kind: 'shadowLayer'; index: number; layer: BoxShadowLayer }
  | { kind: 'boxShadowRaw'; raw: string; reason: string }
  | { kind: 'textShadowLayer'; index: number; layer: BoxShadowLayer }
  | { kind: 'textShadowRaw'; raw: string; reason: string }
  | { kind: 'layerBlur'; radius: string }
  | { kind: 'layerBlurRaw'; raw: string }
  | { kind: 'backgroundBlur'; radius: string }
  | { kind: 'backgroundBlurRaw'; raw: string }
  /** A multi-selection whose members declare different values — §9.3. */
  | { kind: 'mixed'; property: EffectProperty }

/** The four declarations the Effects section owns. */
export type EffectProperty = 'boxShadow' | 'textShadow' | 'filter' | 'backdropFilter'

const MIXED_SHADOW_REASON =
  'The selected layers set different shadows, so there is no shared layer stack to edit. Typing a value here writes it to every selected layer.'
const MIXED_FILTER_REASON =
  'The selected layers set different values here. Typing one writes it to every selected layer.'

interface EffectEditorPopoverProps {
  id: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  entry: PropertyListEntry<EffectEntryData>
  boxShadowResult: BoxShadowParseResult
  textShadowResult: BoxShadowParseResult
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview: () => void
}

export function EffectEditorPopover({
  id,
  anchorRef,
  onClose,
  entry,
  boxShadowResult,
  textShadowResult,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: EffectEditorPopoverProps) {
  const { data, label } = entry

  if (data.kind === 'shadowLayer' || data.kind === 'textShadowLayer') {
    const isText = data.kind === 'textShadowLayer'
    const property: keyof CSSPropertyBag = isText ? 'textShadow' : 'boxShadow'
    const result = isText ? textShadowResult : boxShadowResult
    if (result.kind !== 'layers') return null
    const index = data.index

    function save(nextLayer: BoxShadowLayer) {
      if (result.kind !== 'layers') return
      onChange(property, serializeBoxShadowLayers(updateBoxShadowLayer(result.layers, index, nextLayer)))
    }

    function preview(nextLayer: BoxShadowLayer) {
      if (result.kind !== 'layers') return
      onPreview({
        [property]: serializeBoxShadowLayers(updateBoxShadowLayer(result.layers, index, nextLayer)),
      } as Partial<CSSPropertyBag>)
    }

    return (
      <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
        <ShadowLayerFields
          layer={data.layer}
          variant={isText ? 'text' : 'box'}
          onSave={save}
          onPreview={preview}
          onClearPreview={onClearPreview}
        />
      </InspectorPopover>
    )
  }

  if (data.kind === 'layerBlur' || data.kind === 'backgroundBlur') {
    const property: keyof CSSPropertyBag = data.kind === 'layerBlur' ? 'filter' : 'backdropFilter'
    return (
      <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
        <ControlRow propKey="blur-radius" label="Radius" layout="caption">
          <ScrubInput
            aria-label={`${label} radius`}
            label="B"
            value={data.radius}
            unit="px"
            min={0}
            onChange={(next) => onChange(property, `blur(${next})`)}
            onPreview={(next) => onPreview({ [property]: `blur(${next})` } as Partial<CSSPropertyBag>)}
            onClearPreview={onClearPreview}
          />
        </ControlRow>
      </InspectorPopover>
    )
  }

  const { property, value, reason } = rawRow(data)
  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title={label} width={248}>
      <div className={styles.rawEditor}>
        <p className={styles.rawEditorReason}>{reason}</p>
        <ClassPropertyRow
          property={property}
          value={value}
          isSet
          layout="stacked"
          onChange={onChange}
          onRemove={onRemove}
          onPreview={(prop, next) => onPreview({ [prop]: next ?? null } as Partial<CSSPropertyBag>)}
          onClearPreview={onClearPreview}
        />
      </div>
    </InspectorPopover>
  )
}

type RawEntryData = Exclude<
  EffectEntryData,
  { kind: 'shadowLayer' | 'textShadowLayer' | 'layerBlur' | 'backgroundBlur' }
>

/** The declaration, value and reason a raw (refused or Mixed) row edits. */
function rawRow(data: RawEntryData): {
  property: EffectProperty
  value: string | typeof MIXED
  reason: string
} {
  switch (data.kind) {
    case 'mixed':
      return {
        property: data.property,
        value: MIXED,
        reason:
          data.property === 'boxShadow' || data.property === 'textShadow'
            ? MIXED_SHADOW_REASON
            : MIXED_FILTER_REASON,
      }
    case 'boxShadowRaw':
      return { property: 'boxShadow', value: data.raw, reason: data.reason }
    case 'textShadowRaw':
      return { property: 'textShadow', value: data.raw, reason: data.reason }
    case 'layerBlurRaw':
      return {
        property: 'filter',
        value: data.raw,
        reason: 'This filter is more than a single blur(), so it stays as text.',
      }
    case 'backgroundBlurRaw':
      return {
        property: 'backdropFilter',
        value: data.raw,
        reason: 'This backdrop-filter is more than a single blur(), so it stays as text.',
      }
  }
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
  onPreview: (layer: BoxShadowLayer) => void
  onClearPreview: () => void
}) {
  function patch(next: Partial<BoxShadowLayer>) {
    onSave({ ...layer, ...next })
  }

  function previewPatch(next: Partial<BoxShadowLayer>) {
    onPreview({ ...layer, ...next })
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
        <ControlRow propKey="shadow-x" label="X" layout="caption">
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
        <ControlRow propKey="shadow-y" label="Y" layout="caption">
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
        <ControlRow propKey="shadow-blur" label="Blur" layout="caption">
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
          <ControlRow propKey="shadow-spread" label="Spread" layout="caption">
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
      <ControlRow propKey="shadow-color" label="Colour" layout="caption">
        <ColorValueInput
          value={layer.color}
          ariaLabel="Shadow colour"
          swatchLabel="Shadow colour swatch"
          onChange={setColor}
          onPreview={(value) => previewPatch({ color: value })}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    </div>
  )
}
