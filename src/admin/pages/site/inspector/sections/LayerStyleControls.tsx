/**
 * LayerStyleControls - the style controls of a loose layer on the free canvas.
 *
 * A loose layer is a real module (`.studio/canvas/<id>.tsx`) holding one
 * element, and its look is that element's inline `style={{}}`. The controls
 * read those values and write them back as one `style` edit per gesture
 * (`layerStyleCommit.ts`), so a rectangle drawn on the board has a fill, a
 * stroke, a radius, an opacity and a size like the same rectangle in a frame.
 *
 * Takes the root node as a prop for the reason `VectorPaintControls` does: the
 * element lives in its own `canvas:<id>` page and is never "the selected node".
 */
import { useEffect, useRef, useState } from 'react'
import type { PageNode } from '@core/page-tree'
import { ScrubInput } from '@ui/components/ScrubInput'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { createLayerStyleCommitter } from './layerStyleCommit'
import {
  lengthText,
  lengthValue,
  opacityChange,
  previousValues,
  readLayerStyle,
  strokeChange,
  styleChange,
  type LayerStyleChange,
  type LayerStyleKey,
} from './layerStyleModel'
import styles from './VectorSection.module.css'

interface LayerStyleControlsProps {
  nodeId: string
  node: PageNode
}

export function LayerStyleControls({ nodeId, node }: LayerStyleControlsProps) {
  const permissions = useEditorPermissions()
  const [committer] = useState(createLayerStyleCommitter)
  const committerRef = useRef(committer)
  // Leaving the panel (or the selection) posts whatever burst is still settling.
  useEffect(() => {
    const pending = committerRef.current
    return () => pending.flush()
  }, [])

  const reading = readLayerStyle(node)
  const readOnly = !permissions.canEditStyle
  const isText = node.moduleId === 'base.text'
  const strokeCustom = reading.stroke === 'custom'
  const stroke = reading.stroke !== null && reading.stroke !== 'custom' ? reading.stroke : null

  const write = (change: LayerStyleChange | null, label: string) => {
    if (!change || readOnly) return
    committer.push(nodeId, change, previousValues(node, change), label, 'burst')
  }
  const writeLength = (property: LayerStyleKey, typed: string, label: string) => write(styleChange(property, lengthValue(typed)), label)

  return (
    <div className={styles.root} data-testid="layer-style">
      <div className={styles.row} data-testid="layer-size-row">
        <span className={styles.rowLabel}>Size</span>
        <ScrubInput
          fieldSize="sm"
          className={styles.grow}
          label="W"
          aria-label="Layer width"
          data-testid="layer-width"
          unit=""
          min={0}
          value={lengthText(reading.width) ?? ''}
          disabled={readOnly}
          onChange={(next) => writeLength('width', next, 'Resize layer')}
        />
        <ScrubInput
          fieldSize="sm"
          className={styles.grow}
          label="H"
          aria-label="Layer height"
          data-testid="layer-height"
          unit=""
          min={0}
          value={lengthText(reading.height) ?? ''}
          disabled={readOnly}
          onChange={(next) => writeLength('height', next, 'Resize layer')}
        />
      </div>
      <div className={styles.row} data-testid="layer-fill-row">
        <span className={styles.rowLabel}>Fill</span>
        <span className={styles.colour}>
          <ColorValueInput
            value={reading.fill ?? ''}
            ariaLabel="Layer fill colour"
            swatchLabel="Pick fill colour"
            disabled={readOnly}
            onChange={(value) => write(styleChange(reading.fillKey, value.trim() === '' ? null : value.trim()), 'Fill')}
          />
        </span>
      </div>
      <div className={styles.row} data-testid="layer-stroke-row">
        <span className={styles.rowLabel}>Stroke</span>
        <span className={styles.colour}>
          <ColorValueInput
            value={stroke?.color ?? ''}
            ariaLabel="Layer stroke colour"
            swatchLabel="Pick stroke colour"
            disabled={readOnly || strokeCustom}
            onChange={(value) => write(strokeChange(value.trim() === '' ? null : { width: stroke?.width ?? '1', color: value }), 'Stroke')}
          />
        </span>
        <ScrubInput
          fieldSize="sm"
          className={styles.weight}
          label="W"
          aria-label="Layer stroke weight"
          data-testid="layer-stroke-width"
          unit=""
          min={0}
          step={0.5}
          value={stroke?.width ?? ''}
          disabled={readOnly || strokeCustom || stroke === null}
          onChange={(next) => write(stroke ? strokeChange({ width: next, color: stroke.color }) : null, 'Stroke weight')}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Radius</span>
        <ScrubInput
          fieldSize="sm"
          className={styles.grow}
          label="R"
          aria-label="Layer corner radius"
          data-testid="layer-radius"
          unit=""
          min={0}
          value={lengthText(reading.radius) ?? ''}
          disabled={readOnly}
          onChange={(next) => writeLength('borderRadius', next, 'Corner radius')}
        />
        <ScrubInput
          fieldSize="sm"
          className={styles.grow}
          label="%"
          aria-label="Layer opacity"
          data-testid="layer-opacity"
          unit=""
          min={0}
          max={100}
          value={reading.opacityPercent ?? '100'}
          disabled={readOnly}
          onChange={(next) => write(opacityChange(next), 'Opacity')}
        />
      </div>
      {isText && (
        <div className={styles.row} data-testid="layer-text-row">
          <span className={styles.rowLabel}>Text</span>
          <span className={styles.colour}>
            <ColorValueInput
              value={reading.textColor ?? ''}
              ariaLabel="Layer text colour"
              swatchLabel="Pick text colour"
              disabled={readOnly}
              onChange={(value) => write(styleChange('color', value.trim() === '' ? null : value.trim()), 'Text colour')}
            />
          </span>
          <ScrubInput
            fieldSize="sm"
            className={styles.weight}
            label="Aa"
            aria-label="Layer font size"
            data-testid="layer-font-size"
            unit=""
            min={1}
            value={lengthText(reading.fontSize) ?? ''}
            disabled={readOnly}
            onChange={(next) => writeLength('fontSize', next, 'Font size')}
          />
        </div>
      )}
      {strokeCustom && (
        <p className={styles.note} role="note" data-testid="layer-stroke-note">
          This layer has a border written in a form the stroke controls cannot restate, so they are off.
        </p>
      )}
    </div>
  )
}
