/**
 * SingleNodeAlignRow — mounts `AlignBar` for the currently selected node,
 * resolving each of the 6 align edges against its REAL parent (a live
 * `getComputedStyle` read — never a guess, see `resolveAlignWrite`).
 *
 * Extracted out of `PositionSection.tsx` to keep that file under the repo's
 * module-size ceiling (`module-size-budgets.test.ts`) — same ownership,
 * just its own file.
 */
import type { CSSPropertyBag } from '@core/page-tree'
import { getParent } from '@core/page-tree'
import { AlignBar, type AlignEdge } from '@ui/components/AlignBar'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useFrameComputedStyleValues } from '@site/panels/InspectPanel/useInspectComputedStyle'
import { ALL_ALIGN_EDGES, resolveAlignWrite, type ParentLayoutInfo } from './resolveAlignWrite'
import posStyles from './PositionSection.module.css'

interface SingleNodeAlignRowProps {
  /** The SAME per-property commit the rest of PositionSection writes through
   *  — whichever bag is active (a class, via `StyleRuleComposer`, or a
   *  node's inline styles, via `InlineStyleComposer`). Used for the `self`
   *  resolution (`alignSelf`/`justifySelf`) so align never opens a second,
   *  competing write path for the currently edited node's own properties. */
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function SingleNodeAlignRow({ onChange }: SingleNodeAlignRowProps) {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const page = useEditorStore(selectActiveCanvasPage)
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)

  const parentNode = selectedNodeId && page ? getParent(page, selectedNodeId) : undefined
  const parentComputed = useFrameComputedStyleValues(parentNode?.id ?? null, activeBreakpointId, [
    'display',
    'flexDirection',
  ])

  const parentLayout: ParentLayoutInfo | null =
    parentNode && parentComputed
      ? {
          display: parentComputed.display,
          flexDirection: parentComputed.flexDirection || 'row',
          siblingCount: parentNode.children.length,
        }
      : null

  const noParentReason = !selectedNodeId
    ? 'No element selected.'
    : !parentNode
      ? 'This element has no parent to align within.'
      : "Can't read the parent's layout — no live canvas frame is rendering it yet."

  const alignDisabledReasons: Partial<Record<AlignEdge, string>> = {}
  for (const edge of ALL_ALIGN_EDGES) {
    const resolution = resolveAlignWrite(edge, parentLayout)
    if (resolution.target === 'unavailable') {
      alignDisabledReasons[edge] = parentLayout ? resolution.reason : noParentReason
    }
  }

  function handleAlign(edge: AlignEdge) {
    const resolution = resolveAlignWrite(edge, parentLayout)
    if (resolution.target === 'unavailable') return
    if (resolution.target === 'self') {
      // The node's OWN property — write it through the same bag every other
      // control in this section writes through (class or inline, whichever
      // is active), never a second, competing path.
      onChange(resolution.property, resolution.value)
      return
    }
    if (parentNode) {
      // The PARENT's property — always the parent's own inline style, never
      // one of its (possibly shared) classes. A class write here would have
      // an unbounded blast radius; the parent's inline `style=""` is a
      // single, real, per-node location no other node can be affected by.
      setNodeInlineStyles(parentNode.id, { [resolution.property]: resolution.value })
    }
  }

  return (
    <AlignBar
      className={posStyles.alignRow}
      count={1}
      minAlign={0}
      onAlign={handleAlign}
      alignDisabledReasons={alignDisabledReasons}
    />
  )
}
