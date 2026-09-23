/**
 * ComponentSection — the Properties panel's "Component" section for a
 * selected `studio.instance` node (WS-4.2/4.3, `parser-05`; row set rebuilt
 * by E2.5 on top of Track E1's catalog; one title row since P2-G).
 *
 * Its own `INSPECTOR_SECTIONS` entry, mounted directly under Measures (P2-G,
 * UX-7 — an instance's props are the most-edited thing on an instance, and
 * they used to sit below Export). It reads and writes exclusively through
 * `useSelectionModel()`, like every other migrated section, and takes no
 * props.
 *
 * ## One title row (P2-G, UX-4)
 *
 * The section used to draw THREE stacked bars: a `Section` titled
 * "Component", then a filled band repeating the component's name and source,
 * then a bordered row of Detach / Swap buttons — two titles for one thing and
 * two full-strength borders in a panel whose doctrine is "a hairline and
 * nothing else". Now it is one `SectionStaticHeader` — the same 32px recipe
 * as every section title — reading "Button · Local", with Detach and Swap as
 * icon buttons in the header's trailing slot, and the prop rows directly
 * under it. The header is static, not a disclosure: an instance's props are
 * never folded away.
 *
 * ## Hidden under multi-select (P2-G, UX-14)
 *
 * `SelectionModel.selectedNode` is the ANCHOR of a multi-selection. This
 * section used to render the anchor's call-site values as if they were the
 * selection's, and to write `updateInstanceCallSiteProp` / Detach / Swap to
 * the anchor alone — a control that lies about what it edits. It now does not
 * mount for a multi-selection at all (`showsComponentSection`, which is also
 * the manifest entry's `appliesTo`), the same refusal `StyleSurface` already
 * makes for the Module block. N-instance Mixed rows are a later feature.
 *
 * ## Rows
 *
 * One control per prop the component's own source DECLARES (E1's
 * `GET /admin/api/studio/components`), not per prop the call site happens to
 * pass — `buildComponentCallSiteRows` is the row-set contract. A prop the
 * call site doesn't set still gets a row (writable, via `setJsxProp` adding a
 * brand-new attribute); a prop the parser resolved from an expression is
 * `codeProps`-locked and renders read-only through `explainPropConstraint`,
 * the same constraint every Studio prop control uses. Both a local and a
 * package component go through `controlForPropKind`, so a `variant?:
 * ButtonVariant` union is a dropdown wherever the component lives.
 *
 * Editing a call-site prop here is INSTANCE-LOCAL (it writes the ONE call
 * site this node's own id decodes to), so `SharedComponentNotice` — which
 * states shared-source blast radius — does not apply to this view.
 *
 * ## Detach / Swap
 *
 * Both dispatch through `studioSaveRequests.ts`'s standalone
 * `detachInstance` / `swapInstance` / `extractInstanceCopy` — direct,
 * one-shot HTTP calls, not the diffed `saveSite` batch. Detach fails closed
 * (P1-E1): its refusal is shown under the title with the parser's own
 * sentence, and `explainDetachConstraint` — the one list of reasons a copy
 * of the component would fix — decides whether "duplicate it instead" is
 * offered. Swap opens a searchable popover of the project's other local
 * components (E1's catalog; package components are not in it).
 *
 * `updateInstanceCallSiteProp` is called directly from `useEditorStore`, not
 * through `useInspectorCommit`'s `commitProp`, which only routes to
 * `updateNodeProps` / `setBreakpointOverride`; a call-site prop write has
 * exactly one honest target and exactly one call site (here).
 */
import { useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  explainDetachConstraint,
  explainPropConstraint,
  type EditConstraint,
  type PageNode,
} from '@core/page-tree'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { buildComponentCallSiteRows } from '../../panels/PropertiesPanel/componentCallSiteRows'
import { useLocalComponentCatalog, findLocalComponentSpec } from '@site/studio/componentCatalog'
import { detachInstance, extractInstanceCopy, swapInstance } from '@site/studio/studioSaveRequests'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SearchBar } from '@ui/components/SearchBar'
import { SectionStaticHeader } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { ArrowsHorizontalIcon } from 'pixel-art-icons/icons/arrows-horizontal'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { useSelectionModel } from '../selectionModel'
import { showsComponentSection } from './componentSectionSelection'
import styles from './ComponentSection.module.css'

interface InstanceProps {
  componentName?: string
  source?: 'local' | 'package'
  sourceFile?: string
  callSiteProps?: Record<string, unknown>
}

interface LocalSwapCandidate {
  componentName: string
  sourceFile: string
}

export function ComponentSection() {
  const model = useSelectionModel()
  const { selectedNodeId, selectedNode } = model
  if (!selectedNodeId || !selectedNode || !showsComponentSection(model)) return null
  // Keyed by the instance: a Detach refusal, an open Swap picker or a field's
  // unsaved draft belongs to the instance it was made on, and must not carry
  // over to the next one selected.
  return <ComponentSectionBody key={selectedNodeId} nodeId={selectedNodeId} node={selectedNode} />
}

interface ComponentSectionBodyProps {
  nodeId: string
  node: PageNode
}

function ComponentSectionBody({ nodeId, node }: ComponentSectionBodyProps) {
  const instanceProps = node.props as InstanceProps
  const componentName = instanceProps.componentName ?? 'Component'
  const source = instanceProps.source ?? 'local'
  const sourceFile = instanceProps.sourceFile ?? ''
  const callSiteProps = instanceProps.callSiteProps ?? {}

  const updateCallSiteProp = useEditorStore((s) => s.updateInstanceCallSiteProp)

  // E1/E2.5 — the project-wide component catalog, fetched once (cached per
  // workspace dir) and reused for both the row set below and the Swap
  // picker's candidate list.
  const catalog = useLocalComponentCatalog()
  const spec = findLocalComponentSpec(catalog, componentName, sourceFile)
  const rows = buildComponentCallSiteRows(spec, callSiteProps)

  const [detaching, setDetaching] = useState(false)
  const [refusal, setRefusal] = useState<EditConstraint | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const [swapQuery, setSwapQuery] = useState('')
  const [swappingKey, setSwappingKey] = useState<string | null>(null)
  const swapButtonRef = useRef<HTMLButtonElement>(null)

  async function handleDetach() {
    setDetaching(true)
    setRefusal(null)
    try {
      const result = await detachInstance(nodeId)
      if (!result.ok) setRefusal(explainDetachConstraint(result.reason, result.message))
    } catch (err) {
      pushToast({ kind: 'error', title: 'Detach failed', body: getErrorMessage(err, 'Unknown detach error') })
    } finally {
      setDetaching(false)
    }
  }

  async function handleExtract() {
    setExtracting(true)
    try {
      const result = await extractInstanceCopy(nodeId)
      if (!result.ok) {
        pushToast({ kind: 'error', title: 'Duplicate failed', body: result.message })
      } else {
        setRefusal(null)
        pushToast({
          kind: 'success',
          title: 'Duplicated',
          body: `Created ${result.newComponentName ?? 'the copy'} and repointed this instance at it.`,
        })
      }
    } catch (err) {
      pushToast({ kind: 'error', title: 'Duplicate failed', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setExtracting(false)
    }
  }

  // Every OTHER local component the catalog knows about — local-only
  // (package components aren't in this catalog; the empty state says so).
  const swapCandidates: LocalSwapCandidate[] = catalog
    .filter((c) => !(c.name === componentName && c.file === sourceFile))
    .map((c) => ({ componentName: c.name, sourceFile: c.file }))

  function toggleSwapPicker() {
    if (swapOpen) {
      setSwapOpen(false)
      return
    }
    setSwapQuery('')
    setSwapOpen(true)
  }

  async function handleSwap(candidate: LocalSwapCandidate) {
    const key = `${candidate.sourceFile}#${candidate.componentName}`
    setSwappingKey(key)
    try {
      const result = await swapInstance(nodeId, {
        newComponentName: candidate.componentName,
        newComponentSource: 'local',
        newComponentFile: candidate.sourceFile,
      })
      if (!result.ok) {
        pushToast({ kind: 'error', title: 'Swap refused', body: result.message })
        return
      }
      const detail = result.swapDetail
      const notes: string[] = []
      if (detail && detail.removedProps.length > 0) notes.push(`removed: ${detail.removedProps.join(', ')}`)
      if (detail && detail.unfilledRequiredProps.length > 0) notes.push(`needs a value: ${detail.unfilledRequiredProps.join(', ')}`)
      pushToast({
        kind: notes.length > 0 ? 'warning' : 'success',
        title: `Swapped to ${candidate.componentName}`,
        body: notes.length > 0 ? notes.join(' · ') : 'No prop changes were needed.',
      })
      setSwapOpen(false)
    } catch (err) {
      pushToast({ kind: 'error', title: 'Swap failed', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setSwappingKey(null)
    }
  }

  const query = swapQuery.trim().toLowerCase()
  const filteredCandidates = query
    ? swapCandidates.filter((c) => c.componentName.toLowerCase().includes(query))
    : swapCandidates

  const extractAction = refusal?.actions.find((action) => action.kind === 'extract')

  const headerActions = (
    <>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Detach instance"
        tooltip={
          source === 'package'
            ? 'Package components cannot be detached yet'
            : 'Detach instance — inline its JSX at this call site'
        }
        onClick={handleDetach}
        disabled={source === 'package'}
        loading={detaching}
        data-testid="instance-detach-button"
      >
        <Copy2SolidIcon size={12} aria-hidden="true" />
      </Button>
      <Button
        ref={swapButtonRef}
        variant="ghost"
        size="xs"
        iconOnly
        aria-label="Swap instance"
        aria-haspopup="dialog"
        aria-expanded={swapOpen}
        tooltip="Swap instance"
        onClick={toggleSwapPicker}
        data-testid="instance-swap-button"
      >
        <ArrowsHorizontalIcon size={12} aria-hidden="true" />
      </Button>
    </>
  )

  return (
    <div className={styles.section} data-testid="instance-component-section">
      <SectionStaticHeader
        title={componentName}
        icon={BoxStackSolidIcon}
        meta={
          <span className={styles.source} data-testid="instance-source-badge">
            {source === 'package' ? 'Package' : 'Local'}
          </span>
        }
        actions={headerActions}
      />

      <div className={styles.body}>
        {/* Detach refusal — the parser's own reason, plus the duplicate offer when a copy would fix it. */}
        {refusal && (
          <div className={styles.refusalNotice} role="alert" data-testid="instance-detach-refusal">
            <WarningDiamondSolidIcon size={13} className={styles.refusalIcon} aria-hidden="true" />
            <div className={styles.refusalBody}>
              <p className={styles.refusalText}>{refusal.explanation}</p>
              {extractAction && (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={handleExtract}
                  loading={extracting}
                  data-testid="instance-extract-offer"
                >
                  {extractAction.label}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* One row per DECLARED prop (E1/E2.5). */}
        {rows.length === 0 ? (
          <p className={styles.noParams}>This component takes no props.</p>
        ) : (
          <div className={styles.propsList} role="list" aria-label="Component props">
            {rows.map(({ key, control, value }) => {
              // A slot value is a navigation/write affordance (`SlotControl`'s
              // own "Edit contents"/"Add"), not an editable scalar — always
              // reachable, same as `pkg-02`'s unconditional `node`-kind
              // handling for package components.
              const isSlot = control.type === 'slot'
              const constraint = isSlot
                ? undefined
                : (explainPropConstraint(node, `callSiteProps:${key}`, value) ?? undefined)
              return (
                <div key={key} role="listitem" data-testid={`instance-call-site-prop-${key}`}>
                  <PropertyControlRenderer
                    propKey={key}
                    control={control}
                    value={value}
                    onChange={(propKey, next) => updateCallSiteProp(nodeId, propKey, next)}
                    constraint={constraint}
                    ownerNodeId={nodeId}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {swapOpen && (
        <InspectorPopover
          id="instance-swap"
          anchorRef={swapButtonRef}
          onClose={() => setSwapOpen(false)}
          title="Swap instance"
          width={248}
        >
          <div className={styles.swapPicker} data-testid="instance-swap-picker">
            <SearchBar
              value={swapQuery}
              onValueChange={setSwapQuery}
              placeholder="Search components…"
              aria-label="Search components to swap to"
              autoFocus
            />
            {filteredCandidates.length === 0 ? (
              <p className={styles.swapEmpty}>No other local component found in this project yet.</p>
            ) : (
              <ul className={styles.swapList} role="listbox" aria-label="Swap target">
                {filteredCandidates.map((candidate) => {
                  const key = `${candidate.sourceFile}#${candidate.componentName}`
                  return (
                    <li key={key}>
                      <Button
                        variant="ghost"
                        size="xs"
                        className={styles.swapCandidate}
                        onClick={() => handleSwap(candidate)}
                        disabled={swappingKey !== null}
                        data-testid={`instance-swap-candidate-${candidate.componentName}`}
                      >
                        {swappingKey === key ? `Swapping to ${candidate.componentName}…` : candidate.componentName}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </InspectorPopover>
      )}
    </div>
  )
}
