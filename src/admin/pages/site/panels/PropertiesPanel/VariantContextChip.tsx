/**
 * VariantContextChip — says which rule a style edit will land in while the
 * variant edit context (CV-4) is active: "Editing variant ghost: .btn-ghost in
 * Button.module.css". Rendered ABOVE the style sections, before any write, so
 * the person knows the edit is aimed at one variant and not at the component.
 *
 * When several props style the element (`variant` and `size`) a segmented
 * control picks the axis. When the chosen axis has no honest rule (computed
 * code, utility classes, a missing rule) the chip is the refusal: it names the
 * variant, the reason and the remedy, with a way to the line, and the style
 * controls below write nowhere until the person picks another axis or fixes
 * the source. Nothing renders outside a variant edit context.
 */
import type { VariantStyleTarget } from '@core/component-variants'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import type { SelectionModel } from '@site/inspector/selectionModel'
import { jumpToSource } from './jumpToSource'
import styles from './VariantContextChip.module.css'

function axisLabel(target: VariantStyleTarget): string {
  return target.member === 'true' ? target.prop : `${target.prop} ${target.member}`
}

export function VariantContextChip({ model }: { model: SelectionModel }) {
  const setAxis = useEditorStore((s) => s.setVariantEditAxis)
  const context = model.variantContext
  if (context === null) return null
  const chosen = context.chosen

  return (
    <div className={styles.chip} data-testid="variant-context-chip" data-state={chosen.kind === 'rule' && model.variantBlocker === null ? 'rule' : 'refused'}>
      {context.axes.length > 1 && (
        <SegmentedControl<string>
          size="xs"
          fullWidth
          aria-label="Variant property to edit"
          value={chosen.prop}
          onChange={setAxis}
          options={context.axes.map((axis) => ({ value: axis.prop, label: axisLabel(axis) }))}
          data-testid="variant-context-axes"
        />
      )}
      {chosen.kind === 'rule' ? (
        <p className={styles.text} data-testid="variant-context-label">
          {model.variantBlocker ?? chosen.label}
        </p>
      ) : (
        <>
          <p className={styles.text} data-testid="variant-context-refusal">
            {chosen.message} {chosen.remedy}
          </p>
          {chosen.openAt !== undefined && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => jumpToSource({ rel: chosen.openAt!.file, line: chosen.openAt!.line, col: 1 })}
              data-testid="variant-context-open-code"
            >
              Open in code
            </Button>
          )}
        </>
      )}
    </div>
  )
}
