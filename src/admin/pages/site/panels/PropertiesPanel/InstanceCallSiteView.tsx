/**
 * InstanceCallSiteView — PropertiesPanel's unified "Component" section for a
 * selected `studio.instance` node (WS-4.2/4.3, `parser-05`; row set rebuilt
 * by E2.5 on top of Track E1's catalog).
 *
 * Header: component glyph + name + source badge + Detach/Swap actions.
 * Body: one control per prop the component's own source DECLARES (E1's
 * `GET /admin/api/studio/components`), not per prop the call site happens
 * to pass — `buildComponentCallSiteRows` (own module, unit-tested without
 * rendering) is the row-set contract. A prop the call site doesn't set
 * still gets a row (writable, via `setJsxProp` adding a brand-new
 * attribute); a prop the parser resolved from an expression is
 * `codeProps`-locked and renders read-only, exactly like every other
 * Studio prop control (`propLockReason` — imported, not re-derived).
 *
 * **This is the "one Component section" E2.5 asks for.** Before this pass,
 * a `pkg.*`/`alm.*` design-system component already got a full declared-type
 * row set (`registerProjectModules.ts`'s schema, built from the SAME
 * `PropKind` shape) while a LOCAL component call site got a guessed,
 * call-site-only row set (`controlForCallSiteValue`, deleted) — two
 * different experiences for the same concept, "a component instance has
 * props". Both paths now go through `controlForPropKind`
 * (`componentPropKind.ts`) — the identical mapping, so a `variant?:
 * ButtonVariant` union renders a dropdown whether the component lives in
 * this project or an installed package.
 *
 * Editing a call-site prop here is INSTANCE-LOCAL (it writes the ONE call
 * site this node's own id decodes to), so `SharedComponentNotice` — which
 * states shared-source blast radius — does NOT apply to this view. It DOES
 * apply to a node reached by entering the instance (an INNER node, whose
 * edits land on the shared component's own file) — that is unaffected by
 * this file and unchanged.
 *
 * Detach/swap/extract dispatch through `fsCodemodAdapter.ts`'s standalone
 * `detachInstance`/`swapInstance`/`extractInstanceCopy` — direct, one-shot
 * HTTP calls (not the diffed `saveSite` batch), same posture
 * `saveStudioAssetEdit` already established for a discrete, deliberate
 * commit. The Swap picker's candidates now come from E1's project-wide
 * catalog (previously only components already instantiated on the LOADED
 * BOARD) — still local-only (package components aren't in this catalog),
 * disclosed below rather than silently narrowed.
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { PageNode } from '@core/page-tree'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { propLockReason } from './propLockReason'
import { buildComponentCallSiteRows } from './componentCallSiteRows'
import { useLocalComponentCatalog, findLocalComponentSpec } from '@site/studio/componentCatalog'
import { detachInstance, extractInstanceCopy, swapInstance } from '@site/studio/studioSaveRequests'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { pushToast } from '@ui/components/Toast'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { ArrowsHorizontalIcon } from 'pixel-art-icons/icons/arrows-horizontal'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import styles from './InstanceCallSiteView.module.css'

interface InstanceCallSiteViewProps {
  nodeId: string
  node: PageNode
}

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

/**
 * Detach refusal reasons where "duplicate the component and edit the copy"
 * is a genuine way forward (the component itself can't be safely inlined
 * anywhere). Excludes `not-a-component`/`unresolvable`/`package-component`
 * — extract would refuse for the identical reason, so offering it there
 * would be a dead end dressed up as a way out.
 */
const EXTRACT_OFFER_REASONS = new Set([
  'uses-hooks',
  'maps-over-props',
  'unsupported-params',
  'no-renderable-jsx',
])

export function InstanceCallSiteView({ nodeId, node }: InstanceCallSiteViewProps) {
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
  const [refusal, setRefusal] = useState<{ reason: string; message: string } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const [swapQuery, setSwapQuery] = useState('')
  const [swappingKey, setSwappingKey] = useState<string | null>(null)

  async function handleDetach() {
    setDetaching(true)
    setRefusal(null)
    try {
      const result = await detachInstance(nodeId)
      if (!result.ok) setRefusal({ reason: result.reason, message: result.message })
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

  // E2.5 — candidates now come from E1's project-wide catalog instead of a
  // board scan (the honest gap the previous version's doc comment named):
  // every OTHER local component the catalog knows about, still local-only
  // (package components aren't in this catalog — a real, disclosed
  // narrowing, not a silent one).
  const swapCandidates: LocalSwapCandidate[] = catalog
    .filter((c) => !(c.name === componentName && c.file === sourceFile))
    .map((c) => ({ componentName: c.name, sourceFile: c.file }))

  function openSwapPicker() {
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

  const filteredCandidates = swapQuery.trim()
    ? swapCandidates.filter((c) => c.componentName.toLowerCase().includes(swapQuery.trim().toLowerCase()))
    : swapCandidates

  return (
    <>
      {/* ── Header: glyph + name + source + Detach/Swap ─────────────────── */}
      <div className={styles.header}>
        <span className={styles.headerIcon} aria-hidden="true">
          <BoxStackSolidIcon size={12} color="currentColor" />
        </span>
        <span className={styles.headerName}>{componentName}</span>
        <span className={styles.sourceBadge} data-testid="instance-source-badge">
          {source === 'package' ? 'Package' : 'Local'}
        </span>
      </div>
      <div className={styles.actionsRow}>
        <Button
          variant="secondary"
          size="xs"
          onClick={handleDetach}
          disabled={detaching || source === 'package'}
          tooltip={source === 'package' ? 'Package components cannot be detached yet' : 'Inline this component\'s own JSX at this call site'}
          data-testid="instance-detach-button"
        >
          <Copy2SolidIcon size={10} color="currentColor" aria-hidden="true" />
          {detaching ? 'Detaching…' : 'Detach'}
        </Button>
        <Button
          variant="secondary"
          size="xs"
          onClick={openSwapPicker}
          data-testid="instance-swap-button"
        >
          <ArrowsHorizontalIcon size={10} color="currentColor" aria-hidden="true" />
          Swap
        </Button>
      </div>

      {/* ── Detach refusal — the reason, plus the extract offer when it applies ── */}
      {refusal && (
        <div className={styles.refusalNotice} role="alert" data-testid="instance-detach-refusal">
          <WarningDiamondSolidIcon size={13} className={styles.refusalIcon} aria-hidden="true" />
          <div className={styles.refusalBody}>
            <p className={styles.refusalText}>{refusal.message}</p>
            {EXTRACT_OFFER_REASONS.has(refusal.reason) && (
              <Button
                variant="secondary"
                size="xs"
                onClick={handleExtract}
                disabled={extracting}
                data-testid="instance-extract-offer"
              >
                {extracting ? 'Duplicating…' : `Duplicate it as a new file and edit that instead?`}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Swap picker — searchable, project-wide local components (E1) ── */}
      {swapOpen && (
        <div className={styles.swapPicker} data-testid="instance-swap-picker">
          <SearchBar
            value={swapQuery}
            onValueChange={setSwapQuery}
            placeholder="Search components…"
            aria-label="Search components to swap to"
            autoFocus
          />
          {filteredCandidates.length === 0 ? (
            <p className={styles.swapEmpty}>
              No other local component found in this project yet.
            </p>
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
      )}

      {/* ── Component props — one row per DECLARED prop (E1/E2.5) ─────────── */}
      {rows.length === 0 ? (
        <div className={styles.noParams}>This component takes no props.</div>
      ) : (
        <div className={styles.propsList} role="list" aria-label="Component props">
          {rows.map(({ key, control, value }) => {
            // A slot value is a navigation/write affordance (`SlotControl`'s
            // own "Edit contents"/"Add"), not an editable scalar — always
            // reachable, same as `pkg-02`'s unconditional `node`-kind
            // handling for package components.
            const isSlot = control.type === 'slot'
            const lockReason = isSlot ? undefined : propLockReason(node, `callSiteProps:${key}`)
            return (
              <div key={key} role="listitem" data-testid={`instance-call-site-prop-${key}`}>
                <PropertyControlRenderer
                  propKey={key}
                  control={control}
                  value={value}
                  onChange={(propKey, next) => updateCallSiteProp(nodeId, propKey, next)}
                  sourceLockReason={lockReason}
                  ownerNodeId={nodeId}
                />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
