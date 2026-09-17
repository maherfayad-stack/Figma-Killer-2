/**
 * SelectionColorsSection — the colours a multi-selection is actually made of,
 * each one recolourable everywhere it appears (WS-14.4 / G6.4,
 * `docs/features/inspector.md` §9.4b).
 *
 * The per-property sections answer "what is `backgroundColor` on these five
 * layers?". This answers the question a designer actually asks — "what
 * colours is this made of, and can I change that one?" — and answers it
 * ACROSS properties: the same `#111` used as text on one layer and as a
 * border on another is ONE swatch reading "2 uses", and recolouring it
 * rewrites both in a single undo step (`setNodesInlineStylesPerNode`,
 * coalesced on the colour being replaced so a burst of edits to one swatch is
 * one history entry and a second swatch starts its own).
 *
 * Moved here from `panels/PropertiesPanel/` and turned into an
 * `INSPECTOR_SECTIONS` manifest entry when S5 deleted the parallel
 * multi-selection surface that used to mount it. It is the only entry in the
 * manifest with a multi-only `appliesTo`: for ONE node, Fill already says
 * everything this would. It sits directly under Fill, which is the
 * per-property answer to the same question, and wears Fill's own icon and
 * `Section` chrome so it reads as part of that group rather than as a
 * fourteenth unrelated block.
 *
 * Inline declarations only. `selectionColors.ts`'s module doc has the why: an
 * inline colour has exactly one honest write target, a class colour does not,
 * and a swatch must not quietly perform a class edit. `ColorValueInput` is
 * the same field `ColorFieldRow` (`STATE.md` `panel-33`) wraps for Fill's own
 * rows, so the swatch opens the real picker on the FIRST click here too.
 */
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { Section } from '@ui/components/Section'
import { useEditorStore } from '@site/store/store'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import {
  collectSelectionColors,
  describeColorUsage,
  recolorPatches,
} from '../../panels/PropertiesPanel/selectionColors'
import { useSelectionModel } from '../selectionModel'
import styles from './SelectionColorsSection.module.css'

export function SelectionColorsSection() {
  const model = useSelectionModel()
  const setNodesInlineStylesPerNode = useEditorStore((s) => s.setNodesInlineStylesPerNode)

  const colors = collectSelectionColors(model.selectedNodes)
  // Law 1 — nothing to disclose is a header, not an empty accordion. A
  // selection whose colours all come from classes genuinely has no inline
  // colour to offer, and saying so beats an empty list.
  if (colors.length === 0) {
    return <Section title="Selection colours" icon={PaintBucketSolidIcon} empty flush />
  }

  return (
    <Section title="Selection colours" icon={PaintBucketSolidIcon} forceOpen flush>
      <div className={styles.rows} data-testid="selection-colors">
        {colors.map((color) => (
          <div key={color.value.toLowerCase()} className={styles.row}>
            <ColorValueInput
              value={color.value}
              ariaLabel={`Selection colour ${color.value}`}
              swatchLabel={`Selection colour ${color.value} swatch`}
              onChange={(next) => {
                if (!next || next === color.value) return
                setNodesInlineStylesPerNode(recolorPatches(color, next), {
                  coalesceKey: `selection-color:${color.value.toLowerCase()}`,
                })
              }}
            />
            <span className={styles.usage}>{describeColorUsage(color)}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}
