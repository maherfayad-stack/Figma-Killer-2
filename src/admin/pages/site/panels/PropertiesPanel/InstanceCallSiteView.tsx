/**
 * InstanceCallSiteView — PropertiesPanel view for a selected `studio.instance`
 * node (WS-4.2/4.3, `parser-05`). instance-ui-01: this is the CONSUMER of
 * that work order's engine layer — the call-site prop surface, and the
 * Detach/Swap actions, had no UI at all before this file.
 *
 * Header: component glyph + name + source badge + Detach/Swap actions.
 * Body: one control per `props.callSiteProps` entry — a prop holding a
 * literal is writable via `updateInstanceCallSiteProp` (→ `setJsxProp` on
 * save); one that resolved from an expression is `codeProps`-locked and
 * renders read-only, exactly like every other Studio prop control
 * (`propLockReason` — imported, not re-derived).
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
 * commit.
 *
 * Honest gap, stated plainly: the Swap picker's candidate list is LOCAL
 * components already instantiated elsewhere on the currently-loaded board
 * (deduped by `{sourceFile, componentName}`) — not a full project-wide
 * component catalog, and not package components. Building a "list every
 * component in this project" server endpoint is real, separate scope this
 * pass didn't reach; see this file's STATE.md handoff.
 */
import { useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { PageNode } from '@core/page-tree'
import type { PropertyControl } from '@core/module-engine'
import { studioSlotNodeId } from '@core/utils/studioSlotSentinel'
import { PropertyControlRenderer } from '@site/property-controls/PropertyControlRenderer'
import { propLockReason } from './propLockReason'
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
 * A `studio.instance`'s call-site props have no per-field `PropKind`
 * classification (parser-05's honest gap #4 — deliberately scoped out to
 * avoid duplicating `pkg-02`'s concurrent PACKAGE-component PropKind work).
 * This infers a reasonable control from the VALUE'S OWN runtime type
 * instead of a declared signature — a real, working, but coarser rule than
 * WS-3.1's classification. `PropertyControlRenderer`'s own structured-value
 * guard (object/array → `CodeValueControl`, checked before this control type
 * is ever consulted) is what keeps a `{ actions: [...] }`-shaped call-site
 * prop safely read-only regardless of what this function returns for it.
 */
function controlForCallSiteValue(value: unknown, label: string): PropertyControl {
  if (studioSlotNodeId(value) !== undefined) return { type: 'slot', label }
  if (typeof value === 'boolean') return { type: 'toggle', label }
  if (typeof value === 'number') return { type: 'number', label }
  return { type: 'text', label }
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
  const callSiteKeys = Object.keys(callSiteProps)

  const updateCallSiteProp = useEditorStore((s) => s.updateInstanceCallSiteProp)

  const [detaching, setDetaching] = useState(false)
  const [refusal, setRefusal] = useState<{ reason: string; message: string } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const [swapQuery, setSwapQuery] = useState('')
  const [swapCandidates, setSwapCandidates] = useState<LocalSwapCandidate[]>([])
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

  // instance-ui-01 — a ONE-TIME imperative scan on a user click (opening the
  // picker), not a reactive `useEditorStore(selector)` — the picker's own
  // interaction, not a value the panel re-renders on every store tick.
  // Deliberately outside `no-full-site-scan-in-selectors.test.ts`'s concern
  // for the same reason `pkg-02`'s `siteHasUnregisteredPackageNode` is
  // allowlisted there: an imperative read triggered by one click, never a
  // selector callback.
  function openSwapPicker() {
    const state = useEditorStore.getState()
    const seen = new Map<string, LocalSwapCandidate>()
    for (const page of state.site?.pages ?? []) {
      for (const candidate of Object.values(page.nodes)) {
        if (candidate.moduleId !== 'studio.instance') continue
        const p = candidate.props as InstanceProps
        if (p.source !== 'local' || !p.componentName || !p.sourceFile) continue
        if (p.componentName === componentName && p.sourceFile === sourceFile) continue
        seen.set(`${p.sourceFile}#${p.componentName}`, { componentName: p.componentName, sourceFile: p.sourceFile })
      }
    }
    setSwapCandidates([...seen.values()])
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

      {/* ── Swap picker — searchable, local components already on the board ── */}
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
              No other local component is on this board yet — swap targets come from components already used elsewhere.
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

      {/* ── Call-site props ──────────────────────────────────────────────── */}
      {callSiteKeys.length === 0 ? (
        <div className={styles.noParams}>This component takes no props at this call site.</div>
      ) : (
        <div className={styles.propsList} role="list" aria-label="Call-site props">
          {callSiteKeys.map((key) => {
            const value = callSiteProps[key]
            const control = controlForCallSiteValue(value, key)
            const isSlot = control.type === 'slot'
            // A slot value is a navigation affordance ("Edit contents"), not
            // an editable scalar — always available, same as `pkg-02`'s
            // unconditional `node`-kind handling for package components.
            const lockReason = isSlot ? undefined : propLockReason(node, `callSiteProps:${key}`)
            return (
              <div key={key} role="listitem" data-testid={`instance-call-site-prop-${key}`}>
                <PropertyControlRenderer
                  propKey={key}
                  control={control}
                  value={value}
                  onChange={(propKey, next) => updateCallSiteProp(nodeId, propKey, next)}
                  sourceLockReason={lockReason}
                />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
