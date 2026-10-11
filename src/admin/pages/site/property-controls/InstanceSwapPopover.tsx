/**
 * InstanceSwapPopover — the searchable "swap this component instance for
 * another local component" picker, shared by the two places an instance can be
 * swapped: the Component section's header (a `studio.instance` node) and a
 * filled slot row (`<Cell icon={<Icon/>}/>` — the `icon` prop's content is an
 * instance too, and Figma's "instance swap" property is exactly this).
 *
 * Both dispatch the SAME one-shot `swapInstance` edit, targeted at the
 * instance's own node id: the codemod renames that one call site's tag,
 * repoints the import, and reports the props the new component dropped
 * (`swapComponentInstance`). Candidates are the project's other local
 * components (E1's catalog); package components are not in it.
 */
import { useState, type RefObject } from 'react'
import { useLocalComponentCatalog } from '@site/studio/componentCatalog'
import { swapInstance } from '@site/studio/studioSaveRequests'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from '@ui/components/InspectorPopover'
import { SearchBar } from '@ui/components/SearchBar'
import { pushToast } from '@ui/components/Toast'
import styles from './InstanceSwapPopover.module.css'

interface LocalSwapCandidate {
  componentName: string
  sourceFile: string
}

/**
 * The toast after a successful swap: what it changed about the call site's
 * props. Factored out of `handleSwap`'s try block on purpose — the React
 * Compiler bails out of a try/catch that contains a conditional VALUE
 * (a ternary, here) directly inline (`react-compiler-bailouts.test.ts`); a
 * plain function call has no such value block.
 */
function swappedToast(
  componentName: string,
  detail: { removedProps: string[]; unfilledRequiredProps: string[] } | undefined,
): Parameters<typeof pushToast>[0] {
  const notes: string[] = []
  if (detail && detail.removedProps.length > 0) notes.push(`removed: ${detail.removedProps.join(', ')}`)
  if (detail && detail.unfilledRequiredProps.length > 0) notes.push(`needs a value: ${detail.unfilledRequiredProps.join(', ')}`)
  return {
    kind: notes.length > 0 ? 'warning' : 'success',
    title: `Swapped to ${componentName}`,
    body: notes.length > 0 ? notes.join(' · ') : 'No prop changes were needed.',
  }
}

interface InstanceSwapPopoverProps {
  /** Distinguishes two popovers that can be open in one panel (the header's and a slot row's). */
  id: string
  anchorRef: RefObject<HTMLElement | null>
  /** The instance node being swapped. */
  nodeId: string
  /** The instance's current component, excluded from the candidates. */
  componentName: string
  sourceFile: string
  onClose: () => void
}

export function InstanceSwapPopover({ id, anchorRef, nodeId, componentName, sourceFile, onClose }: InstanceSwapPopoverProps) {
  const catalog = useLocalComponentCatalog()
  const [query, setQuery] = useState('')
  const [swappingKey, setSwappingKey] = useState<string | null>(null)

  // Every OTHER local component the catalog knows about.
  const candidates: LocalSwapCandidate[] = (catalog ?? [])
    .filter((c) => !(c.name === componentName && c.file === sourceFile))
    .map((c) => ({ componentName: c.name, sourceFile: c.file }))
  const needle = query.trim().toLowerCase()
  const filtered = needle ? candidates.filter((c) => c.componentName.toLowerCase().includes(needle)) : candidates

  async function handleSwap(candidate: LocalSwapCandidate) {
    const key = `${candidate.sourceFile}#${candidate.componentName}`
    setSwappingKey(key)
    // No `finally`: a try/catch/finally is a React Compiler bailout
    // (`react-compiler-bailouts.test.ts`) — `setSwappingKey(null)` runs
    // unconditionally after the try/catch instead, which needs the refusal
    // branch below to fall through (an `else`) rather than `return` early.
    try {
      const result = await swapInstance(nodeId, {
        newComponentName: candidate.componentName,
        newComponentSource: 'local',
        newComponentFile: candidate.sourceFile,
      })
      if (!result.ok) {
        pushToast({ kind: 'error', title: 'Swap refused', body: result.message })
      } else {
        pushToast(swappedToast(candidate.componentName, result.swapDetail))
        onClose()
      }
    } catch (err) {
      pushToast({ kind: 'error', title: 'Swap failed', body: getErrorMessage(err, 'Unknown error') })
    }
    setSwappingKey(null)
  }

  return (
    <InspectorPopover id={id} anchorRef={anchorRef} onClose={onClose} title="Swap instance" width={248}>
      <div className={styles.swapPicker} data-testid="instance-swap-picker">
        <SearchBar
          value={query}
          onValueChange={setQuery}
          placeholder="Search components…"
          aria-label="Search components to swap to"
          autoFocus
        />
        {filtered.length === 0 ? (
          <p className={styles.swapEmpty}>No other local component found in this project yet.</p>
        ) : (
          <ul className={styles.swapList} role="listbox" aria-label="Swap target">
            {filtered.map((candidate) => {
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
  )
}
