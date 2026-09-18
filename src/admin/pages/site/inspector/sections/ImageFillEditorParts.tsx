/**
 * ImageFillEditorParts — the image-fill half of a Fill layer's popover
 * (source picker, Fit segmented control, 9-grid position puck). Split out of
 * `FillSectionParts.tsx` purely for `module-size-budgets.test.ts` — this is
 * ONE mode (`mode === 'image'`) of `BackgroundLayerPopoverBody`'s two
 * (gradient / image), drawn here so the parent file stays under the 700-line
 * ceiling. The pure value models this reads (`backgroundLayers.ts`,
 * `imageFillValue.ts`) stay in `panels/PropertiesPanel/`, unchanged.
 */
import { Button } from '@ui/components/Button'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import {
  backgroundLayerSatellite,
  setBackgroundLayerSatellite,
  type BackgroundModel,
} from '../../panels/PropertiesPanel/backgroundLayers'
import { extractUrlPayload, wrapUrlPayload } from '../../panels/PropertiesPanel/gradientValue'
import { ImageSourcePicker } from '../../panels/PropertiesPanel/ImageSourcePicker'
import {
  IMAGE_FILL_FIT_LABELS,
  IMAGE_FILL_FIT_SATELLITES,
  IMAGE_FILL_POSITION_CELLS,
  fitFromSatellites,
  imageFillFileName,
  positionCellFor,
  type ImageFillFit,
} from '../../panels/PropertiesPanel/imageFillValue'
import { imageFillPreviewSrc, useProjectImageAssets } from '@site/studio/projectAssets'
import styles from './FillSection.module.css'

/**
 * The `mode === 'image'` half of a layer popover: what the image IS, then the
 * two things Figma lets you say about it — how it fills the box (Fit) and
 * where it sits (the 9-grid).
 *
 * Both controls are pure sugar over the SAME per-layer satellites the rows
 * underneath still show: Fit writes `background-size` + `background-repeat`,
 * the grid writes `background-position`. Nothing is stored that CSS does not
 * already store, so a value typed into the raw rows below round-trips back
 * into these controls, and a value they cannot express (`12px 40%`,
 * `background-size: 60% auto`) reads as "Custom" / no grid selection instead
 * of being rounded to the nearest thing this UI can draw.
 *
 * When a satellite was REFUSED per-layer (`backgroundLayers.ts`'s reasons —
 * a top-level `var()`, extra values, …) the matching control is not drawn at
 * all. `LayerSatelliteRow` (`FillSectionParts.tsx`) already renders that
 * property's whole-declaration raw field with its reason; offering a
 * friendly control on top of it would write the exact per-layer value the
 * parse refused to invent.
 */
export function ImageFillEditor({
  model,
  index,
  value,
  onModelChange,
  onImageChange,
}: {
  model: BackgroundModel
  index: number
  value: string
  onModelChange: (next: BackgroundModel) => void
  onImageChange: (next: string) => void
}) {
  const assets = useProjectImageAssets()
  const payload = extractUrlPayload(value)
  const previewSrc = imageFillPreviewSrc(payload, assets)

  const sizeView = backgroundLayerSatellite(model, 'backgroundSize', index)
  const repeatView = backgroundLayerSatellite(model, 'backgroundRepeat', index)
  const positionView = backgroundLayerSatellite(model, 'backgroundPosition', index)

  const fitEditable = sizeView.kind !== 'raw' && repeatView.kind !== 'raw'
  const fit = fitFromSatellites(
    sizeView.kind === 'value' ? sizeView.value : '',
    repeatView.kind === 'value' ? repeatView.value : '',
  )

  function applyFit(next: Exclude<ImageFillFit, 'custom'>) {
    const pair = IMAGE_FILL_FIT_SATELLITES[next]
    let updated = setBackgroundLayerSatellite(model, 'backgroundSize', index, pair.backgroundSize)
    updated = setBackgroundLayerSatellite(updated, 'backgroundRepeat', index, pair.backgroundRepeat)
    onModelChange(updated)
  }

  return (
    <div className={styles.imageEditor}>
      <div className={styles.imagePreviewRow}>
        {previewSrc ? (
          <img className={styles.imagePreview} src={previewSrc} alt="" />
        ) : (
          <span className={styles.imagePreview} aria-hidden="true" />
        )}
        <span className={styles.imageName} title={payload}>
          {payload === '' ? 'No image chosen' : imageFillFileName(payload)}
        </span>
      </div>

      <ImageSourcePicker
        value={payload}
        onPick={(next) => onImageChange(next === '' ? "url('')" : wrapUrlPayload(next))}
      />

      {fitEditable && (
        <>
          {/* A custom size/repeat pair selects NO segment — SegmentedControl's own
              unset state — rather than being snapped to the nearest preset. */}
          <SegmentedControl<Exclude<ImageFillFit, 'custom'>>
            value={fit === 'custom' ? undefined : fit}
            options={(['cover', 'contain', 'fill', 'tile'] as const).map((option) => ({
              value: option,
              label: IMAGE_FILL_FIT_LABELS[option],
            }))}
            onChange={applyFit}
            fullWidth
            size="sm"
            aria-label="Image fit"
          />
          {fit === 'custom' && (
            <p className={styles.refusalText}>
              Custom size and repeat — set below. Picking a fit above replaces both.
            </p>
          )}
        </>
      )}

      {positionView.kind !== 'raw' && (
        <ImageFillPositionGrid
          value={positionView.kind === 'value' ? positionView.value : ''}
          onChange={(next) =>
            onModelChange(setBackgroundLayerSatellite(model, 'backgroundPosition', index, next))
          }
        />
      )}
    </div>
  )
}

/**
 * `background-position`'s nine keyword pairs as Figma's 3×3 puck. Selection
 * is EXACT — `positionCellFor` returns nothing for a value the grid cannot
 * express, and no cell lights up, so the grid never implies it is showing a
 * position it would actually write.
 */
function ImageFillPositionGrid({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const selected = positionCellFor(value)
  return (
    <div className={styles.positionGroup}>
      <p className={styles.sizingHeading}>Position</p>
      <div className={styles.positionGrid} role="group" aria-label="Background position">
        {IMAGE_FILL_POSITION_CELLS.map((cell) => (
          <Button
            key={cell.value}
            variant="ghost"
            size="micro"
            iconOnly
            pressed={selected === cell.value}
            aria-label={cell.label}
            tooltip={cell.label}
            onClick={() => onChange(cell.value)}
          >
            <span className={styles.positionDot} aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  )
}
