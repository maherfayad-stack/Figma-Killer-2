/**
 * SelectionColorsSection — the colours a multi-selection is actually made of,
 * each one recolourable everywhere it appears (W8-3 phase 3 / G6.4).
 *
 * The per-property sections answer "what is `backgroundColor` on these five
 * layers?". This answers the question a designer actually asks — "what
 * colours is this made of, and can I change that one?" — and answers it
 * across properties: the same `#111` used as text on one layer and as a
 * border on another is ONE swatch, and recolouring it rewrites both in a
 * single undo step (`setNodesInlineStylesPerNode`).
 *
 * Inline declarations only. `selectionColors.ts`'s module doc has the why:
 * an inline colour has exactly one honest write target, a class colour does
 * not, and a swatch must not quietly perform a class edit.
 */

import { useEditorStore } from '@site/store/store'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import {
  collectSelectionColors,
  describeColorUsage,
  recolorPatches,
  type SelectionColorNode,
} from './selectionColors'
import styles from './MultiSelectionInspector.module.css'

interface SelectionColorsSectionProps {
  /** The resolved selection, in selection order. */
  nodes: ReadonlyArray<SelectionColorNode>
}

export function SelectionColorsSection({ nodes }: SelectionColorsSectionProps) {
  const setNodesInlineStylesPerNode = useEditorStore((s) => s.setNodesInlineStylesPerNode)
  const colors = collectSelectionColors(nodes)
  if (colors.length === 0) return null

  return (
    <div className={styles.selectionColors} data-testid="selection-colors">
      <div className={styles.selectionColorsHeader}>Selection colors</div>
      {colors.map((color) => (
        <div key={color.value.toLowerCase()} className={styles.selectionColorRow}>
          <ColorValueInput
            value={color.value}
            ariaLabel={`Selection colour ${color.value}`}
            swatchLabel={`Selection colour ${color.value} swatch`}
            onChange={(next) => {
              if (!next || next === color.value) return
              setNodesInlineStylesPerNode(recolorPatches(color, next), {
                // Keyed on the colour being REPLACED, so a burst of edits to
                // one swatch is one undo entry and a second swatch starts its
                // own — the same rule the single-field property paths follow.
                coalesceKey: `selection-color:${color.value.toLowerCase()}`,
              })
            }}
          />
          <span className={styles.selectionColorUsage}>{describeColorUsage(color)}</span>
        </div>
      ))}
    </div>
  )
}
