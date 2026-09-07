/**
 * MultiSelectionStyleArea — the style half of the multi-selection inspector:
 * the write-target chip, the class gate, and whichever composer the chosen
 * target needs (W8-3 phase 3).
 *
 * Phase 1 had exactly one target here and therefore no state: Element, pinned,
 * with a stated reason. Phase 3 adds the second, and the *choice* between them
 * is the whole component:
 *
 *   - **Element** — `MultiInlineStyleComposer`. N inline writes touching
 *     exactly the N selected elements, in one undo step.
 *   - **Class** — `StyleRuleComposer` on the one class every selected node
 *     carries. ONE write, reaching every element that carries the class,
 *     which is usually what the user wants and is never something they should
 *     discover afterwards.
 *
 * The gate is the honest half of the second bullet: when the shared class also
 * lives on elements OUTSIDE the selection, switching to it asks first, naming
 * the count (`multiSelectClassTarget.ts` owns the decision and the sentence).
 * A confirmation is remembered per class id for as long as this surface stays
 * mounted with that class shared — asking again on every keystroke would
 * train the user to click through it, which is the failure mode a gate has.
 *
 * No `window.confirm`: native dialogs are banned repo-wide
 * (`no-native-browser-dialogs.test.ts`), and a modal would also be wrong here
 * — the question is about the surface the user is already looking at.
 */

import { useState } from 'react'
import { isStudioPageRootId, isUserVisibleClass, styleRuleSelector } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { classCssWriteLockReason, resolveClassCssEditability } from './classCssWritability'
import { MultiInlineStyleComposer } from './MultiInlineStyleComposer'
import { resolveBulkClassTarget } from './multiSelectClassTarget'
import { resolveSelectedNodes } from './multiSelectNodes'
import { TokenCatalogProvider } from '@site/property-controls/TokenCatalogProvider'
import { StyleRuleComposer } from './StyleRuleComposer'
import { SelectionColorsSection } from './SelectionColorsSection'
import { StyleTargetChip } from './StyleTargetChip'
import { blockedStyleWriteLock, StyleWriteLockContext } from './StyleWriteLockContext'
import styles from './MultiSelectionInspector.module.css'

/**
 * Why the Element target is the only one on offer when the selection shares
 * no class. Shown in the chip's tooltips so the constraint is stated where the
 * user is already looking — see `MultiInlineStyleComposer`'s module doc.
 */
const NO_SHARED_CLASS_REASON =
  'Bulk edits write inline styles — a class target needs one class every selected layer carries'

interface MultiSelectionStyleAreaProps {
  /** Ordered selection set (anchor last). Must contain 2+ ids. */
  selectedNodeIds: string[]
}

export function MultiSelectionStyleArea({ selectedNodeIds }: MultiSelectionStyleAreaProps) {
  const activeTree = useEditorStore(selectActiveCanvasPage)
  const site = useEditorStore((s) => s.site)
  const nodeIdToPageIds = useEditorStore((s) => s._nodeIdToPageIds)
  // The O(1) usage tally the Selectors panel reads — never a page walk.
  const classUsageById = useEditorStore((s) => s._classIdToNodeCount)
  const studioSession = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page != null && isStudioPageRootId(page.rootNodeId)
  })

  const [classTargetActive, setClassTargetActive] = useState(false)
  const [gateOpen, setGateOpen] = useState(false)
  const [confirmedClassId, setConfirmedClassId] = useState<string | null>(null)

  const styleRules = site?.styleRules
  const nodes = resolveSelectedNodes(selectedNodeIds, { activeTree, site, nodeIdToPageIds })

  const decision = resolveBulkClassTarget(
    nodes,
    (classId) => {
      const rule: StyleRule | undefined = styleRules?.[classId]
      // Only a user-visible class rule is offerable: an ambient rule attaches
      // by CSS matching rather than by `classIds`, so "every selected node
      // carries it" is not a question its id can answer.
      return rule && isUserVisibleClass(rule) ? styleRuleSelector(rule) : null
    },
    classUsageById,
  )

  const target = decision.kind === 'no-shared-class' ? null : decision.target
  const targetRule = target ? styleRules?.[target.classId] : undefined
  // A target the selection stopped sharing (a layer added / a class removed)
  // silently falls back to Element rather than editing a class the user can
  // no longer see named in the chip.
  const editingClass = classTargetActive && target != null && targetRule != null

  const classCssEditability = targetRule ? resolveClassCssEditability(targetRule) : undefined
  const classWriteLockReason = classCssWriteLockReason(classCssEditability, { studioSession })

  const handleSelectClass = () => {
    if (!target) return
    if (decision.kind === 'needs-confirmation' && confirmedClassId !== target.classId) {
      setGateOpen(true)
      return
    }
    setGateOpen(false)
    setClassTargetActive(true)
  }

  const handleConfirmGate = () => {
    if (!target) return
    setConfirmedClassId(target.classId)
    setGateOpen(false)
    setClassTargetActive(true)
  }

  return (
    <div className={styles.styleArea} data-testid="multi-select-style-area">
      <StyleTargetChip
        elementVisible={!editingClass}
        onToggleElement={target ? () => setClassTargetActive(false) : undefined}
        classSelector={target?.selector}
        classCssEditability={classCssEditability}
        onSelectClass={target ? handleSelectClass : undefined}
        classActive={editingClass}
        lockedToElementReason={target ? undefined : NO_SHARED_CLASS_REASON}
      />

      {gateOpen && target && decision.kind === 'needs-confirmation' && (
        <div className={styles.classGate} role="group" aria-label="Confirm class edit" data-testid="multi-select-class-gate">
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
              Edit {target.selector}
            </Button>
          </div>
        </div>
      )}

      {editingClass && targetRule ? (
        // The class block carries the same pre-flight lock the single-node
        // surface provides around `StyleRuleComposer` — mounting the composer
        // without it would leave a compiled class fully editable here.
        <TokenCatalogProvider>
          <StyleWriteLockContext.Provider value={blockedStyleWriteLock(classWriteLockReason)}>
            <StyleRuleComposer classId={target.classId} cls={targetRule} styleQuery="" />
          </StyleWriteLockContext.Provider>
        </TokenCatalogProvider>
      ) : (
        <>
          <MultiInlineStyleComposer nodeIds={selectedNodeIds} styleQuery="" />
          {/* Element target only: a swatch here rewrites INLINE declarations,
              and the class target's colours belong to the class, not to this
              selection. See `selectionColors.ts`. */}
          <SelectionColorsSection nodes={nodes} />
        </>
      )}
    </div>
  )
}
