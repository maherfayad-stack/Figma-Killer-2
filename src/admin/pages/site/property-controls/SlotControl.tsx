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
 *  - **Empty slot → "Add".** Opens a picker of the project's own components
 *    (E1's `GET /admin/api/studio/components`) and, on a pick, writes an
 *    `insert-slot` edit (E2.4, `insertJsxIntoSlotProp`) targeted at the
 *    CALL SITE (`ownerNodeId`) — never the slot's own (structurally locked)
 *    node id, per E2.4's own "wall #3" note. Pre-checked with
 *    `explainStructuralConstraint({kind:'insert', node: ownerNode})` so a
 *    refusal shows disabled-with-reason, never a failed click.
 *  - **Filled slot → "Edit contents"** (unchanged) navigates to the slot's
 *    own node — an ordinary, individually editable node once selected. A
 *    second "Add another" reuses the identical `insert-slot` write; the
 *    codemod itself decides whether that means wrapping the existing value
 *    in a fragment or appending to one already there (`insertJsxIntoSlotProp`'s
 *    own three writable cases) — this control never re-derives that choice.
 *
 * **What this control deliberately does NOT offer: Replace / Clear.**
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
import { fetchLocalComponentCatalog } from '@site/studio/componentCatalog'
import { commitStudioInsertSlot } from '@site/studio/studioSaveRequests'
import { relativeImportSpecifier } from './relativeImportSpecifier'
import type { LocalComponentSpec } from './componentPropKind'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { ControlRow } from '@ui/components/ControlRow'
import { pushToast } from '@ui/components/Toast'
import { CursorClickSolidIcon } from 'pixel-art-icons/icons/cursor-click-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import styles from './controls.module.css'

export function SlotControl({ propKey, value, label, isOverride, layout, disabled, ownerNodeId }: ControlProps<unknown>) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<LocalComponentSpec[] | null>(null)
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

  async function openPicker() {
    setPickerOpen(true)
    setQuery('')
    if (!catalog) {
      const list = await fetchLocalComponentCatalog()
      setCatalog(list)
    }
  }

  async function handlePick(candidate: LocalComponentSpec) {
    if (!ownerNodeId) return
    const ownerLoc = decodeSourceNodeId(ownerNodeId)
    if (!ownerLoc) {
      pushToast({ kind: 'error', title: 'Add failed', body: 'This component instance has no writable source location.' })
      return
    }
    setSubmittingName(candidate.name)
    try {
      const importSpecifier = relativeImportSpecifier(ownerLoc.rel, candidate.file)
      const result = await commitStudioInsertSlot({
        nodeId: ownerNodeId,
        propName: propKey,
        name: candidate.name,
        importSpecifier,
      })
      if (!result.ok) {
        pushToast({ kind: 'error', title: 'Add refused', body: result.message })
        return
      }
      setPickerOpen(false)
    } catch (err) {
      pushToast({ kind: 'error', title: 'Add failed', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setSubmittingName(null)
    }
  }

  const filteredCandidates = (catalog ?? []).filter((c) =>
    query.trim() ? c.name.toLowerCase().includes(query.trim().toLowerCase()) : true,
  )

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
        <Button
          variant="ghost"
          size="sm"
          disabled={addDisabled}
          tooltip={insertRefusalReason ?? undefined}
          onClick={openPicker}
          data-testid={`slot-control-${propKey}-add`}
        >
          <PlusIcon size={11} aria-hidden="true" />
          {addLabel}
        </Button>
      </div>

      {pickerOpen && (
        <div className={styles.slotPicker} data-testid={`slot-control-${propKey}-picker`}>
          <SearchBar
            value={query}
            onValueChange={setQuery}
            placeholder="Search this project's components…"
            aria-label={`Search components for the ${label ?? propKey} slot`}
            autoFocus
          />
          {catalog === null ? (
            <p className={styles.slotPickerEmpty}>Loading…</p>
          ) : filteredCandidates.length === 0 ? (
            <p className={styles.slotPickerEmpty}>
              No component in this project matched — Studio only offers components it can find declared in your own files.
            </p>
          ) : (
            <ul className={styles.slotPickerList} role="listbox" aria-label={`Components for the ${label ?? propKey} slot`}>
              {filteredCandidates.map((candidate) => (
                <li key={`${candidate.file}#${candidate.exportName}`}>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={styles.slotPickerCandidate}
                    onClick={() => handlePick(candidate)}
                    disabled={submittingName !== null}
                    data-testid={`slot-control-${propKey}-candidate-${candidate.name}`}
                  >
                    {submittingName === candidate.name ? `Adding ${candidate.name}…` : candidate.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ControlRow>
  )
}
