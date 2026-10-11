/**
 * VariantStyleEntry — the way from a selected INSTANCE in "Main component" mode
 * to editing the style of the variant it shows (CV-4).
 *
 * A click anywhere inside an instance selects the instance, which owns no
 * element and no style of its own, so the style sections have nothing to edit
 * there. The element that carries the variant (a Button component's root element)
 * is inside it. This row says which rule a style edit will land in ("Style edits go to
 * .btn-ghost in Button.css") and one press opens the instance and selects that
 * element, where the variant edit context (`variantEditContext.ts`) takes over:
 * the inspector's chip repeats the rule and every style control writes to it.
 *
 * When the variant has no honest rule (computed code, utility classes, a missing
 * rule) the row is the refusal instead: it names the variant, the line and the
 * remedy, and there is no button, because an edit could land nowhere true.
 * Renders nothing when no variant prop styles an element of the component.
 */
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { jumpToSource } from '@site/panels/PropertiesPanel/jumpToSource'
import { Button } from '@ui/components/Button'
import { resolveVariantEditContext, variantElementIdOf, type CallSiteInstance } from '../variantEditContext'
import styles from './ComponentProperties.module.css'

interface VariantStyleEntryProps {
  instanceId: string
  callSite: CallSiteInstance
  spec: LocalComponentSpec
}

export function VariantStyleEntry({ instanceId, callSite, spec }: VariantStyleEntryProps) {
  const elementId = useEditorStore((s) => variantElementIdOf(selectActiveCanvasPage(s)?.nodes, instanceId, spec))
  const chosenAxis = useEditorStore((s) => s.variantEditAxis)
  const setMainEditComponent = useEditorStore((s) => s.setMainEditComponent)
  const enterInstance = useEditorStore((s) => s.enterInstance)
  const selectNode = useEditorStore((s) => s.selectNode)
  if (elementId === null) return null
  const context = resolveVariantEditContext({ nodeId: elementId, callSite, catalog: [spec], chosenAxis })
  if (context === null) return null
  const chosen = context.chosen

  function editStyle() {
    // The all-instances mode (OD-19) is what makes an element of a component the main component's.
    setMainEditComponent(callSite.componentName)
    enterInstance(instanceId)
    selectNode(elementId)
  }

  return (
    <div className={styles.notice} role="status" data-testid="variant-style-entry">
      {chosen.kind === 'rule' ? (
        <>
          <p className={styles.noticeText} data-testid="variant-style-entry-text">
            Style edits go to {chosen.selector} in {chosen.file.split('/').pop()}.
          </p>
          <Button variant="secondary" size="xs" onClick={editStyle} data-testid="variant-style-entry-edit">
            Edit style
          </Button>
        </>
      ) : (
        <>
          <p className={styles.noticeText} data-testid="variant-style-entry-refusal">
            {chosen.message} {chosen.remedy}
          </p>
          {chosen.openAt !== undefined && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => jumpToSource({ rel: chosen.openAt!.file, line: chosen.openAt!.line, col: 1 })}
              data-testid="variant-style-entry-open-code"
            >
              Open in code
            </Button>
          )}
        </>
      )}
    </div>
  )
}
