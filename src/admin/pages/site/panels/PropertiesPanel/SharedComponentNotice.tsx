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
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { useEditorStore } from '@site/store/store'
import { decodeSourceNodeId, isInlinedNodeId } from '@core/page-tree'
import { inlineTailKey } from '@site/store/slices/site/nodeIndex'
import styles from './SharedComponentNotice.module.css'

interface SharedComponentNoticeProps {
  /** The component this element was inlined out of, e.g. `'SheetHeader'`. */
  componentName: string
  /** The selected node's id — used to count how many instances share its source line. */
  nodeId: string
  /**
   * P3-C (WB-6) — where this node's TEXT is written, when that is not the
   * component's file: `<Header title="Where to?"/>` hands its `<h2>{title}</h2>`
   * the call site's literal, so a text edit changes this instance alone (or a
   * dictionary entry). Everything else on the element still writes the
   * component, which is what the rest of the sentence says.
   */
  textOrigin?: { rel: string; line: number }
}

export function SharedComponentNotice({ componentName, nodeId, textOrigin }: SharedComponentNoticeProps) {
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

  const componentFile = decodeSourceNodeId(nodeId)?.rel
  const textElsewhere = textOrigin !== undefined && textOrigin.rel !== componentFile ? textOrigin : undefined

  return (
    <div className={styles.notice} role="note">
      <WarningDiamondSolidIcon size={14} className={styles.icon} />
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
    </div>
  )
}
