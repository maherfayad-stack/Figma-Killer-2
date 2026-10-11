/**
 * SharedComponentNotice — says what an edit to the selected element does,
 * because the element belongs to a shared component.
 *
 * Studio expands a local component's JSX inline at each call site (§2), which
 * makes the real markup visible and editable on the canvas. But there is only
 * ONE source file behind all of those instances. Measured on a real imported
 * repo, a single `Icon.jsx` line sat behind 29 board nodes.
 *
 * OD-19 — editing a value inside a shared component changes ONLY that
 * instance. A text, attribute or inline-style value changed here is written as
 * an optional prop of the component, defaulting to what it said, with the new
 * value at this call site (`instanceOverrideActions.ts`), so this notice's
 * default state says which edits are local, how many places there are, and
 * that new styles on inner elements and structure are still shared.
 *
 * G-2b - a class edit made to the component's OUTERMOST element is this
 * instance's too: the instance takes a modifier class and a rule one class more
 * specific carries the value (`classOverride.ts`).
 *
 * The other state is the explicit one. "Edit main component" turns the
 * instance-only default off for this component (`mainEditTarget`, `mainEditMode.ts`): the same
 * controls then write the component's own markup, every instance changes, and
 * the notice becomes a banner that says so until "Done". The toast that follows
 * an instance-only edit offers "Apply to all (N)" for the one-off case.
 *
 * `PageNode.fromComponent` carries the component name; `instanceCount` is how
 * many nodes on the board resolve to this same source location.
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { useEditorStore } from '@site/store/store'
import { decodeSourceNodeId } from '@core/page-tree'
import { inlinedSourceInstanceCount } from '@site/store/slices/site/nodeIndex'
import { isEditingComponent } from '@site/store/slices/site/mainEditMode'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
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
   * dictionary entry).
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
  const instanceCount = useEditorStore((s) => inlinedSourceInstanceCount(s, nodeId))
  const editingMain = useEditorStore((s) => isEditingComponent(s.mainEditTarget, componentName))
  const setMainEditTarget = useEditorStore((s) => s.setMainEditTarget)

  const componentFile = decodeSourceNodeId(nodeId)?.rel
  const textElsewhere = textOrigin !== undefined && textOrigin.rel !== componentFile ? textOrigin : undefined
  const places = instanceCount > 1 ? <strong>{instanceCount}</strong> : null

  return (
    <div className={cn(styles.notice, !editingMain && styles.noticeInfo)} role="note">
      <WarningDiamondSolidIcon size={14} className={styles.icon} />
      <div className={styles.body}>
        {editingMain ? (
          <p className={styles.text}>
            Editing the main component <strong>{componentName}</strong>. Every change is written to its source file
            {places ? <> and applies to all {places} places it&apos;s used</> : null}.
          </p>
        ) : (
          <p className={styles.text}>
            Part of <strong>{componentName}</strong>
            {places ? <>, used in {places} places</> : null}. Text, attribute and inline-style values it already sets, and the class styles of its outermost element, change this instance only; classes of inner elements, new styles and structure change every place.
          </p>
        )}
        {!editingMain && textElsewhere ? (
          <p className={styles.text}>
            Its text is set outside the component, so a text edit is written to{' '}
            <strong>
              {textElsewhere.rel}:{textElsewhere.line}
            </strong>{' '}
            instead.
          </p>
        ) : null}
        <div className={styles.actions}>
          {editingMain ? (
            <Button variant="secondary" size="xs" onClick={() => setMainEditTarget(null)} data-testid="shared-component-done-main">
              Done
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setMainEditTarget({ kind: 'component', name: componentName })}
              tooltip={`Write ${componentName}'s own markup instead: every place it's used changes.`}
              data-testid="shared-component-edit-main"
            >
              Edit main component
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
