/**
 * MultiSelectTargetBar — where a multi-selection's edits land, and what a
 * commit will NOT reach (`docs/features/inspector.md` §9.4 / §9.4a).
 *
 * Replaces `MultiSelectionStyleArea.tsx`, which owned the same two questions
 * but also owned a whole parallel editing surface below them
 * (`MultiInlineStyleComposer` / a second `StyleRuleComposer` mount). S5 made
 * that surface unnecessary: `useSelectionModel()` describes N nodes now, so
 * the ordinary `INSPECTOR_SECTIONS` render IS the multi-selection editor.
 * What survives is exactly the part that was never about rendering sections —
 * the target decision and its gate.
 *
 * Two targets:
 *
 *   - **Element** — inline. `style=""` belongs to exactly one element, so N
 *     inline writes touch exactly the N elements selected. The default, and
 *     the only option when the selection shares no class.
 *   - **Class** — the one class every selected node carries. ONE write
 *     reaching every element with that class, which is usually what
 *     "restyle these five cards" means, and is never something the user
 *     should discover afterwards.
 *
 * The gate is the honest half of the second: when the shared class also lives
 * on elements OUTSIDE the selection, switching asks first and names the count
 * (`multiSelectClassTarget.ts` owns the decision and the sentence). A
 * confirmation is remembered per class id while this surface stays mounted —
 * re-asking on every keystroke trains the user to click through, which is the
 * failure mode a gate has. Never `window.confirm`, and never a modal.
 *
 * Below the chip, the two facts a partial write must not leave silent:
 * layers whose module takes no inline style at all, and `style:<prop>`
 * properties some selected layers compute in code.
 */
import { useState } from 'react'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { isUserVisibleClass, styleRuleSelector } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { cssPropertyLabel } from '@site/panels/PropertiesPanel/cssControlTypes'
import { resolveBulkClassTarget } from '@site/panels/PropertiesPanel/multiSelectClassTarget'
import { resolveClassCssEditability } from '@site/panels/PropertiesPanel/classCssWritability'
import { StyleTargetChip } from '@site/panels/PropertiesPanel/StyleTargetChip'
import type { SelectionModel } from './selectionModel'
import { useMultiSelectTarget } from './multiSelectTarget'
import noticeStyles from '@site/panels/PropertiesPanel/SharedComponentNotice.module.css'
import styles from './MultiSelectTargetBar.module.css'

/**
 * Why Element is the only target on offer when the selection shares no class.
 * Shown in the chip's tooltips, where the user is already looking.
 */
const NO_SHARED_CLASS_REASON =
  'Bulk edits write inline styles — a class target needs one class every selected layer carries'

export function MultiSelectTargetBar({ model }: { model: SelectionModel }) {
  // The O(1) usage tally the Selectors panel reads — never a page walk.
  const classUsageById = useEditorStore((s) => s._classIdToNodeCount)
  const target = useMultiSelectTarget()
  const [gateOpen, setGateOpen] = useState(false)
  const [confirmedClassId, setConfirmedClassId] = useState<string | null>(null)

  const decision = resolveBulkClassTarget(
    model.selectedNodes,
    (classId) => {
      // Only a user-visible class rule is offerable: an ambient rule attaches
      // by CSS matching rather than by `classIds`, so "every selected node
      // carries it" is not a question its id can answer.
      const rule = model.sharedClassRules.find((candidate) => candidate.id === classId)
      return rule && isUserVisibleClass(rule) ? styleRuleSelector(rule) : null
    },
    classUsageById,
  )

  const offered = decision.kind === 'no-shared-class' ? null : decision.target
  const offeredRule = offered
    ? (model.sharedClassRules.find((rule) => rule.id === offered.classId) ?? null)
    : null
  const editingClass = target.classId !== null && offeredRule?.id === target.classId

  const handleSelectClass = () => {
    if (!offered) return
    if (decision.kind === 'needs-confirmation' && confirmedClassId !== offered.classId) {
      setGateOpen(true)
      return
    }
    setGateOpen(false)
    target.setClassId(offered.classId)
  }

  const handleConfirmGate = () => {
    if (!offered) return
    setConfirmedClassId(offered.classId)
    setGateOpen(false)
    target.setClassId(offered.classId)
  }

  return (
    <div className={styles.bar} data-testid="multi-select-target-bar">
      <StyleTargetChip
        elementVisible={!editingClass}
        onToggleElement={offered ? () => target.setClassId(null) : undefined}
        classSelector={offered?.selector}
        classCssEditability={offeredRule ? resolveClassCssEditability(offeredRule) : undefined}
        onSelectClass={offered ? handleSelectClass : undefined}
        classActive={editingClass}
        lockedToElementReason={offered ? undefined : NO_SHARED_CLASS_REASON}
      />

      {gateOpen && offered && decision.kind === 'needs-confirmation' && (
        <div
          className={styles.classGate}
          role="group"
          aria-label="Confirm class edit"
          data-testid="multi-select-class-gate"
        >
          <p className={styles.classGateText}>
            <WarningDiamondSolidIcon size={13} aria-hidden="true" className={styles.classGateIcon} />
            {decision.question}
          </p>
          <div className={styles.classGateActions}>
            <Button variant="secondary" size="xs" onClick={() => setGateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="xs"
              onClick={handleConfirmGate}
              data-testid="multi-select-class-gate-confirm"
            >
              Edit {offered.selector}
            </Button>
          </div>
        </div>
      )}

      {/* Only the Element target can partially miss — a class write is one
          write, and reaches everything carrying the class by definition. */}
      {!editingClass && <PartialWriteNotices model={model} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PartialWriteNotices — §9.4a's "the write lock carries a count, not a
// boolean", stated once above the sections.
// ---------------------------------------------------------------------------

function PartialWriteNotices({ model }: { model: SelectionModel }) {
  const { inlineUnwritableNodes, inlineWriteReach, selectedNodes } = model
  const blocked = inlineWriteReach ? [...inlineWriteReach.blockedByProperty.entries()] : []

  return (
    <>
      {inlineUnwritableNodes.length > 0 && (
        <div
          className={noticeStyles.notice}
          role="note"
          data-testid="multi-select-unwritable-modules-notice"
        >
          <LockSolidIcon size={14} className={noticeStyles.icon} />
          <p className={noticeStyles.text}>
            <strong>{inlineUnwritableNodes.map((node) => node.label ?? node.id).join(', ')}</strong>{' '}
            {inlineUnwritableNodes.length === 1 ? 'takes' : 'take'} no style of{' '}
            {inlineUnwritableNodes.length === 1 ? 'its' : 'their'} own here — the style comes from
            that component&apos;s own source, not this page&apos;s. Edits below skip{' '}
            {inlineUnwritableNodes.length === 1 ? 'it' : 'them'}; assign a CSS class or change the
            design-system token instead.
          </p>
        </div>
      )}
      {blocked.length > 0 && (
        <div
          className={noticeStyles.notice}
          role="note"
          data-testid="multi-select-locked-properties-notice"
        >
          <LockSolidIcon size={14} className={noticeStyles.icon} />
          <p className={noticeStyles.text}>
            <strong>{blocked.map(([property]) => cssPropertyLabel(property)).join(', ')}</strong>{' '}
            {blocked.length === 1 ? 'is' : 'are'} {inlineWriteReach?.reason} on{' '}
            {describeBlockedSpread(blocked, selectedNodes.length)}. Those layers keep their current
            value; the rest of the selection still updates.
          </p>
        </div>
      )}
    </>
  )
}

/**
 * "2 of these 5 layers" / "some of these 5 layers". One blocked property has
 * one honest count; several properties blocked on different subsets do not
 * share one, and inventing a union count would overstate every individual row.
 */
function describeBlockedSpread(
  blocked: ReadonlyArray<readonly [string, number]>,
  total: number,
): string {
  const layers = total === 1 ? 'layer' : 'layers'
  if (blocked.length !== 1) return `some of these ${total} ${layers}`
  return `${blocked[0][1]} of these ${total} ${layers}`
}
