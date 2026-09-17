/**
 * FillEntryPopover — what opens when a Fill row is activated.
 *
 * `FillSection.tsx` decides which ROWS exist (and, for the colour rows,
 * edits them inline without ever opening this); this file is the one switch
 * over `FillEntryData['kind']` that picks the body, wrapped in the shared
 * `InspectorPopover`. Split out of `FillSection.tsx` for
 * `module-size-budgets.test.ts` — that file sat at 698/700 and this ticket
 * needed room for the Mixed contract (`docs/features/inspector.md` §9.3).
 *
 * The bodies themselves stay in `FillSectionParts.tsx` / `FillColorField.tsx`;
 * nothing about *drawing* one moved here, only the choice of which to draw.
 */
import type { RefObject } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import type { PropertyListEntry } from '@ui/components/PropertyList'
import {
  BackgroundDeclarationsBody,
  BackgroundImageRawBody,
  BackgroundLayerPopoverBody,
  ContentFitPopoverBody,
  ShorthandEscapeHatchBody,
} from './FillSectionParts'
import { ColorWriteRefusalBody } from './FillColorField'
import { popoverTitle, type FillEntryData } from './fillRowDescriptors'
import {
  BACKGROUND_SATELLITE_PROPS,
  type BackgroundModel,
  type BackgroundSatelliteProp,
} from '../../panels/PropertiesPanel/backgroundLayers'
import type { WriteTarget } from '../resolveWriteTarget'

/** The mixed-layers body offers `background-image` itself; the other two draw it as their own row. */
const MIXED_BACKGROUND_PROPS: ReadonlyArray<BackgroundSatelliteProp | 'backgroundImage'> = [
  'backgroundImage',
  ...BACKGROUND_SATELLITE_PROPS,
]

export function FillEntryPopover({
  entry,
  anchorRef,
  onClose,
  parsedModel,
  mixedSatellites,
  shorthandMixed,
  textWriteTarget,
  colorWriteTarget,
  textMutedValue,
  colorMutedValue,
  storedStyles,
  currentStyles,
  activeTab,
  shorthandValue,
  onModelChange,
  onChange,
  onPreview,
  onClearPreview,
}: {
  entry: PropertyListEntry<FillEntryData>
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  parsedModel: BackgroundModel
  /** Satellites whose stored cell is the `MIXED` sentinel — empty for one node. */
  mixedSatellites: ReadonlySet<BackgroundSatelliteProp>
  /** The selection disagrees on the `background` shorthand. */
  shorthandMixed: boolean
  /** Null once `color` is stored here — the row then edits inline. */
  textWriteTarget: WriteTarget | null
  colorWriteTarget: WriteTarget | null
  textMutedValue: string | undefined
  colorMutedValue: string | undefined
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  activeTab: string
  shorthandValue: string | undefined
  onModelChange: (next: BackgroundModel) => void
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview: () => void
}) {
  const { data } = entry

  return (
    <InspectorPopover
      id={entry.id}
      anchorRef={anchorRef}
      onClose={onClose}
      title={popoverTitle(entry)}
      width={data.kind === 'layer' ? 264 : undefined}
    >
      {data.kind === 'text' && textWriteTarget?.kind === 'none' && (
        <ColorWriteRefusalBody
          ariaLabel="Text colour"
          swatchLabel="Text colour swatch"
          value={textMutedValue}
          reason={textWriteTarget.reason}
        />
      )}

      {data.kind === 'color' && colorWriteTarget?.kind === 'none' && (
        <ColorWriteRefusalBody
          ariaLabel="Solid fill colour"
          swatchLabel="Solid fill colour swatch"
          value={colorMutedValue}
          reason={colorWriteTarget.reason}
        />
      )}

      {data.kind === 'layer' && (
        <BackgroundLayerPopoverBody
          model={parsedModel}
          index={data.index}
          mixedSatellites={mixedSatellites}
          onModelChange={onModelChange}
          onChange={onChange}
        />
      )}

      {data.kind === 'layersRaw' && (
        <BackgroundImageRawBody
          value={data.raw}
          reason={data.reason}
          onChange={(next) => onChange('backgroundImage', next || undefined)}
        />
      )}

      {data.kind === 'mixedLayers' && (
        <BackgroundDeclarationsBody
          reason="mixed-layers"
          properties={MIXED_BACKGROUND_PROPS}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          activeTab={activeTab}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      )}

      {data.kind === 'orphanSatellites' && (
        <BackgroundDeclarationsBody
          reason={parsedModel.spine.kind === 'raw' ? 'refused-layers' : 'no-layer'}
          properties={BACKGROUND_SATELLITE_PROPS}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          activeTab={activeTab}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      )}

      {data.kind === 'contentFit' && (
        <ContentFitPopoverBody
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          activeTab={activeTab}
          onChange={onChange}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      )}

      {data.kind === 'shorthand' && (
        <ShorthandEscapeHatchBody
          value={shorthandValue}
          mixed={shorthandMixed}
          onChange={(next) => onChange('background', next || undefined)}
        />
      )}
    </InspectorPopover>
  )
}
