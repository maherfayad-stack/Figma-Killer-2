/**
 * fillRowDescriptors — Fill's row TAXONOMY and the copy each row reads.
 *
 * `FillSection.tsx` decides which rows exist and what editing one writes;
 * this file owns the `FillEntryData` union those rows are tagged with, the
 * popover title per kind, and how one `background-image` layer describes
 * itself in the list. Split out of `FillSection.tsx` for
 * `module-size-budgets.test.ts` — that file sat at 698/700 and this ticket
 * needed room for the Mixed contract (`docs/features/inspector.md` §9.3).
 *
 * No component exports here, only plain functions and a type
 * (`react-refresh/only-export-components` — `buildColorFillEntry.tsx`'s own
 * doc names the same constraint). It is a `.tsx` purely because
 * `describeLayer` returns the row's leading glyph.
 */
import type { ReactNode } from 'react'
import type { PropertyListEntry } from '@ui/components/PropertyList'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { ImageSwatch } from './FillSectionParts'
import { parseGradient, isUrlImageValue, extractUrlPayload } from '../../panels/PropertiesPanel/gradientValue'

/** Which Fill row a `PropertyList` entry is. */
export type FillEntryData =
  | { kind: 'text' }
  | { kind: 'contentFit' }
  | { kind: 'layer'; index: number }
  | { kind: 'layersRaw'; raw: string; reason: string }
  | { kind: 'orphanSatellites' }
  | { kind: 'color' }
  | { kind: 'shorthand' }

const POPOVER_TITLES: Record<FillEntryData['kind'], string> = {
  text: 'Text colour',
  contentFit: 'Content fit',
  layer: 'Background layer',
  layersRaw: 'Background image (raw CSS)',
  orphanSatellites: 'Background sizing',
  color: 'Solid fill',
  shorthand: 'Background (raw CSS)',
}

export function popoverTitle(entry: PropertyListEntry<FillEntryData>): string {
  return entry.data.kind === 'layer' ? entry.label : POPOVER_TITLES[entry.data.kind]
}

/**
 * How one `background-image` layer reads in the list. The layer NUMBER is
 * only drawn when there is more than one — a single-layer background is just
 * "the" fill, and numbering it invents a stack the user does not have.
 */
export function describeLayer(
  image: string,
  index: number,
  total: number,
): { label: string; summary: ReactNode; leading: ReactNode } {
  const suffix = total > 1 ? ` ${index + 1}` : ''

  if (image.trim().toLowerCase() === 'none') {
    return {
      label: `Empty layer${suffix}`,
      summary: 'Empty layer',
      leading: <CodeIcon size={14} aria-hidden="true" />,
    }
  }

  if (isUrlImageValue(image)) {
    return {
      label: `Image fill${suffix}`,
      summary: extractUrlPayload(image) || 'Image',
      leading: <ImageSwatch image={image} />,
    }
  }

  const parsed = parseGradient(image)
  if (parsed.ok) {
    const kindLabel = parsed.gradient.kind === 'linear' ? 'Linear gradient' : 'Radial gradient'
    return {
      label: `${kindLabel} fill${suffix}`,
      // The stop count used to live in the row's trailing `value` slot, which
      // the layer's blend select now occupies.
      summary: `${kindLabel} · ${parsed.gradient.stops.length} stops`,
      leading: <ImageSwatch image={image} />,
    }
  }

  return {
    label: `Image fill${suffix}`,
    summary: 'Custom (raw CSS)',
    leading: <CodeIcon size={14} aria-hidden="true" />,
  }
}
