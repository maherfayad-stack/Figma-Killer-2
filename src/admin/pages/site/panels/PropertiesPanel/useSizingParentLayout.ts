/**
 * useSizingParentLayout — resolves the selected node's REAL parent layout for
 * `SizeSection`'s Fixed / Hug / Fill model (W8-4).
 *
 * Hug and Fill are only honest once you know how the parent lays the element
 * out (`elementSizing.ts`'s module doc explains why `100%` overflows a gapped
 * flex row). This hook is where that fact comes from, and it comes from the
 * same place `SingleNodeAlignRow` gets it: a live `getComputedStyle` read of
 * the parent's rendered element inside a canvas frame — never the parent's
 * stored declarations, which say nothing about what a class, the cascade, or
 * a media query actually resolved `display` to.
 *
 * ## Subscription cost
 *
 * Three narrow store reads, all primitives or stored references — no derived
 * object is built inside a selector, so nothing here can churn Zustand's
 * equality check (the defect class `no-full-site-scan-in-selectors.test.ts`
 * and `per-node-selector-budget.test.ts` exist for). `getParent` is an O(1)
 * `parentId` lookup, not a tree walk.
 *
 * The returned object IS derived, and it is memoised — but by the React
 * Compiler, not by hand (repo rule: no `useMemo`). That works here precisely
 * because every input is already reference-stable across renders that didn't
 * change anything: `selectedNodeId` / `activeBreakpointId` are strings, the
 * page is a stored reference, and `useFrameComputedStyleValues` runs its
 * result through the shallow-equality stabiliser documented in
 * `useInspectComputedStyle.ts` — so a keystroke that leaves the parent's
 * `display` and `flex-direction` untouched hands back the SAME record, the
 * compiler's memo hits, and `SizeSection` sees an unchanged `parentLayout`.
 * Feeding it a freshly-built record every render would silently defeat that.
 */
import { getParent } from '@core/page-tree'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import type { SizingParentLayout } from './elementSizing'

export interface SizingParentResolution {
  /** The parent's computed layout, or `null` when it can't be read. */
  layout: SizingParentLayout | null
  /** Set exactly when `layout` is `null` — the named reason Hug/Fill are off. */
  reason?: string
}

/** The two computed properties that decide an axis's role. */
const PARENT_LAYOUT_PROPERTIES = ['display', 'flexDirection'] as const

export function useSizingParentLayout(): SizingParentResolution {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const page = useEditorStore(selectActiveCanvasPage)

  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined
  const parentComputed = useFrameComputedStyleValues(
    parentNode?.id ?? null,
    activeBreakpointId,
    PARENT_LAYOUT_PROPERTIES,
  )

  if (parentNode && parentComputed) {
    return {
      layout: {
        display: parentComputed.display,
        flexDirection: parentComputed.flexDirection || 'row',
      },
    }
  }

  if (!selectedNodeId) return { layout: null, reason: 'No element is selected.' }
  if (!parentNode) {
    return {
      layout: null,
      // The common cause in Studio: the selection is a component's ROOT
      // element, whose real parent is a JSX call site in a different file
      // that this page tree does not contain. Hug/Fill would have to guess
      // which container it lands in, so they stay off.
      reason:
        "This element's parent lives outside this file, so how it gets laid out isn't knowable here.",
    }
  }
  return {
    layout: null,
    reason: "Can't read the parent's layout — no live canvas frame is rendering it yet.",
  }
}
