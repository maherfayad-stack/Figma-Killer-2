/**
 * FillSectionActions — `FillSection.tsx`'s header "+" buttons, shown both in
 * the Law-1 empty state AND once the section has content (mirrors every
 * other migrated section's header actions, e.g. Layer's blend-mode
 * trigger). Split into its own file purely for `module-size-budgets.test.ts`
 * — `FillSection.tsx` decides which ROWS exist, this decides how a new one
 * gets added. `writeBackgroundModel` (the smallest-diff layer-model writer
 * both this file and `FillSection.tsx`'s own body need) lives in its own
 * sibling file, not here — a file exporting a plain function alongside a
 * component trips `react-refresh/only-export-components`.
 */
import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { Button } from '@ui/components/Button'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import {
  insertBackgroundLayer,
  parseBackgroundLayers,
  setBackgroundLayerImage,
} from '../../panels/PropertiesPanel/backgroundLayers'
import { DEFAULT_GRADIENT_FILL, DEFAULT_SOLID_FILL, DEFAULT_TEXT_FILL } from '../../panels/PropertiesPanel/fillModel'
import { extractUrlPayload, wrapUrlPayload } from '../../panels/PropertiesPanel/gradientValue'
import { ImageSourcePicker } from '../../panels/PropertiesPanel/ImageSourcePicker'
import { writeBackgroundModel } from './writeBackgroundModel'

interface FillSectionActionsProps {
  storedStyles: Record<string, unknown>
  /**
   * `panel-32`: whether Fill's own Text/Solid-fill ROW is currently visible —
   * stored here, OR muted-but-rendered (`renderedNotStored.ts`). The header's
   * "Add …" button must hide the moment a colour is plainly showing, muted or
   * not — offering "Add text colour" beside a row that already reads
   * `var(--text-base-default)` is exactly the lie this ticket closes.
   * Deliberately NOT re-derived from `storedStyles` here — the caller
   * (`FillSection.tsx`) already computed the real answer once.
   */
  textVisible: boolean
  colorVisible: boolean
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function FillSectionActions({ storedStyles, textVisible, colorVisible, onChange }: FillSectionActionsProps) {
  const model = parseBackgroundLayers(storedStyles)
  // A refused layer list has no known layer count, so there is no honest
  // index to insert at. The button stays visible and says why rather than
  // silently doing nothing.
  const layersRefused = model.spine.kind === 'raw'

  const imageButtonRef = useRef<HTMLButtonElement | null>(null)
  const [picking, setPicking] = useState(false)
  // Which layer this picker session already inserted. The URL tab commits on
  // every keystroke, so the FIRST pick inserts and every later one REPLACES —
  // otherwise typing a URL would stack one dead layer per character.
  const [pickedIndex, setPickedIndex] = useState<number | null>(null)

  function addLayer() {
    writeBackgroundModel(model, insertBackgroundLayer(model, 0, DEFAULT_GRADIENT_FILL), onChange)
  }

  function pickImage(url: string) {
    const image = url === '' ? "url('')" : wrapUrlPayload(url)
    if (pickedIndex === null) {
      writeBackgroundModel(model, insertBackgroundLayer(model, 0, image), onChange)
      setPickedIndex(0)
      return
    }
    writeBackgroundModel(model, setBackgroundLayerImage(model, pickedIndex, image), onChange)
  }

  function closePicker() {
    setPicking(false)
    setPickedIndex(null)
  }

  // The layer this session inserted, read back out of the model so the URL
  // field is a controlled input over the user's actual source, not a second
  // copy of it that could drift.
  const pickedImagePayload =
    pickedIndex !== null && model.spine.kind === 'layers'
      ? extractUrlPayload(model.spine.layers[pickedIndex] ?? '')
      : ''

  return (
    <>
      {!textVisible && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add text colour"
          tooltip="Add text colour"
          data-testid="fill-section-add-text"
          onClick={() => onChange('color', DEFAULT_TEXT_FILL)}
        >
          <TextStartTIcon size={12} aria-hidden="true" />
        </Button>
      )}
      {!colorVisible && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Add solid color fill"
          tooltip="Add solid color fill"
          data-testid="fill-section-add-color"
          onClick={() => onChange('backgroundColor', DEFAULT_SOLID_FILL)}
        >
          <PlusIcon size={12} aria-hidden="true" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Add gradient fill"
        tooltip={
          layersRefused
            ? 'This background-image is edited as raw text, so a layer cannot be added here'
            : 'Add gradient fill'
        }
        disabled={layersRefused}
        data-testid="fill-section-add-gradient"
        onClick={addLayer}
      >
        <PaintBucketSolidIcon size={12} aria-hidden="true" />
      </Button>
      <Button
        ref={imageButtonRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Add image fill"
        tooltip={
          layersRefused
            ? 'This background-image is edited as raw text, so a layer cannot be added here'
            : 'Add image fill'
        }
        disabled={layersRefused}
        pressed={picking}
        data-testid="fill-section-add-image"
        onClick={() => (picking ? closePicker() : setPicking(true))}
      >
        <Image2SolidIcon size={12} aria-hidden="true" />
      </Button>
      {picking && (
        <InspectorPopover
          id="fill-add-image"
          anchorRef={imageButtonRef}
          onClose={closePicker}
          title="Image fill"
          width={264}
        >
          <ImageSourcePicker value={pickedImagePayload} onPick={pickImage} />
        </InspectorPopover>
      )}
    </>
  )
}
