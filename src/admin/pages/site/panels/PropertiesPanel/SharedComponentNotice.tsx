/**
 * SharedComponentNotice — warns that the selected element belongs to a shared
 * component, so editing it changes every place that component is used.
 *
 * Studio expands a local component's JSX inline at each call site (§2), which
 * makes the real markup visible and editable on the canvas. But there is only
 * ONE source file behind all of those instances: an edit to this element writes
 * to `<Component>.jsx` and therefore lands on all of them at once. Measured on
 * a real imported repo, a single `Icon.jsx` line sat behind 29 board nodes.
 *
 * That blast radius is invisible from the canvas — the element looks like any
 * other — so it is stated here, next to the controls that would cause it,
 * before the user commits. `PageNode.fromComponent` carries the component name;
 * `instanceCount` is how many nodes on the board resolve to this same source
 * location.
 *
 * P5-C (DET-7) — and it offers the way to change it for ONE instance without
 * detaching: "Make the text a prop" turns the element's literal text into an
 * optional prop of the component whose default is that same text
 * (`exposeLiteralAsProp`), so every other instance renders as before, and
 * then selects this instance, whose Component section now has the prop to set.
 * Offered only for an element exactly one call site deep whose text is a
 * literal in the component's own file; the server refuses anything else by
 * name.
 */
import { useState } from 'react'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { useEditorStore } from '@site/store/store'
import { callSitePosition, decodeSourceNodeId, inlineDepth, isInlinedNodeId, type PageNode } from '@core/page-tree'
import { inlineTailKey } from '@site/store/slices/site/nodeIndex'
import { commitStudioExposeProp } from '@site/studio/studioStructuralCommits'
import { invalidateLocalComponentCatalog } from '@site/studio/componentCatalog'
import { Button } from '@ui/components/Button'
import styles from './SharedComponentNotice.module.css'

interface SharedComponentNoticeProps {
  /** The component this element was inlined out of, e.g. `'SheetHeader'`. */
  componentName: string
  /** The selected node's id — used to count how many instances share its source line. */
  nodeId: string
  /** The selected node — whether its text is a literal "Make the text a prop" can expose. */
  node: PageNode
  /**
   * P3-C (WB-6) — where this node's TEXT is written, when that is not the
   * component's file: `<Header title="Where to?"/>` hands its `<h2>{title}</h2>`
   * the call site's literal, so a text edit changes this instance alone (or a
   * dictionary entry). Everything else on the element still writes the
   * component, which is what the rest of the sentence says.
   */
  textOrigin?: { rel: string; line: number }
}

/** The prop name offered for an element's text: `heading` for a heading, else `label`. */
function suggestedPropName(node: PageNode): string {
  const tag = (node.props as { tag?: unknown }).tag
  return typeof tag === 'string' && /^h[1-6]$/.test(tag) ? 'heading' : 'label'
}

export function SharedComponentNotice({ componentName, nodeId, node, textOrigin }: SharedComponentNoticeProps) {
  // A primitive selector: no object identity to keep stable, reading the O(1)
  // `_inlineTailToCount` index (WS-5.2) instead of scanning every node of
  // every page on every store change. An inlined node's id is
  // `callSite~component:line:col` and its writeback target is that tail, so
  // two nodes with the same tail are two instances of one shared component
  // writing to the same line (`studioEditLocation`, server-side).
  const instanceCount = useEditorStore((s) => {
    if (!isInlinedNodeId(nodeId)) return 1
    const tail = inlineTailKey(nodeId)
    if (!tail) return 1
    return s._inlineTailToCount.get(tail) ?? 1
  })
  const [exposing, setExposing] = useState(false)

  const componentFile = decodeSourceNodeId(nodeId)?.rel
  const textElsewhere = textOrigin !== undefined && textOrigin.rel !== componentFile ? textOrigin : undefined
  const text = (node.props as { text?: unknown }).text
  const canExposeText =
    inlineDepth(nodeId) === 1 && typeof text === 'string' && text.trim() !== '' && !node.codeProps?.includes('text') && !textElsewhere

  async function exposeText() {
    setExposing(true)
    try {
      await commitStudioExposeProp(
        { kind: 'expose-prop', nodeId, target: { kind: 'text' }, propName: suggestedPropName(node) },
        `Make ${componentName}'s text a prop`,
        () => {
          invalidateLocalComponentCatalog()
          useEditorStore.getState().selectNode(callSitePosition(nodeId))
        },
      )
    } finally {
      setExposing(false)
    }
  }

  return (
    <div className={styles.notice} role="note">
      <WarningDiamondSolidIcon size={14} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.text}>
          Part of <strong>{componentName}</strong>. Edits are written to its source file
          {instanceCount > 1 ? <> and apply to all <strong>{instanceCount}</strong> places it&apos;s used</> : null}.
          {textElsewhere ? (
            <>
              {' '}Its text is set outside the component, so a text edit is written to{' '}
              <strong>
                {textElsewhere.rel}:{textElsewhere.line}
              </strong>{' '}
              instead.
            </>
          ) : null}
        </p>
        {canExposeText ? (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => void exposeText()}
            loading={exposing}
            tooltip={`The text becomes a prop of ${componentName} that defaults to what it says now, so every other instance stays as it is; set it on this instance in its Component section.`}
            data-testid="shared-component-expose-text"
          >
            Make the text a prop
          </Button>
        ) : null}
      </div>
    </div>
  )
}
