/**
 * SlotControl — the affordance for a `node`-kind prop (WS-3.4/E2.3's
 * captured slot children, e.g. `<Cell icon={<Icon/>}/>`, or a fragment slot,
 * `header={<><Back/><Title/></>}`).
 *
 * A `node`-kind prop's value on the wire is either `undefined` (the
 * component DECLARES this slot but the call site doesn't pass it — E1's
 * catalog is what tells the panel the slot exists at all; there is no node
 * to point at) or a `studio-slot:<nodeId>` sentinel (`studioSlotNodeId`,
 * `@core/utils/studioSlotSentinel`) naming a REAL node materialized
 * elsewhere in the flat page tree.
 *
 * Two affordances, both real writes, neither a guess:
 *
 *  - **Empty slot → "Add".** Opens `SlotPicker` — the project's own
 *    components, the design system's icon components, its shipped icon FILES,
 *    and an SVG the user uploads — and, on a pick, writes an `insert-slot`
 *    edit (E2.4, `insertJsxIntoSlotProp`) targeted at the CALL SITE
 *    (`ownerNodeId`) — never the slot's own (structurally locked) node id,
 *    per E2.4's own "wall #3" note. Pre-checked with
 *    `explainStructuralConstraint({kind:'insert', node: ownerNode})` so a
 *    refusal shows disabled-with-reason, never a failed click.
 *
 *    Every source arrives here as one `SlotJsxNode` (see `SlotPicker`), so
 *    this control has a single commit path rather than one per source.
 *  - **Filled slot → "Edit contents"** navigates to the slot's own node — an
 *    ordinary, individually editable node once selected.
 *  - **Filled slot → "Replace"** opens the same picker and issues the same
 *    `insert-slot` write with `mode: 'replace'`, which overwrites the slot's
 *    JSX value instead of adding to it. Without it, picking a second icon
 *    left the first sitting beside it in a fragment and the component
 *    rendered both — "choose a different icon" was not expressible at all.
 *  - **Filled slot → "Add another"** reuses the identical write in append
 *    mode; the codemod itself decides whether that means wrapping the existing
 *    value in a fragment or appending to one already there
 *    (`insertJsxIntoSlotProp`'s own writable cases) — this control never
 *    re-derives that choice.
 *
 * **What this control still does NOT offer: Clear.**
 * E2.3's parser locks every slot child with `SLOT_LOCK_REASON` — a
 * STRUCTURAL lock, so `explainStructuralConstraint({kind:'delete', ...})`
 * refuses it unconditionally, for every slot shape, always. There is no
 * `insert-slot`-adjacent "clear this attribute" writeback verb either (no
 * `studioSlotWriteback.ts` kind removes/empties a slot's value). Offering a
 * Clear/Replace button that always fails the moment it is clicked would be
 * exactly the "control that lies" this panel exists to refuse — so it is
 * simply not offered, the third honest outcome alongside "writes" and
 * "refuses with a reason", until a real `clear-slot`/`remove-slot-child`
 * codemod exists to back it (a real, disclosed gap — see this file's
 * STATE.md handoff, not a silent omission).
 */
import { useState } from 'react'
import type { ControlProps } from './shared'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { useEditorStore } from '@site/store/store'
import { decodeSourceNodeId, explainStructuralConstraint } from '@core/page-tree'
import { resolveNodeById } from '@site/panels/PropertiesPanel/slotOwners'
import { commitStudioInsertSlot, type SlotJsxNode } from '@site/studio/studioSaveRequests'
import { SlotPicker } from './SlotPicker'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { pushToast } from '@ui/components/Toast'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import styles from './controls.module.css'

export function SlotControl({ propKey, value, label, isOverride, layout, disabled, ownerNodeId }: ControlProps<unknown>) {
  // Which write the open picker will issue, or `null` when it is closed —
  // one piece of state rather than an `open` flag plus a mode that can
  // disagree with it.
  const [pickerMode, setPickerMode] = useState<'append' | 'replace' | null>(null)
  const [submittingName, setSubmittingName] = useState<string | null>(null)

  const slotNodeId = studioSlotNodeId(value)

  // A plain, referentially-stable store read (Mutative preserves an
  // untouched node's own object identity) — the constraint check below runs
  // OUTSIDE this selector, in plain JS, because `explainStructuralConstraint`
  // mints a fresh object every call and a selector that returns one is the
  // exact "fresh object -> infinite render loop" trap Track F2 already hit
  // and documented (`LayerNodeContextMenu.tsx`'s own landmine note).
  const ownerNode = useEditorStore((s) =>
    ownerNodeId ? resolveNodeById(s.site, s._nodeIdToPageIds, ownerNodeId) : null,
  )

  const insertRefusalReason: string | null = !ownerNodeId
    ? 'This control has no owning node to write into.'
    : !ownerNode
      ? 'Could not locate this component’s call site — try reloading.'
      : (explainStructuralConstraint({ kind: 'insert', node: { id: ownerNode.id, lockReason: ownerNode.lockReason } })
          ?.explanation ?? null)

  async function handlePick(node: SlotJsxNode, name: string) {
    if (!ownerNodeId || !pickerMode) return
    const verb = pickerMode === 'replace' ? 'Replace' : 'Add'
    setSubmittingName(name)
    try {
      const result = await commitStudioInsertSlot({
        nodeId: ownerNodeId,
        propName: propKey,
        node,
        mode: pickerMode,
      })
      if (!result.ok) {
        pushToast({ kind: 'error', title: `${verb} refused`, body: result.message })
        return
      }
      setPickerMode(null)
    } catch (err) {
      pushToast({ kind: 'error', title: `${verb} failed`, body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setSubmittingName(null)
    }
  }

  // The call site's own file, needed to resolve a PROJECT component's import
  // relative to it. A design-system icon's specifier is bare and needs none,
  // which is why an owner with no decodable source location still gets a
  // usable icon list rather than an empty picker.
  const ownerRelPath = ownerNodeId ? (decodeSourceNodeId(ownerNodeId)?.rel ?? '') : ''

  const addLabel = slotNodeId ? 'Add another' : 'Add'
  const addDisabled = disabled || insertRefusalReason !== null

  return (
    <ControlRow propKey={propKey} label={label} layout={layout} isOverride={isOverride} disabled={disabled}>
      <div className={styles.slotControl}>
        {slotNodeId ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => useEditorStore.getState().selectNode(slotNodeId)}
            data-testid={`slot-control-${propKey}`}
          >
            <CursorClickSolidIcon size={12} aria-hidden="true" />
            Edit contents
          </Button>
        ) : (
          <span className={styles.codeValue} data-testid={`slot-control-${propKey}-empty`}>
            — <span className={styles.codeValueHint}>no content in this slot</span>
          </span>
        )}
        {slotNodeId && (
          <Button
            variant="ghost"
            size="sm"
            disabled={addDisabled}
            tooltip={insertRefusalReason ?? undefined}
            onClick={() => setPickerMode('replace')}
            data-testid={`slot-control-${propKey}-replace`}
          >
            <ReloadIcon size={11} aria-hidden="true" />
            Replace
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={addDisabled}
          tooltip={insertRefusalReason ?? undefined}
          onClick={() => setPickerMode('append')}
          data-testid={`slot-control-${propKey}-add`}
        >
          <PlusIcon size={11} aria-hidden="true" />
          {addLabel}
        </Button>
      </div>

      {pickerMode !== null && (
        <SlotPicker
          propKey={propKey}
          label={label ?? propKey}
          ownerRelPath={ownerRelPath}
          submittingName={submittingName}
          mode={pickerMode}
          onPick={(node, name) => void handlePick(node, name)}
        />
      )}
    </ControlRow>
  )
}
